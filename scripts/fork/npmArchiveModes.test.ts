import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform, HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { windowsSystemTar } from "../build-cli-archive.ts";
import { npmArchiveCommand, recordNpmArchiveModes } from "./npmArchiveModes.ts";

const run = Effect.fnUntraced(function* (command: ChildProcess.StandardCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const [output, exitCode] = yield* Effect.all(
    [
      child.stdout.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (text, chunk) => text + chunk,
        ),
      ),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  assert.equal(Number(exitCode), 0);
  return output;
});

it.effect.skipIf(HostProcessPlatform.defaultValue() !== "win32")(
  "preserves archive permissions and bytes through NTFS and makes the launcher executable",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-modes-" });
      const tar = windowsSystemTar();
      const command = (args: string[]) =>
        ChildProcess.make(tar, args, { cwd: root, stderr: "inherit" });
      const files = [
        ["t3", "\u007fELF executable\n", "755", "-rwxr-xr-x"],
        ["nested/helper", "native helper\n", "751", "-rwxr-x--x"],
        ["plain.txt", "ordinary data\n", "640", "-rw-r-----"],
        ["space #name.txt", "escaped filename\n", "600", "-rw-------"],
      ] as const;
      const manifest = [
        "#mtree",
        "./source type=dir mode=0755",
        "./source/nested type=dir mode=0750",
      ];
      for (const [name, text, mode] of files) {
        const payload = path.join(root, "payload", name);
        yield* fs.makeDirectory(path.dirname(payload), { recursive: true });
        yield* fs.writeFileString(payload, text);
        const escaped = name.replaceAll(" ", "\\040").replaceAll("#", "\\043");
        manifest.push(`./source/${escaped} type=file mode=${mode} contents=payload/${escaped}`);
      }
      yield* fs.writeFileString(path.join(root, "source.mtree"), `${manifest.join("\n")}\n`);
      const archive = path.join(root, "source.tgz");
      yield* run(command(["-czf", archive, "@source.mtree"]));
      const stage = path.join(root, "stage");
      const extract = path.join(stage, "extract");
      yield* fs.makeDirectory(extract, { recursive: true });
      yield* run(command(["-xf", archive, "-C", extract]));
      yield* recordNpmArchiveModes(archive, extract);
      yield* fs.rename(path.join(extract, "source"), path.join(stage, "package"));
      yield* fs.writeFileString(path.join(stage, "package", "generated.json"), "{}\n");
      const packed = path.join(root, "package.tgz");
      const cwd = yield* HostProcessWorkingDirectory;
      yield* run(
        yield* npmArchiveCommand(path.relative(cwd, stage), path.relative(cwd, packed), tar),
      );
      const listing = (yield* run(command(["-tvf", packed]))).split(/\r?\n/);
      for (const [name, text, , permissions] of files) {
        assert.isTrue(
          listing.some((line) => line.startsWith(permissions) && line.endsWith(` package/${name}`)),
          listing.join("\n"),
        );
        assert.equal(yield* run(command(["-xOf", packed, `package/${name}`])), text);
      }
      assert.isTrue(
        listing.some((line) => line.startsWith("drwxr-x---") && line.endsWith(" package/nested/")),
      );
      assert.isTrue(
        listing.some(
          (line) => line.startsWith("-rw-r--r--") && line.endsWith(" package/generated.json"),
        ),
      );
      const launcherStage = path.join(root, "launcher");
      yield* fs.makeDirectory(path.join(launcherStage, "package", "bin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(launcherStage, "package", "bin", "t3.js"),
        "#!/usr/bin/env node\n",
      );
      const launcher = path.join(root, "launcher.tgz");
      yield* run(yield* npmArchiveCommand(launcherStage, launcher, tar));
      assert.match(yield* run(command(["-tvf", launcher])), /-rwxr-xr-x .* package\/bin\/t3\.js/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps the existing tar command outside Windows", () =>
  Effect.gen(function* () {
    const command = yield* npmArchiveCommand("/stage", "/output.tgz", "tar");
    assert.equal(command.command, "tar");
    assert.deepEqual(command.args, ["-czf", "/output.tgz", "-C", "/stage", "package"]);
  }).pipe(Effect.provideService(HostProcessPlatform, "linux"), Effect.provide(NodeServices.layer)),
);
