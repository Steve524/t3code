import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as TeamBranchIntegration from "./TeamBranchIntegration.ts";

const TestLayer = TeamBranchIntegration.layer.pipe(
  Layer.provideMerge(
    Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      resolve: ({ cwd }) =>
        Effect.succeed({
          kind: "git",
          repository: {
            kind: "git",
            rootPath: cwd,
            metadataPath: `${cwd}/.git`,
            freshness: {
              source: "live-local",
              observedAt: DateTime.makeUnsafe("2026-09-16T00:00:00.000Z"),
              expiresAt: Option.none(),
            },
          },
          driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
        }),
    }),
  ),
  Layer.provideMerge(
    GitVcsDriver.layer.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-integration-test-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitWorkflowService.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const write = (cwd: string, filename: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(cwd, filename), contents);
  });

const commitFile = (cwd: string, filename: string, contents: string, message: string) =>
  Effect.gen(function* () {
    yield* write(cwd, filename, contents);
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", message]);
  });

const initRepo = (cwd: string) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* git(cwd, ["branch", "-M", "main"]);
    yield* commitFile(cwd, "README.md", "# test\n", "initial commit");
  });

it.effect("merges ordered team branches without moving the base branch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "team-branch-integration-" });
      yield* initRepo(cwd);
      const baseHead = yield* git(cwd, ["rev-parse", "main"]);

      yield* git(cwd, ["checkout", "-b", "feature/frontend"]);
      yield* commitFile(cwd, "frontend.txt", "frontend\n", "frontend");
      yield* git(cwd, ["checkout", "main"]);
      yield* git(cwd, ["checkout", "-b", "feature/backend"]);
      yield* commitFile(cwd, "backend.txt", "backend\n", "backend");
      yield* git(cwd, ["checkout", "main"]);

      const integration = yield* TeamBranchIntegration.TeamBranchIntegration;
      const input = {
        cwd,
        baseBranch: "main",
        integrationBranch: "team/test/integration",
        branches: ["feature/frontend", "feature/backend"],
      };
      const result = yield* integration.integrateBranches(input);
      assert.equal(result.status, "merged");
      if (result.status !== "merged") return;
      assert.equal(result.headSha, yield* git(result.worktreePath, ["rev-parse", "HEAD"]));
      assert.equal(yield* git(cwd, ["rev-parse", "main"]), baseHead);
      assert.equal(yield* git(cwd, ["branch", "--show-current"]), "main");
      assert.equal(yield* git(result.worktreePath, ["status", "--porcelain"]), "");

      yield* git(cwd, ["checkout", "feature/frontend"]);
      yield* commitFile(cwd, "frontend-2.txt", "revision\n", "frontend revision");
      yield* git(cwd, ["checkout", "main"]);
      const revised = yield* integration.integrateBranches(input);
      assert.equal(revised.status, "merged");
      if (revised.status !== "merged") return;
      assert.equal(revised.worktreePath, result.worktreePath);
      assert.equal(yield* git(cwd, ["rev-parse", "main"]), baseHead);
    }).pipe(Effect.provide(TestLayer)),
  ),
);

it.effect("aborts a conflict and leaves the integration worktree and base branch clean", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "team-branch-conflict-" });
      yield* initRepo(cwd);
      yield* commitFile(cwd, "shared.txt", "base\n", "shared base");
      const baseHead = yield* git(cwd, ["rev-parse", "main"]);

      yield* git(cwd, ["checkout", "-b", "feature/frontend"]);
      yield* commitFile(cwd, "shared.txt", "frontend\n", "frontend conflict");
      yield* git(cwd, ["checkout", "main"]);
      yield* git(cwd, ["checkout", "-b", "feature/backend"]);
      yield* commitFile(cwd, "shared.txt", "backend\n", "backend conflict");
      yield* git(cwd, ["checkout", "main"]);

      const integration = yield* TeamBranchIntegration.TeamBranchIntegration;
      const result = yield* integration.integrateBranches({
        cwd,
        baseBranch: "main",
        integrationBranch: "team/test/integration",
        branches: ["feature/frontend", "feature/backend"],
      });
      assert.equal(result.status, "conflict");
      if (result.status !== "conflict") return;
      assert.equal(result.conflictingBranch, "feature/backend");
      assert.deepStrictEqual(result.conflictingFiles, ["shared.txt"]);
      assert.equal(yield* git(result.worktreePath, ["status", "--porcelain"]), "");
      assert.equal(yield* git(cwd, ["rev-parse", "main"]), baseHead);
      assert.equal(yield* git(cwd, ["status", "--porcelain"]), "");
    }).pipe(Effect.provide(TestLayer)),
  ),
);
