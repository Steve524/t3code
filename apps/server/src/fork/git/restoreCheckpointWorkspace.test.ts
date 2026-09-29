import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";

it.effect(
  "restoring an empty nested checkpoint leaves a usable workspace and preserves its sibling",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-checkpoint-" });
      const cwd = path.join(root, "nested");
      const git = (args: string[]) => driver.execute({ operation: "test", cwd: root, args });
      yield* git(["init"]);
      yield* git(["config", "user.email", "test@example.test"]);
      yield* git(["config", "user.name", "Test"]);
      yield* fs.writeFileString(path.join(root, "outside.txt"), "keep\n");
      yield* git(["add", "outside.txt"]);
      yield* git(["commit", "-m", "initial"]);
      yield* fs.makeDirectory(cwd);
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/fork-empty");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      for (const staged of [false, true]) {
        yield* fs.writeFileString(path.join(cwd, "added.txt"), "new\n");
        if (staged) yield* git(["add", "nested/added.txt"]);
        assert.isTrue(
          yield* driver.checkpoints.restoreCheckpoint({
            cwd,
            checkpointRef,
            fallbackToHead: false,
          }),
        );
        assert.deepEqual(yield* fs.readDirectory(cwd), []);
        assert.equal(yield* fs.readFileString(path.join(root, "outside.txt")), "keep\n");
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);
