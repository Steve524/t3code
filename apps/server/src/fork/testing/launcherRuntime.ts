// @effect-diagnostics nodeBuiltinImport:off - The standalone launcher uses native child processes; these fixtures preserve its IPC.
import type * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import { vi } from "vite-plus/test";
import { windowsHost } from "./platformFixtures.ts";

// Windows cannot execute a shebang. Only this test's marked runtime fixtures
// are launched through Node; the launcher still uses real child processes and IPC.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const fs = await import("node:fs");
  return {
    ...original,
    spawn(command: string, args: ReadonlyArray<string>, options: NodeChildProcess.SpawnOptions) {
      if (command.endsWith("t3.exe") && fs.existsSync(`${command}.fixture.mjs`)) {
        return original.spawn(process.execPath, [`${command}.fixture.mjs`, ...args], options);
      }
      return original.spawn(command, args, options);
    },
  };
});

export const prepareLauncherRuntime = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  entryPath: string,
  childSource: string,
) {
  if (!windowsHost) return;
  yield* fs.writeFileString(`${entryPath}.exe`, "test runtime\n");
  yield* fs.writeFileString(`${entryPath}.exe.fixture.mjs`, childSource);
});
