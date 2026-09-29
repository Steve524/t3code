import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import type * as FileSystem from "effect/FileSystem";
import { windowsHost } from "./platformFixtures.ts";

export const claudeFixtureExecutable = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  script: string,
) {
  if (!windowsHost) return script;
  const path = yield* Path.Path;
  const entry = path.join(
    path.dirname(script),
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "cli.js",
  );
  yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
  yield* fs.writeFileString(path.join(path.dirname(entry), "package.json"), '{"type":"module"}');
  yield* fs.copyFile(script, entry);
  const node = yield* HostProcessExecutablePath;
  yield* fs.writeFileString(`${script}.cmd`, `@"${node}" "${entry}" %*\r\n`);
  return `${script}.cmd`;
});
