import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { windowsSystemTar } from "../build-cli-archive.ts";

const SOURCE_MANIFEST = "archive-modes.mtree";
const modeAttribute = / mode=([0-7]+)(?= |$)/;
const entryPath = (line: string) => (line.split(" ", 1)[0] ?? "").replace(/^\.\//, "");

export class NpmArchiveModesError extends Schema.TaggedError<NpmArchiveModesError>()(
  "NpmArchiveModesError",
  { command: Schema.String, exitCode: Schema.Int },
) {
  override get message() {
    return `${this.command} exited with code ${this.exitCode}.`;
  }
}

const writeManifest = Effect.fnUntraced(function* (
  tar: string,
  manifest: string,
  source: string,
  cwd?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(tar, ["--format=mtree", "-cf", manifest, source], {
      ...(cwd === undefined ? {} : { cwd }),
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) return yield* new NpmArchiveModesError({ command: tar, exitCode });
});

// Capture permissions from the archive before NTFS's file modes can replace them.
export const recordNpmArchiveModes = Effect.fnUntraced(function* (
  archive: string,
  extractDir: string,
) {
  if ((yield* HostProcessPlatform) !== "win32") return;
  const path = yield* Path.Path;
  yield* writeManifest(
    windowsSystemTar(),
    path.resolve(extractDir, "..", SOURCE_MANIFEST),
    `@${archive}`,
  );
});

// Let bsdtar handle mtree escaping and file data; only replace its mode attributes.
export const npmArchiveCommand = Effect.fnUntraced(function* (
  stageDir: string,
  tarball: string,
  tarCommand: string,
) {
  if ((yield* HostProcessPlatform) !== "win32") {
    return ChildProcess.make(tarCommand, ["-czf", tarball, "-C", stageDir, "package"]);
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceManifest = path.join(stageDir, SOURCE_MANIFEST);
  const modes = new Map<string, string>();
  if (yield* fs.exists(sourceManifest)) {
    for (const line of (yield* fs.readFileString(sourceManifest)).split(/\r?\n/)) {
      const mode = modeAttribute.exec(line)?.[1];
      if (mode) modes.set(entryPath(line).replace(/^[^/]+/, "package"), mode);
    }
  }
  const manifest = path.resolve(stageDir, "package.mtree");
  yield* writeManifest(tarCommand, manifest, "package", stageDir);
  const contents = (yield* fs.readFileString(manifest))
    .split(/\r?\n/)
    .map((line) => {
      if (!modeAttribute.test(line)) return line;
      const name = entryPath(line);
      const mode =
        name === "package/t3" || name === "package/bin/t3.js"
          ? "755"
          : (modes.get(name) ?? (line.includes(" type=dir") ? "755" : "644"));
      return line.replace(/^\.\//, "").replace(modeAttribute, ` mode=${mode}`);
    })
    .join("\n");
  yield* fs.writeFileString(manifest, contents);
  return ChildProcess.make(tarCommand, ["-czf", path.resolve(tarball), `@${manifest}`], {
    cwd: stageDir,
  });
});
