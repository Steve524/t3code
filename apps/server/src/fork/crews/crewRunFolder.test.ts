// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import * as ServerConfig from "../../config.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { prepareCrewRunFolder } from "./crewRunFolder.ts";

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerVcsDriver = VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess));
const layerTest = CheckpointStore.layer.pipe(
  Layer.provideMerge(layerVcsDriver),
  Layer.provideMerge(layerVcsProcess),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-crew-run-folder-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcs = yield* VcsProcess.VcsProcess;
    return (yield* vcs.run({ operation: "crewRunFolder.test", command: "git", cwd, args })).stdout;
  });

const repository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "crew-run-folder-" });
  yield* git(cwd, ["init"]);
  yield* git(cwd, ["config", "user.email", "test@test.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* fileSystem.writeFileString(NodePath.join(cwd, "README.md"), "# test\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "initial"]);
  return cwd;
});

/** Captures a checkpoint, changes the code and the ledger, restores, and reads both back. */
const roundTrip = (cwd: string, threadId: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const folder = yield* prepareCrewRunFolder({ cwd, runId: "run-1" });
    const ledger = NodePath.join(folder, "ledger.md");
    yield* fileSystem.writeFileString(ledger, "1. delegate_task -> implementer\n");
    const checkpointRef = checkpointRefForThreadTurn(ThreadId.make(threadId), 1);
    yield* checkpoints.captureCheckpoint({ cwd, checkpointRef });
    yield* fileSystem.writeFileString(NodePath.join(cwd, "README.md"), "# changed\n");
    yield* fileSystem.writeFileString(
      ledger,
      "1. delegate_task -> implementer\n2. t3_thread_send -> implementer\n",
    );
    yield* fileSystem.writeFileString(NodePath.join(folder, "review-notes.md"), "| R1-1 |\n");
    expect(yield* checkpoints.restoreCheckpoint({ cwd, checkpointRef })).toBe(true);
    return {
      readme: yield* fileSystem.readFileString(NodePath.join(cwd, "README.md")),
      ledger: yield* fileSystem.readFileString(ledger),
      notes: yield* fileSystem.exists(NodePath.join(folder, "review-notes.md")),
      status: yield* git(cwd, ["status", "--porcelain", "--untracked-files=all"]),
    };
  });

it.layer(layerTest)("crew run folder", (it) => {
  it.effect("survives a checkpoint restore, which rolls back only the code", () =>
    Effect.gen(function* () {
      const cwd = yield* repository;
      const result = yield* roundTrip(cwd, "thread-crew-run-folder");
      expect(result.readme).toBe("# test\n");
      expect(result.ledger).toContain("2. t3_thread_send");
      expect(result.notes).toBe(true);
      expect(result.status).toBe("");
    }),
  );

  it.effect("is excluded from a linked worktree, and excluded only once", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* repository;
      const linked = `${cwd}-linked`;
      yield* git(cwd, ["worktree", "add", "-b", "crew", linked]);
      yield* Effect.addFinalizer(() =>
        fileSystem.remove(linked, { recursive: true }).pipe(Effect.ignore),
      );
      const result = yield* roundTrip(linked, "thread-crew-run-folder-linked");
      expect(result.readme).toBe("# test\n");
      expect(result.ledger).toContain("2. t3_thread_send");
      expect(result.status).toBe("");
      yield* prepareCrewRunFolder({ cwd: linked, runId: "run-2" });
      const exclude = yield* fileSystem.readFileString(
        NodePath.join(cwd, ".git", "info", "exclude"),
      );
      expect(exclude.split("\n").filter((line) => line === "**/.t3/crew-runs/")).toHaveLength(1);
    }),
  );
});
