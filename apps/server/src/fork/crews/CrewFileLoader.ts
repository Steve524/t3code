/**
 * CrewFileLoader - reads one crew directory under T3 home: `crew.yaml`, the
 * text files its roles and steps can reference, and the skills granted by
 * where they sit.
 *
 * Loading is best-effort. An unreadable or oversized file is left out, and the
 * validator then reports it as missing where the crew references it.
 *
 * @module CrewFileLoader
 */
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { CrewToolboxDefinition } from "../../../../../packages/shared/src/fork/crews/resolveRoleToolbox.ts";
import type { CrewValidationContext } from "../../../../../packages/shared/src/fork/crews/validateCrew.ts";
import { loadSkills } from "./CrewToolboxLoader.ts";

/** Role and prompt files are prose; anything larger is not one. */
const MAX_CREW_FILE_SIZE = ByteSize.kibibytes(256);
const MAX_CREW_FILES = 500;

export interface LoadedCrew {
  readonly directoryName: string;
  /** Canonical, because the validator checks that referenced files resolve inside it. */
  readonly directory: string;
  readonly yamlPath: string;
  /** Null when the directory has no readable `crew.yaml`, so it is not a crew. */
  readonly text: string | null;
  readonly files: CrewValidationContext["files"];
  readonly roleSkills: Readonly<Record<string, ReadonlyArray<CrewToolboxDefinition>>>;
  readonly crewSkills: ReadonlyArray<CrewToolboxDefinition>;
}

export const loadCrew = Effect.fn("CrewFileLoader.loadCrew")(function* (
  crewsDirectory: string,
  directoryName: string,
): Effect.fn.Return<LoadedCrew, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const joined = path.join(crewsDirectory, directoryName);
  const directory = yield* fileSystem.realPath(joined).pipe(Effect.orElseSucceed(() => joined));
  const yamlPath = path.join(directory, "crew.yaml");
  const text = yield* fileSystem.readFileString(yamlPath).pipe(Effect.orElseSucceed(() => null));
  if (text === null) {
    return { directoryName, directory, yamlPath, text, files: {}, roleSkills: {}, crewSkills: [] };
  }

  const entries = yield* fileSystem
    .readDirectory(directory, { recursive: true })
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const files: Record<string, { readonly realPath: string; readonly text: string }> = {};
  for (const entry of entries.toSorted()) {
    const relative = entry.replaceAll("\\", "/");
    // Skills are granted by location and never referenced by path.
    if (relative === "crew.yaml" || /(?:^|\/)skills\//u.test(relative)) continue;
    if (Object.keys(files).length >= MAX_CREW_FILES) {
      yield* Effect.logWarning("ignoring crew files past the limit", {
        path: directory,
        limit: MAX_CREW_FILES,
      });
      break;
    }
    const filePath = path.join(directory, entry);
    const info = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => undefined));
    if (info?.type !== "File" || ByteSize.isGreaterThan(info.size, MAX_CREW_FILE_SIZE)) continue;
    const contents = yield* Effect.all([
      fileSystem.realPath(filePath),
      fileSystem.readFileString(filePath),
    ]).pipe(Effect.orElseSucceed(() => undefined));
    if (contents !== undefined) files[relative] = { realPath: contents[0], text: contents[1] };
  }

  const roleSkills: Record<string, ReadonlyArray<CrewToolboxDefinition>> = {};
  const roleEntries = yield* fileSystem
    .readDirectory(path.join(directory, "roles"))
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  for (const roleId of roleEntries.toSorted()) {
    const skills = yield* loadSkills(path.join(directory, "roles", roleId, "skills"));
    if (skills.length > 0) roleSkills[roleId] = skills;
  }

  return {
    directoryName,
    directory,
    yamlPath,
    text,
    files,
    roleSkills,
    crewSkills: yield* loadSkills(path.join(directory, "skills")),
  };
});
