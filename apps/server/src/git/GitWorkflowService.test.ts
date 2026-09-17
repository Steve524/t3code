import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";

import { GitCommandError, VcsRepositoryDetectionError } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const RealGitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-workflow-integration-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const IntegrationLayer = GitWorkflowService.layer.pipe(
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
  Layer.provideMerge(RealGitLayer),
  Layer.provideMerge(Layer.mock(GitManager.GitManager)({})),
);

const makeTmpDir = (): Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix: "git-workflow-integration-" });
  });

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(cwd, relativePath), contents);
  });

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

const initRepo = (cwd: string) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* git(cwd, ["branch", "-M", "main"]);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
  );
}

describe("GitWorkflowService", () => {
  it.effect("reports a non-Git VCS repository as not a Git repository", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const isRepository = yield* workflow.isRepository("/jj-repo");

      assert.equal(isRepository, false);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () =>
            Effect.succeed({
              kind: "jj",
              repository: {
                kind: "jj",
                rootPath: "/jj-repo",
                metadataPath: "/jj-repo/.jj",
                freshness: {
                  source: "live-local",
                  observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                  expiresAt: Option.none(),
                },
              },
              driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
            }),
        }),
      ),
    ),
  );

  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("merges ordered branches in a dedicated worktree without moving the base branch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepo(cwd);
        const baseHead = yield* git(cwd, ["rev-parse", "main"]);

        yield* git(cwd, ["checkout", "-b", "feature/frontend"]);
        yield* writeTextFile(cwd, "frontend.txt", "frontend\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "frontend"]);
        yield* git(cwd, ["checkout", "main"]);
        yield* git(cwd, ["checkout", "-b", "feature/backend"]);
        yield* writeTextFile(cwd, "backend.txt", "backend\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "backend"]);
        yield* git(cwd, ["checkout", "main"]);

        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const result = yield* workflow.integrateBranches({
          cwd,
          baseBranch: "main",
          integrationBranch: "team/test/integration",
          branches: ["feature/frontend", "feature/backend"],
        });

        assert.equal(result.status, "merged");
        if (result.status !== "merged") return;
        assert.equal(result.headSha, yield* git(result.worktreePath, ["rev-parse", "HEAD"]));
        assert.equal(yield* git(cwd, ["rev-parse", "main"]), baseHead);
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "main");
        assert.equal(yield* git(result.worktreePath, ["status", "--porcelain"]), "");

        yield* git(cwd, ["checkout", "feature/frontend"]);
        yield* writeTextFile(cwd, "frontend-2.txt", "revision\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "frontend revision"]);
        yield* git(cwd, ["checkout", "main"]);
        const revised = yield* workflow.integrateBranches({
          cwd,
          baseBranch: "main",
          integrationBranch: "team/test/integration",
          branches: ["feature/frontend", "feature/backend"],
        });
        assert.equal(revised.status, "merged");
        if (revised.status !== "merged") return;
        assert.equal(revised.worktreePath, result.worktreePath);
        assert.equal(yield* git(cwd, ["rev-parse", "main"]), baseHead);
      }).pipe(Effect.provide(IntegrationLayer)),
    ),
  );

  it.effect(
    "aborts a conflict and leaves both the integration worktree and base branch clean",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepo(cwd);
          yield* writeTextFile(cwd, "shared.txt", "base\n");
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "shared base"]);
          const baseHead = yield* git(cwd, ["rev-parse", "main"]);

          yield* git(cwd, ["checkout", "-b", "feature/frontend"]);
          yield* writeTextFile(cwd, "shared.txt", "frontend\n");
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "frontend conflict"]);
          yield* git(cwd, ["checkout", "main"]);
          yield* git(cwd, ["checkout", "-b", "feature/backend"]);
          yield* writeTextFile(cwd, "shared.txt", "backend\n");
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "backend conflict"]);
          yield* git(cwd, ["checkout", "main"]);

          const workflow = yield* GitWorkflowService.GitWorkflowService;
          const result = yield* workflow.integrateBranches({
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
        }).pipe(Effect.provide(IntegrationLayer)),
      ),
  );
});
