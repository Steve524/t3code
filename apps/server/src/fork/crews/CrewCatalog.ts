/**
 * CrewCatalog - the crews installed in T3 home, as each project sees them.
 *
 * Crews load only from `<T3 home>/crews/`. A project adds to them through its
 * `.t3/` toolbox, so one crew can be `ok` in one project and `invalid` in
 * another: every result here is computed for the project asked about.
 *
 * @module CrewCatalog
 */
import { EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as RcMap from "effect/RcMap";
import * as Stream from "effect/Stream";
import { parse as parseYaml } from "yaml";

import type {
  CrewDiagnostic,
  CrewFile,
  CrewSummary,
} from "../../../../../packages/contracts/src/fork/crews/crewFile.ts";
import type { CrewRoleOverride } from "../../../../../packages/contracts/src/fork/crews/crewModel.ts";
import {
  ForkCrewsError,
  type CrewDetail,
  type CrewGetInput,
  type CrewRoleOverrideResetInput,
  type CrewRoleOverrideScope,
  type CrewRoleOverrideSetInput,
  type CrewToolboxSetModeInput,
  type CrewValidateInput,
  type ProjectToolbox,
} from "../../../../../packages/contracts/src/fork/crews/crewRpc.ts";
import type {
  CrewsToolboxFile,
  ToolboxMode,
} from "../../../../../packages/contracts/src/fork/crews/crewToolbox.ts";
import { detectCrewHome } from "../../../../../packages/shared/src/fork/crews/crewHome.ts";
import {
  parseCrewsToolboxYaml,
  parseCrewYaml,
} from "../../../../../packages/shared/src/fork/crews/parseCrewYaml.ts";
import {
  resolveRoleModel,
  resolveRoleRuntimeMode,
  type CrewUsableProvider,
} from "../../../../../packages/shared/src/fork/crews/resolveRoleModel.ts";
import {
  resolveRoleToolbox,
  type CrewToolbox,
} from "../../../../../packages/shared/src/fork/crews/resolveRoleToolbox.ts";
import { validateCrew } from "../../../../../packages/shared/src/fork/crews/validateCrew.ts";
import { validateCrewsToolbox } from "../../../../../packages/shared/src/fork/crews/validateCrewsToolbox.ts";
import * as ServerConfig from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { loadCrew, type LoadedCrew } from "./CrewFileLoader.ts";
import * as CrewSettingsStore from "./CrewSettingsStore.ts";
import {
  loadDefinitions,
  loadProjectToolbox,
  type LoadedProjectToolbox,
  type LoadedToolboxDefinitions,
} from "./CrewToolboxLoader.ts";

export class CrewCatalog extends Context.Service<
  CrewCatalog,
  {
    /** Installed crews with their status in this project. Without a project: T3 home only. */
    readonly list: (
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<CrewSummary>, ForkCrewsError>;
    /** One crew with its diagnostics and each role's resolved model, runtime mode and toolbox. */
    readonly get: (input: CrewGetInput) => Effect.Effect<CrewDetail, ForkCrewsError>;
    readonly getToolbox: (projectId: ProjectId) => Effect.Effect<ProjectToolbox, ForkCrewsError>;
    /** Changes who wins a name collision, and republishes to subscribers. */
    readonly setToolboxMode: (
      input: CrewToolboxSetModeInput,
    ) => Effect.Effect<void, ForkCrewsError>;
    /** Diagnostics for unsaved text of either file kind. Nothing is written. */
    readonly validateText: (
      input: CrewValidateInput,
    ) => Effect.Effect<ReadonlyArray<CrewDiagnostic>, ForkCrewsError>;
    /**
     * The current list, then a fresh one after each file or setting change.
     * Files are watched only while someone is subscribed.
     */
    readonly subscribe: (
      projectId?: ProjectId,
    ) => Stream.Stream<ReadonlyArray<CrewSummary>, ForkCrewsError>;
    readonly listRoleOverrides: (
      scope: CrewRoleOverrideScope,
    ) => Effect.Effect<ReadonlyArray<CrewRoleOverride>, ForkCrewsError>;
    readonly setRoleOverride: (
      input: CrewRoleOverrideSetInput,
    ) => Effect.Effect<CrewRoleOverride, ForkCrewsError>;
    readonly resetRoleOverrides: (
      input: CrewRoleOverrideResetInput,
    ) => Effect.Effect<void, ForkCrewsError>;
  }
>()("t3/fork/crews/CrewCatalog") {}

// Editors emit several events per save, and `fs.watch` can fire before the content is flushed.
const WATCH_DEBOUNCE = Duration.millis(100);

/** Direct children of a toolbox directory whose appearance or removal changes a result. */
const TOOLBOX_ENTRIES = new Set(["crews", "skills", "mcp.yaml", "tools.yaml", "crews.yaml"]);

// `capabilities` reads only the capability set and the absent thread, so one scope serves every call.
const PROVIDER_SCOPE: McpInvocationScope = {
  environmentId: EnvironmentId.make("fork-crews"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "fork-crews",
  thread: undefined,
  client: undefined,
};

/** Everything one project's view of the crews is computed from. */
interface CatalogState {
  readonly crews: ReadonlyArray<LoadedCrew>;
  readonly home: LoadedToolboxDefinitions;
  readonly project: LoadedProjectToolbox | null;
  readonly mode: ToolboxMode;
  readonly providers: ReadonlyArray<CrewUsableProvider>;
}

/** The repo grant file's decoded grants and the project-level diagnostics about it. */
function evaluateGrants(
  project: Pick<LoadedProjectToolbox, "grantsPath" | "grantsText" | "hasProjectCrewsDirectory">,
  crews: ReadonlyArray<CrewFile>,
  text = project.grantsText,
): {
  readonly grants: CrewsToolboxFile | null;
  readonly diagnostics: ReadonlyArray<CrewDiagnostic>;
} {
  const context = {
    crews,
    source: { file: project.grantsPath, ...(text === null ? {} : { text }) },
    hasProjectCrewsDirectory: project.hasProjectCrewsDirectory,
  };
  // An empty file has nothing to check, so this yields only what does not depend on its content.
  const withoutFile = () => validateCrewsToolbox({ version: 1 }, context).diagnostics;
  if (text === null) return { grants: null, diagnostics: withoutFile() };
  const parsed = parseCrewsToolboxYaml(text, project.grantsPath);
  if (parsed.value === null)
    return { grants: null, diagnostics: [...parsed.diagnostics, ...withoutFile()] };
  const validated = validateCrewsToolbox(parsed.value, context);
  return {
    grants: validated.value,
    diagnostics: [...parsed.diagnostics, ...validated.diagnostics],
  };
}

function installedCrews(crews: ReadonlyArray<LoadedCrew>) {
  return crews.flatMap((crew) => parseCrewYaml(crew.text ?? "").value ?? []);
}

function projectGrants(state: CatalogState) {
  return state.project === null
    ? null
    : evaluateGrants(state.project, installedCrews(state.crews)).grants;
}

/** One crew as one project sees it. `text` stands in for the file when validating unsaved text. */
function evaluateCrew(
  loaded: LoadedCrew,
  state: CatalogState,
  grants: CrewsToolboxFile | null,
  text = loaded.text ?? "",
) {
  const source = { file: loaded.yamlPath, text };
  const parsed = parseCrewYaml(text, loaded.yamlPath);
  const crew = parsed.value;
  const toolbox: CrewToolbox = {
    roleSkills: loaded.roleSkills,
    crewSkills: loaded.crewSkills,
    homeSkills: state.home.skills,
    homeMcp: state.home.mcp,
    repoSkills: state.project?.skills ?? [],
    repoMcp: state.project?.mcp ?? [],
    repoTools: state.project?.tools ?? [],
    grants,
    crewSource: source,
    ...(state.project === null
      ? {}
      : {
          grantsSource: {
            file: state.project.grantsPath,
            ...(state.project.grantsText === null ? {} : { text: state.project.grantsText }),
          },
        }),
  };
  // The validator decodes for itself, so it gets the raw document, not the decoded crew.
  const validation =
    crew === null
      ? null
      : validateCrew(parseYaml(text), {
          directoryName: loaded.directoryName,
          crewDirectory: loaded.directory,
          source,
          files: loaded.files,
          providerSnapshot: state.providers.map((provider) => ({
            driver: provider.driver,
            enabled: true,
            models: provider.models.map((slug) => ({ slug })),
          })),
          toolbox,
          toolboxMode: state.mode,
        });
  const diagnostics: ReadonlyArray<CrewDiagnostic> = [
    ...parsed.diagnostics,
    ...(validation === null
      ? []
      : [...validation.errors, ...validation.warnings, ...validation.info]),
  ];
  const count = (severity: CrewDiagnostic["severity"]) =>
    diagnostics.filter((diagnostic) => diagnostic.severity === severity).length;
  const errors = count("error");
  const warnings = count("warning");
  const summary: CrewSummary = {
    // The directory is the key on disk; a `crew.yaml` id that differs is reported as an error.
    id: loaded.directoryName,
    name: crew?.name ?? loaded.directoryName,
    ...(crew?.description === undefined ? {} : { description: crew.description }),
    path: loaded.directory,
    roles: Object.entries(crew?.roles ?? {}).map(([id, role]) => ({
      id,
      name: role.name,
      ...(role.description === undefined ? {} : { description: role.description }),
      tags: role.tags ?? [],
    })),
    home: crew === null ? null : detectCrewHome(crew, source).home,
    status: errors > 0 ? "invalid" : warnings > 0 ? "warnings" : "ok",
    diagnosticCounts: { errors, warnings, info: count("info") },
  };
  return { summary, crew, diagnostics, toolbox };
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const store = yield* CrewSettingsStore.CrewSettingsStore;
  const orchestratorMcp = yield* OrchestratorMcpService.OrchestratorMcpService;
  const crewsDirectory = path.join(baseDir, "crews");
  // Sliding(1) coalesces the dirty signal: every notification recomputes the whole list anyway.
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const withPlatform = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const workspaceRoot = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError((cause) => new ForkCrewsError({ reason: "unavailable", projectId, cause })),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ForkCrewsError({ reason: "project_not_found", projectId })),
          onSome: (project) => Effect.succeed(project.workspaceRoot),
        }),
      ),
    );

  // "Usable" is exactly what `orchestrator_capabilities` reports, in the model picker's order.
  const usableProviders = orchestratorMcp.capabilities(PROVIDER_SCOPE).pipe(
    Effect.map((result) =>
      result.providers
        .filter((provider) => provider.canRunChildTask)
        .map((provider): CrewUsableProvider => ({
          instanceId: provider.providerInstanceId,
          driver: provider.driverKind,
          models: provider.models.map((model) => model.id),
        })),
    ),
    Effect.mapError((cause) => new ForkCrewsError({ reason: "unavailable", cause })),
  );

  // shortcut: every call re-reads T3 home and the project toolbox, so nothing is ever stale; add an mtime-keyed cache if crews grow past a few small files.
  const load = Effect.fn("CrewCatalog.load")(function* (
    projectId: ProjectId | undefined,
  ): Effect.fn.Return<CatalogState, ForkCrewsError> {
    const names = yield* fileSystem
      .readDirectory(crewsDirectory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const loaded = yield* Effect.forEach(names.toSorted(), (name) =>
      withPlatform(loadCrew(crewsDirectory, name)),
    );
    const crews = loaded.filter((crew) => crew.text !== null);
    const home = yield* withPlatform(loadDefinitions(baseDir, { tools: false }));
    const providers = yield* usableProviders;
    if (projectId === undefined) {
      return { crews, home, project: null, mode: "extend", providers };
    }
    const project = yield* withPlatform(loadProjectToolbox(yield* workspaceRoot(projectId)));
    const mode = yield* store
      .getToolboxMode(projectId)
      .pipe(
        Effect.mapError((cause) => new ForkCrewsError({ reason: "unavailable", projectId, cause })),
      );
    return { crews, home, project, mode, providers };
  });

  const list: CrewCatalog["Service"]["list"] = (projectId) =>
    load(projectId).pipe(
      Effect.map((state) => {
        const grants = projectGrants(state);
        return state.crews.map((crew) => evaluateCrew(crew, state, grants).summary);
      }),
    );

  const overridesFor = (scope: CrewRoleOverrideScope) =>
    store
      .listRoleOverrides(scope)
      .pipe(Effect.mapError((cause) => new ForkCrewsError({ reason: "unavailable", cause })));

  const get: CrewCatalog["Service"]["get"] = Effect.fn("CrewCatalog.get")(function* (input) {
    const state = yield* load(input.projectId);
    const loaded = state.crews.find((crew) => crew.directoryName === input.crewId);
    if (loaded === undefined) {
      return yield* new ForkCrewsError({ reason: "crew_not_found", crewId: input.crewId });
    }
    const { summary, crew, diagnostics, toolbox } = evaluateCrew(
      loaded,
      state,
      projectGrants(state),
    );
    const environmentOverrides = yield* overridesFor({ scope: "environment" });
    const projectOverrides =
      input.projectId === undefined
        ? []
        : yield* overridesFor({ scope: "project", projectId: input.projectId });
    const override = (overrides: ReadonlyArray<CrewRoleOverride>, roleId: string) =>
      overrides.find((entry) => entry.crewId === input.crewId && entry.roleId === roleId);
    return {
      summary,
      definition: crew,
      diagnostics,
      roles:
        crew === null
          ? []
          : Object.keys(crew.roles).map((id) => {
              const project = override(projectOverrides, id);
              const environment = override(environmentOverrides, id);
              return {
                id,
                model: resolveRoleModel(crew, id, {
                  projectOverride: project?.modelSelection,
                  environmentOverride: environment?.modelSelection,
                  providers: state.providers,
                }),
                runtimeMode: resolveRoleRuntimeMode(crew, id, {
                  projectOverride: project?.runtimeMode,
                  environmentOverride: environment?.runtimeMode,
                }),
                toolbox: resolveRoleToolbox(crew, id, toolbox, state.mode),
              };
            }),
    };
  });

  const getToolbox: CrewCatalog["Service"]["getToolbox"] = Effect.fn("CrewCatalog.getToolbox")(
    function* (projectId) {
      const { project, ...state } = yield* load(projectId);
      // `load` always reads the toolbox when given a project.
      if (project === null) return yield* new ForkCrewsError({ reason: "unavailable", projectId });
      const { grants, diagnostics } = evaluateGrants(project, installedCrews(state.crews));
      return {
        mode: state.mode,
        skills: project.skills.map(({ name, path }) => ({ name, path })),
        mcp: project.mcpFile,
        tools: project.toolsFile,
        grants,
        diagnostics: [...project.diagnostics, ...diagnostics],
      };
    },
  );

  const validateText: CrewCatalog["Service"]["validateText"] = Effect.fn(
    "CrewCatalog.validateText",
  )(function* (input) {
    const state = yield* load(input.projectId);
    if (input.kind === "toolbox") {
      return evaluateGrants(
        state.project ?? {
          grantsPath: ".t3/crews.yaml",
          grantsText: null,
          hasProjectCrewsDirectory: false,
        },
        installedCrews(state.crews),
        input.text,
      ).diagnostics;
    }
    // Without an installed crew to stand in for, the text names its own directory and has no files.
    const directoryName = input.crewId ?? parseCrewYaml(input.text).value?.id ?? "";
    const loaded = state.crews.find((crew) => crew.directoryName === directoryName) ?? {
      directoryName,
      directory: path.join(crewsDirectory, directoryName),
      yamlPath: path.join(crewsDirectory, directoryName, "crew.yaml"),
      text: null,
      files: {},
      roleSkills: {},
      crewSkills: [],
    };
    return evaluateCrew(loaded, state, projectGrants(state), input.text).diagnostics;
  });

  yield* fileSystem
    .makeDirectory(crewsDirectory, { recursive: true })
    .pipe(Effect.ignoreCause({ log: true }));

  // A target that does not exist yet simply contributes no events.
  const watch = (target: string, recursive: boolean) =>
    fileSystem.watch(target, { recursive }).pipe(Stream.catchCause(() => Stream.empty));

  // One watcher per toolbox directory, shared by its subscribers and stopped with the last one.
  // T3 home and a project's `.t3` share a shape, and in a dev worktree they are the same directory.
  // shortcut: a `skills` or `.t3` directory created after the first subscriber is noticed once but not watched inside until the next subscription; rewatch on creation if that bites.
  const watchers = yield* RcMap.make({
    lookup: (directory: string) =>
      watch(path.join(directory, "crews"), true).pipe(
        Stream.merge(watch(path.join(directory, "skills"), true)),
        Stream.merge(
          watch(directory, false).pipe(
            Stream.filter((event) => TOOLBOX_ENTRIES.has(path.basename(event.path))),
          ),
        ),
        Stream.debounce(WATCH_DEBOUNCE),
        Stream.runForEach(() => notifyChanged),
        Effect.forkScoped,
        Effect.asVoid,
      ),
  });

  const subscribe: CrewCatalog["Service"]["subscribe"] = (projectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe and watch before the snapshot, so a change landing in between is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        yield* RcMap.get(watchers, baseDir);
        if (projectId !== undefined) {
          yield* RcMap.get(watchers, path.join(yield* workspaceRoot(projectId), ".t3"));
        }
        // Repeats are not dropped: a change can leave the list equal and still alter a crew's
        // detail, and clients re-read the detail on every emission.
        return Stream.concat(
          Stream.fromEffect(list(projectId)),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list(projectId))),
        );
      }),
    );

  return CrewCatalog.of({
    list,
    get,
    getToolbox,
    validateText,
    subscribe,
    setToolboxMode: (input) =>
      store.setToolboxMode(input).pipe(
        Effect.mapError(
          (cause) =>
            new ForkCrewsError({ reason: "unavailable", projectId: input.projectId, cause }),
        ),
        Effect.andThen(notifyChanged),
      ),
    listRoleOverrides: overridesFor,
    // Overrides change a crew's resolved models, so other clients are told to re-read.
    setRoleOverride: (input) =>
      store.setRoleOverride(input).pipe(
        Effect.mapError((cause) => new ForkCrewsError({ reason: "unavailable", cause })),
        Effect.tap(() => notifyChanged),
      ),
    resetRoleOverrides: (input) =>
      store.resetRoleOverrides(input).pipe(
        Effect.mapError((cause) => new ForkCrewsError({ reason: "unavailable", cause })),
        Effect.andThen(notifyChanged),
      ),
  });
});

export const layer = Layer.effect(CrewCatalog, make);
