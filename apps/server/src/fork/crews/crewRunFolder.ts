/**
 * The per-run folder that holds a crew's ledger, review notes, and artifacts.
 *
 * It lives inside the workspace so every harness can reach it, and stays out of git through the
 * repository's exclude file. Checkpoints stage with `add -A` (no force) and restore with
 * `clean -fd` (no `-x`), so a restore never rolls back or deletes the ledger's counts.
 *
 * @module crewRunFolder
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { VcsProcess } from "../../vcs/VcsProcess.ts";
import { CREW_RUNS_DIRECTORY } from "./CrewPromptComposer.ts";

// Matches at any depth, so a workspace below the repository root is covered too.
const EXCLUDE_PATTERN = `**/${CREW_RUNS_DIRECTORY}/`;

/** Creates the run's folder and excludes every run folder from git. Returns its absolute path. */
export const prepareCrewRunFolder = Effect.fn("prepareCrewRunFolder")(function* (input: {
  readonly cwd: string;
  readonly runId: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess;
  const folder = path.join(input.cwd, CREW_RUNS_DIRECTORY, input.runId);
  yield* fileSystem.makeDirectory(folder, { recursive: true });
  // `--git-path` resolves to the shared exclude file from a linked worktree too.
  const resolved = yield* vcs.run({
    operation: "crewRunFolder.excludePath",
    command: "git",
    cwd: input.cwd,
    args: ["rev-parse", "--git-path", "info/exclude"],
  });
  const exclude = path.resolve(input.cwd, resolved.stdout.trim());
  const current = (yield* fileSystem.exists(exclude))
    ? yield* fileSystem.readFileString(exclude)
    : "";
  if (!current.split(/\r?\n/u).includes(EXCLUDE_PATTERN)) {
    yield* fileSystem.makeDirectory(path.dirname(exclude), { recursive: true });
    const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    yield* fileSystem.writeFileString(exclude, `${current}${separator}${EXCLUDE_PATTERN}\n`);
  }
  return folder;
});
