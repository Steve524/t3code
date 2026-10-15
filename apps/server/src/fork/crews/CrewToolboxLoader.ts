/**
 * CrewToolboxLoader - reads the skills, MCP servers and tools a toolbox
 * directory defines: T3 home, or a project's `.t3`.
 *
 * Loading is best-effort. A missing file defines nothing, and a file that does
 * not parse defines nothing and reports why.
 *
 * @module CrewToolboxLoader
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type {
  CrewDiagnostic,
  CrewMcpFile,
  CrewToolsFile,
} from "../../../../../packages/contracts/src/fork/crews/crewFile.ts";
import {
  parseCrewMcpYaml,
  parseCrewToolsYaml,
  type CrewYamlResult,
} from "../../../../../packages/shared/src/fork/crews/parseCrewYaml.ts";
import type { CrewToolboxDefinition } from "../../../../../packages/shared/src/fork/crews/resolveRoleToolbox.ts";

export interface LoadedToolboxDefinitions {
  readonly skills: ReadonlyArray<CrewToolboxDefinition>;
  readonly mcp: ReadonlyArray<CrewToolboxDefinition>;
  readonly mcpFile: CrewMcpFile;
  readonly tools: ReadonlyArray<CrewToolboxDefinition>;
  readonly toolsFile: CrewToolsFile;
  readonly diagnostics: ReadonlyArray<CrewDiagnostic>;
}

export interface LoadedProjectToolbox extends LoadedToolboxDefinitions {
  /** The project's `.t3` directory, whether or not it exists. */
  readonly directory: string;
  readonly grantsPath: string;
  /** Null when `.t3/crews.yaml` is missing or unreadable. */
  readonly grantsText: string | null;
  readonly hasProjectCrewsDirectory: boolean;
}

/**
 * Skills are identified by their directory, as Claude Code does it, so a
 * `SKILL.md` from any agent library drops in unchanged.
 */
export const loadSkills = Effect.fn("CrewToolboxLoader.loadSkills")(function* (
  skillsDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem
    .readDirectory(skillsDirectory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const skills: Array<CrewToolboxDefinition> = [];
  for (const name of entries.toSorted()) {
    const skillPath = path.join(skillsDirectory, name, "SKILL.md");
    // realPath doubles as the existence check and gives canonical casing on Windows.
    const realPath = yield* fileSystem
      .realPath(skillPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (realPath !== undefined) skills.push({ name, path: skillPath, realPath });
  }
  return skills;
});

const loadYamlDefinitions = Effect.fn("CrewToolboxLoader.loadYamlDefinitions")(function* <T>(
  filePath: string,
  parse: (text: string, file: string) => CrewYamlResult<T>,
  names: (value: T) => ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem
    .readFileString(filePath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (text === undefined) return { value: null, definitions: [], diagnostics: [] };
  const parsed = parse(text, filePath);
  const realPath = yield* fileSystem.realPath(filePath).pipe(Effect.orElseSucceed(() => filePath));
  return {
    value: parsed.value,
    definitions:
      parsed.value === null
        ? []
        : names(parsed.value).map((name): CrewToolboxDefinition => ({
            name,
            path: filePath,
            realPath,
          })),
    diagnostics: parsed.diagnostics,
  };
});

/** Definitions in one toolbox directory. Tools are repo commands, so T3 home has none. */
export const loadDefinitions = Effect.fn("CrewToolboxLoader.loadDefinitions")(function* (
  directory: string,
  options: { readonly tools: boolean },
) {
  const path = yield* Path.Path;
  const skills = yield* loadSkills(path.join(directory, "skills"));
  const mcp = yield* loadYamlDefinitions(
    path.join(directory, "mcp.yaml"),
    parseCrewMcpYaml,
    (file) => Object.keys(file.servers),
  );
  const tools = options.tools
    ? yield* loadYamlDefinitions(path.join(directory, "tools.yaml"), parseCrewToolsYaml, (file) =>
        Object.keys(file.tools),
      )
    : { value: null, definitions: [], diagnostics: [] };
  return {
    skills,
    mcp: mcp.definitions,
    mcpFile: mcp.value ?? { servers: {} },
    tools: tools.definitions,
    toolsFile: tools.value ?? { tools: {} },
    diagnostics: [...mcp.diagnostics, ...tools.diagnostics],
  } satisfies LoadedToolboxDefinitions;
});

/** The toolbox files a dry run may propose, relative to `.t3/`. */
const SKILL_FILE = /^skills\/([\w.-]+)\/SKILL\.md$/u;
export const isToolboxFilePath = (file: string) =>
  file === "crews.yaml" ||
  file === "mcp.yaml" ||
  file === "tools.yaml" ||
  (SKILL_FILE.test(file) && !file.includes(".."));

/**
 * `project` as if `files` (toolbox paths to full text) were on disk; nothing is written. A
 * proposed file replaces the one on disk, with its parse diagnostics.
 */
export function overlayProjectToolbox(
  project: LoadedProjectToolbox,
  files: Readonly<Record<string, string>>,
  join: (...parts: ReadonlyArray<string>) => string,
): LoadedProjectToolbox {
  const pathOf = (relative: string) => join(project.directory, ...relative.split("/"));
  const proposed = <T>(
    relative: string,
    parse: (text: string, file: string) => CrewYamlResult<T>,
    names: (value: T) => ReadonlyArray<string>,
  ) => {
    const text = files[relative];
    if (text === undefined) return null;
    const file = pathOf(relative);
    const { value, diagnostics } = parse(text, file);
    const definitions = (value === null ? [] : names(value)).map((name): CrewToolboxDefinition => ({
      name,
      path: file,
      realPath: file,
    }));
    return { file, value, definitions, diagnostics };
  };
  const mcp = proposed("mcp.yaml", parseCrewMcpYaml, (value) => Object.keys(value.servers));
  const tools = proposed("tools.yaml", parseCrewToolsYaml, (value) => Object.keys(value.tools));
  const replaced = new Set([mcp?.file, tools?.file]);
  const skills = Object.keys(files).flatMap((relative) => {
    const name = SKILL_FILE.exec(relative)?.[1];
    if (name === undefined || project.skills.some((skill) => skill.name === name)) return [];
    return [{ name, path: pathOf(relative), realPath: pathOf(relative) }];
  });
  return {
    ...project,
    ...(files["crews.yaml"] === undefined ? {} : { grantsText: files["crews.yaml"] }),
    ...(mcp && { mcp: mcp.definitions, mcpFile: mcp.value ?? { servers: {} } }),
    ...(tools && { tools: tools.definitions, toolsFile: tools.value ?? { tools: {} } }),
    skills: [...project.skills, ...skills],
    diagnostics: [
      ...project.diagnostics.filter((diagnostic) => !replaced.has(diagnostic.file)),
      ...(mcp?.diagnostics ?? []),
      ...(tools?.diagnostics ?? []),
    ],
  };
}

/** A project's `.t3` toolbox: its definitions and the raw grant file. */
export const loadProjectToolbox = Effect.fn("CrewToolboxLoader.loadProjectToolbox")(function* (
  workspaceRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(workspaceRoot, ".t3");
  const grantsPath = path.join(directory, "crews.yaml");
  const definitions = yield* loadDefinitions(directory, { tools: true });
  const grantsText = yield* fileSystem
    .readFileString(grantsPath)
    .pipe(Effect.orElseSucceed(() => null));
  const hasProjectCrewsDirectory = yield* fileSystem
    .exists(path.join(directory, "crews"))
    .pipe(Effect.orElseSucceed(() => false));
  return {
    ...definitions,
    directory,
    grantsPath,
    grantsText,
    hasProjectCrewsDirectory,
  } satisfies LoadedProjectToolbox;
});
