import { VcsProcessExitError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

// git -C <nested> clean -fd can remove the workspace itself on Windows.
export const restoreCheckpointWorkspace = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  cwd: string,
) {
  yield* fs.makeDirectory(cwd, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new VcsProcessExitError({
          operation: "GitVcsDriver.checkpoints.restoreCheckpoint",
          command: "git clean",
          cwd,
          exitCode: 0,
          detail: `Could not recreate the checkpoint workspace: ${cause.message}`,
        }),
    ),
  );
});
