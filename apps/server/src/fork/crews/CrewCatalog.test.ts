import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestratorMcpCapabilitiesResult,
  type Project,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { CrewSummary } from "../../../../../packages/contracts/src/fork/crews/crewFile.ts";
import type { ForkCrewsError } from "../../../../../packages/contracts/src/fork/crews/crewRpc.ts";
import * as ServerConfig from "../../config.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { runForkMigrations } from "../persistence/ForkMigrations.ts";
import * as CrewCatalog from "./CrewCatalog.ts";
import * as CrewSettingsStore from "./CrewSettingsStore.ts";

/** Has the fixture `.t3` toolbox. */
const toolboxProject = ProjectId.make("project-with-toolbox");
/** A repo that never heard of crews. */
const bareProject = ProjectId.make("project-bare");

const provider = (instanceId: string, driver: string, usable: boolean, ...models: string[]) => ({
  providerInstanceId: ProviderInstanceId.make(instanceId),
  driverKind: ProviderDriverKind.make(driver),
  displayName: null,
  models: models.map((id) => ({ id, label: null })),
  canRunChildTask: usable,
  canRunCrossProviderChildTask: usable,
  constraints: usable ? [] : ["Provider is not authenticated."],
});

// Picker order. The first Codex account is signed out, so it must never be chosen.
const capabilities: OrchestratorMcpCapabilitiesResult = {
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  runtimeMode: "approval-required",
  interactionMode: "default",
  providers: [
    provider("codex-signed-out", "codex", false, "gpt-5.6-terra", "gpt-5.6-luna"),
    provider("codex-work", "codex", true, "gpt-5.6-terra", "gpt-5.6-luna"),
    provider("codex-personal", "codex", true, "gpt-5.6-terra"),
    provider("claude", "claudeAgent", true, "claude-opus-5-5"),
  ],
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 20,
  },
};

interface Sandbox {
  /** T3 home, seeded with the fixture crews, skill library and `mcp.yaml`. */
  readonly home: string;
  /** `toolboxProject`'s `.t3` directory. */
  readonly toolbox: string;
}

/** Runs against copies of the fixtures, so a test can edit files without touching the committed ones. */
const withCatalog = <A, E>(
  body: (
    sandbox: Sandbox,
  ) => Effect.Effect<
    A,
    E,
    CrewCatalog.CrewCatalog | FileSystem.FileSystem | Path.Path | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtures = path.join(import.meta.dirname, "__fixtures__");
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-crews-" });
    const home = path.join(root, "home");
    const roots: Record<string, string> = {
      [toolboxProject]: path.join(root, "with-toolbox"),
      [bareProject]: path.join(root, "bare"),
    };
    const toolbox = path.join(roots[toolboxProject]!, ".t3");
    yield* fileSystem.copy(path.join(fixtures, "home"), home);
    yield* fileSystem.makeDirectory(roots[toolboxProject]!, { recursive: true });
    yield* fileSystem.makeDirectory(roots[bareProject]!, { recursive: true });
    // Committed as `project-toolbox` because the repo ignores every `.t3` directory.
    yield* fileSystem.copy(path.join(fixtures, "project-toolbox"), toolbox);

    return yield* body({ home, toolbox }).pipe(
      Effect.provide(
        CrewCatalog.layer.pipe(
          Layer.provide(CrewSettingsStore.layer),
          Layer.provide(Layer.effectDiscard(runForkMigrations())),
          Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
          Layer.provide(
            Layer.mock(ProjectService.ProjectService)({
              getById: (projectId) =>
                Effect.succeed(
                  Option.fromNullishOr(roots[projectId]).pipe(
                    Option.map((workspaceRoot) => ({ workspaceRoot }) as Project),
                  ),
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
              capabilities: () => Effect.succeed(capabilities),
            }),
          ),
          Layer.provide(ServerConfig.layerTest(process.cwd(), home)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const catalog = CrewCatalog.CrewCatalog;
const statusOf = (crews: ReadonlyArray<CrewSummary>, id: string) =>
  crews.find((crew) => crew.id === id)?.status;

const replaceInFile = Effect.fn("replaceInFile")(function* (
  filePath: string,
  search: string,
  replacement: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(filePath);
  assert.include(text, search);
  yield* fileSystem.writeFileString(filePath, text.replace(search, replacement));
});

/** Emissions of a subscription, in order. */
const collect = Effect.fn("collect")(function* (
  stream: Stream.Stream<ReadonlyArray<CrewSummary>, ForkCrewsError>,
) {
  const seen = yield* Queue.unbounded<ReadonlyArray<CrewSummary>>();
  yield* Stream.runForEach(stream, (crews) => Queue.offer(seen, crews)).pipe(Effect.forkScoped);
  return seen;
});

/** The next emission that matches. A save can produce more than one, so earlier ones are skipped. */
const nextWhere = (
  seen: Queue.Dequeue<ReadonlyArray<CrewSummary>>,
  matches: (crews: ReadonlyArray<CrewSummary>) => boolean,
): Effect.Effect<ReadonlyArray<CrewSummary>> =>
  Queue.take(seen).pipe(Effect.filterOrElse(matches, () => nextWhere(seen, matches)));

describe("crew catalog", () => {
  it.effect("AC 1 and 13 lists the crews in T3 home, ok where the toolbox defines every name", () =>
    withCatalog(({ home }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const crews = yield* (yield* catalog).list(toolboxProject);

        // Exactly the two crews under this server's T3 home, whatever `~/.t3` holds.
        assert.deepStrictEqual(
          crews.map((crew) => crew.id),
          ["bugfix-duo", "feature-trio"],
        );
        const trio = crews.find((crew) => crew.id === "feature-trio")!;
        const fileSystem = yield* FileSystem.FileSystem;
        assert.strictEqual(
          trio.path,
          yield* fileSystem.realPath(path.join(home, "crews", "feature-trio")),
        );
        assert.deepStrictEqual(
          { status: trio.status, counts: trio.diagnosticCounts, home: trio.home },
          {
            status: "ok",
            counts: { errors: 0, warnings: 0, info: 1 },
            home: { mode: "first-step", roleId: "planner", source: "auto" },
          },
        );
        assert.deepStrictEqual(trio.roles, [
          {
            id: "planner",
            name: "Planner",
            description: "Specs, task breakdown",
            tags: ["planner"],
          },
          {
            id: "implementer",
            name: "Implementer",
            description: "UI, APIs, logic",
            tags: ["worker"],
          },
          {
            id: "reviewer",
            name: "QA and review",
            description: "Tests, code review",
            tags: ["reviewer"],
          },
        ]);
        assert.strictEqual(statusOf(crews, "bugfix-duo"), "ok");
      }),
    ),
  );

  it.effect("gives one crew a status per project, and a T3-home-only view without one", () =>
    withCatalog(() =>
      Effect.gen(function* () {
        const crews = yield* catalog;
        // No `.t3`: the names feature-trio lists resolve nowhere, so it runs without them.
        assert.strictEqual(statusOf(yield* crews.list(bareProject), "feature-trio"), "warnings");
        assert.strictEqual(statusOf(yield* crews.list(toolboxProject), "feature-trio"), "ok");
        assert.strictEqual(statusOf(yield* crews.list(), "feature-trio"), "warnings");

        const missing = yield* Effect.flip(crews.list(ProjectId.make("deleted-project")));
        assert.strictEqual(missing.reason, "project_not_found");
      }),
    ),
  );

  it.effect("resolves each role's toolbox with where every item came from", () =>
    withCatalog(() =>
      Effect.gen(function* () {
        const detail = yield* (yield* catalog).get({
          projectId: toolboxProject,
          crewId: "feature-trio",
        });
        const items = (roleId: string) =>
          detail.roles
            .find((role) => role.id === roleId)!
            .toolbox.items.map((item) => `${item.kind}:${item.name}:${item.source}`)
            .toSorted();

        assert.deepStrictEqual(items("implementer"), [
          "mcp:playwright:home",
          "mcp:storybook:repo",
          "skill:glossary:repo",
          "skill:repo-conventions:repo",
          "skill:repo-map:crew",
          "skill:storybook-guide:role",
          "skill:testing:home",
          "tool:e2e:repo",
          "tool:lint:repo",
          "tool:unit-tests:repo",
        ]);
        assert.deepStrictEqual(items("reviewer"), [
          "skill:glossary:repo",
          "skill:repo-map:crew",
          "skill:review-checklist:repo",
          "tool:lint:repo",
        ]);
      }),
    ),
  );

  it.effect("AC 4 picks the first usable instance in picker order for a crew hint", () =>
    withCatalog(() =>
      Effect.gen(function* () {
        const detail = yield* (yield* catalog).get({
          projectId: toolboxProject,
          crewId: "feature-trio",
        });
        assert.deepStrictEqual(detail.roles.find((role) => role.id === "implementer")!.model, {
          selection: {
            instanceId: ProviderInstanceId.make("codex-work"),
            model: "gpt-5.6-terra",
            options: [{ id: "effort", value: "medium" }],
          },
          source: "crew-hint",
          warnings: [],
        });
        assert.deepStrictEqual(
          detail.roles.find((role) => role.id === "implementer")!.runtimeMode,
          {
            runtimeMode: "full-access",
            source: "crew-hint",
            clamped: false,
          },
        );
      }),
    ),
  );

  it.effect(
    "AC 5 prefers a project override in its project and the environment one elsewhere",
    () =>
      withCatalog(() =>
        Effect.gen(function* () {
          const crews = yield* catalog;
          const role = { crewId: "feature-trio", roleId: "planner" };
          const everywhere = {
            instanceId: ProviderInstanceId.make("codex-work"),
            model: "gpt-5.6-luna",
          };
          const here = {
            instanceId: ProviderInstanceId.make("codex-personal"),
            model: "gpt-5.6-terra",
          };
          yield* crews.setRoleOverride({
            scope: "environment",
            ...role,
            modelSelection: everywhere,
          });
          yield* crews.setRoleOverride({
            scope: "project",
            projectId: toolboxProject,
            ...role,
            modelSelection: here,
            runtimeMode: "auto-accept-edits",
          });
          const planner = (projectId: ProjectId) =>
            crews
              .get({ projectId, crewId: "feature-trio" })
              .pipe(Effect.map((detail) => detail.roles.find((entry) => entry.id === "planner")!));

          const inProject = yield* planner(toolboxProject);
          assert.deepStrictEqual(
            [inProject.model.selection, inProject.model.source],
            [here, "project"],
          );
          assert.deepStrictEqual(inProject.runtimeMode, {
            runtimeMode: "auto-accept-edits",
            source: "project",
            clamped: false,
          });
          const elsewhere = yield* planner(bareProject);
          assert.deepStrictEqual(
            [elsewhere.model.selection, elsewhere.model.source],
            [everywhere, "environment"],
          );

          yield* crews.resetRoleOverrides({
            scope: "project",
            projectId: toolboxProject,
            crewId: "feature-trio",
          });
          assert.strictEqual((yield* planner(toolboxProject)).model.source, "environment");
        }),
      ),
  );

  it.effect("AC 6 keeps a crew startable when no instance offers a hinted model", () =>
    withCatalog(({ home }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const crews = yield* catalog;
        yield* replaceInFile(
          path.join(home, "crews", "feature-trio", "crew.yaml"),
          "gpt-5.6-luna",
          "gpt-9",
        );

        assert.strictEqual(statusOf(yield* crews.list(toolboxProject), "feature-trio"), "warnings");
        const detail = yield* crews.get({ projectId: toolboxProject, crewId: "feature-trio" });
        const reviewer = detail.roles.find((role) => role.id === "reviewer")!.model;
        assert.deepStrictEqual([reviewer.selection, reviewer.source], [null, "composer"]);
        assert.include(reviewer.warnings[0], "codex/gpt-9");
      }),
    ),
  );

  it.effect("AC 7 validates unsaved text of either kind without writing it", () =>
    withCatalog(({ home, toolbox }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crews = yield* catalog;
        const crewPath = path.join(home, "crews", "feature-trio", "crew.yaml");
        const grantsPath = path.join(toolbox, "crews.yaml");
        const saved = yield* fileSystem.readFileString(crewPath);
        const savedGrants = yield* fileSystem.readFileString(grantsPath);

        const unsaved = saved.replace("role: reviewer", "role: nobody");
        const crewDiagnostics = yield* crews.validateText({
          projectId: toolboxProject,
          kind: "crew",
          crewId: "feature-trio",
          text: unsaved,
        });
        const unknownRole = crewDiagnostics.find((entry) => entry.severity === "error")!;
        assert.include(unknownRole.message, 'Unknown role "nobody"');
        assert.strictEqual(unknownRole.file, crewPath);
        assert.strictEqual(unsaved.split("\n")[unknownRole.line - 1]!.trim(), "role: nobody");
        assert.isAbove(unknownRole.column, 1);

        const toolboxDiagnostics = yield* crews.validateText({
          projectId: toolboxProject,
          kind: "toolbox",
          text: "version: 1\ncrews:\n  ghost: { worker: { tools: [lint] } }\n",
        });
        assert.deepStrictEqual(
          toolboxDiagnostics.map((entry) => [entry.severity, entry.line]),
          [["warning", 3]],
        );

        const newCrew = yield* crews.validateText({ kind: "crew", text: "version: 1\nid: [" });
        assert.strictEqual(newCrew[0]?.severity, "error");

        assert.strictEqual(yield* fileSystem.readFileString(crewPath), saved);
        assert.strictEqual(yield* fileSystem.readFileString(grantsPath), savedGrants);
        assert.deepStrictEqual(
          (yield* fileSystem.readDirectory(path.join(home, "crews"))).toSorted(),
          ["bugfix-duo", "feature-trio"],
        );
      }),
    ),
  );

  it.effect("AC 8 ignores crews inside a repo and says where grants belong", () =>
    withCatalog(({ toolbox }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crews = yield* catalog;
        yield* fileSystem.makeDirectory(path.join(toolbox, "crews", "foo"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(toolbox, "crews", "foo", "crew.yaml"),
          "version: 1\nid: foo\n",
        );

        assert.deepStrictEqual(
          (yield* crews.list(toolboxProject)).map((crew) => crew.id),
          ["bugfix-duo", "feature-trio"],
        );
        const info = (yield* crews.getToolbox(toolboxProject)).diagnostics.filter(
          (entry) => entry.severity === "info",
        );
        assert.strictEqual(info.length, 1);
        assert.strictEqual(info[0]!.file, path.join(toolbox, "crews.yaml"));
        assert.include(info[0]!.message, ".t3/crews.yaml");
      }),
    ),
  );

  it.effect("AC 19 grades toolbox problems and ignores a malformed grant file", () =>
    withCatalog(({ toolbox }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crews = yield* catalog;
        const grantsPath = path.join(toolbox, "crews.yaml");

        const clean = yield* crews.getToolbox(toolboxProject);
        assert.deepStrictEqual(clean.diagnostics, []);
        assert.deepStrictEqual(
          [clean.mode, clean.skills.map((skill) => skill.name), Object.keys(clean.tools.tools)],
          [
            "extend",
            ["glossary", "repo-conventions", "review-checklist"],
            ["unit-tests", "e2e", "lint"],
          ],
        );

        yield* fileSystem.writeFileString(
          grantsPath,
          [
            "version: 1",
            "tags:",
            "  frontend: { tools: [lint] }",
            "crews:",
            '  ghost: { "*": { tools: [lint] } }',
            "  feature-trio: { nobody: { tools: [lint] } }",
            "",
          ].join("\n"),
        );
        assert.deepStrictEqual(
          (yield* crews.getToolbox(toolboxProject)).diagnostics
            .map((entry) => [entry.severity, entry.line])
            .toSorted(),
          [
            ["info", 3],
            ["warning", 5],
            ["warning", 6],
          ],
        );

        // Under `crews."*"` only `"*"` is allowed.
        yield* fileSystem.writeFileString(
          grantsPath,
          'version: 1\ncrews:\n  "*":\n    implementer: { tools: [lint] }\n',
        );
        const malformed = yield* crews.getToolbox(toolboxProject);
        assert.strictEqual(malformed.grants, null);
        assert.isNotEmpty(malformed.diagnostics);
        assert.isTrue(malformed.diagnostics.every((entry) => entry.severity === "error"));
        // Without the grants, bugfix-duo's roles simply carry nothing from this repo.
        const listed = yield* crews.list(toolboxProject);
        assert.deepStrictEqual(
          listed.map((crew) => [crew.id, crew.status]),
          [
            ["bugfix-duo", "ok"],
            ["feature-trio", "ok"],
          ],
        );
      }),
    ),
  );

  it.effect("AC 16 switches the collision winner and tells subscribers", () =>
    withCatalog(({ toolbox }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crews = yield* catalog;
        // The same skill name as `<T3 home>/skills/testing`.
        yield* fileSystem.makeDirectory(path.join(toolbox, "skills", "testing"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(toolbox, "skills", "testing", "SKILL.md"),
          "Run this repo's tests.\n",
        );
        const testing = crews.get({ projectId: toolboxProject, crewId: "feature-trio" }).pipe(
          Effect.map((detail) => ({
            source: detail.roles
              .find((role) => role.id === "implementer")!
              .toolbox.items.find((item) => item.name === "testing")!.source,
            collisions: detail.diagnostics.filter((entry) => entry.message.includes("collides")),
          })),
        );

        const seen = yield* collect(crews.subscribe(toolboxProject));
        assert.strictEqual(statusOf(yield* Queue.take(seen), "feature-trio"), "warnings");
        const extended = yield* testing;
        assert.strictEqual(extended.source, "home");
        assert.strictEqual(extended.collisions[0]?.severity, "warning");

        yield* crews.setToolboxMode({ projectId: toolboxProject, mode: "override" });
        assert.strictEqual(statusOf(yield* Queue.take(seen), "feature-trio"), "warnings");
        assert.strictEqual((yield* testing).source, "repo");
        assert.strictEqual((yield* crews.getToolbox(toolboxProject)).mode, "override");
      }),
    ),
  );
});

// Live clock and real filesystem events, so this proves the watcher and not a direct read.
describe("crew catalog watching", () => {
  it.live("AC 3 republishes when a crew file or a toolbox file changes on disk", () =>
    withCatalog(({ home, toolbox }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const seen = yield* collect((yield* catalog).subscribe(toolboxProject));
        assert.strictEqual(statusOf(yield* Queue.take(seen), "feature-trio"), "ok");

        yield* replaceInFile(
          path.join(home, "crews", "feature-trio", "roles", "planner.md"),
          "short plan",
          "short plan for {{inputs.nope}}",
        );
        yield* nextWhere(seen, (crews) => statusOf(crews, "feature-trio") === "invalid");

        yield* replaceInFile(
          path.join(home, "crews", "feature-trio", "roles", "planner.md"),
          " for {{inputs.nope}}",
          "",
        );
        yield* nextWhere(seen, (crews) => statusOf(crews, "feature-trio") === "ok");

        // Every role is granted `lint`, so removing its definition leaves both crews short.
        yield* replaceInFile(path.join(toolbox, "tools.yaml"), "  lint:", "  lint-renamed:");
        yield* nextWhere(seen, (crews) => statusOf(crews, "bugfix-duo") === "warnings");
      }).pipe(Effect.timeout("30 seconds")),
    ),
  );
});
