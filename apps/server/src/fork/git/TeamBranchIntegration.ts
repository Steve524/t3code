import { GitCommandError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";

export interface GitIntegrateBranchesInput {
  readonly cwd: string;
  readonly baseBranch: string;
  readonly integrationBranch: string;
  readonly branches: ReadonlyArray<string>;
}

export type GitIntegrateBranchesResult =
  | {
      readonly status: "merged";
      readonly branch: string;
      readonly worktreePath: string;
      readonly headSha: string;
    }
  | {
      readonly status: "conflict";
      readonly branch: string;
      readonly worktreePath: string;
      readonly conflictingBranch: string;
      readonly conflictingFiles: ReadonlyArray<string>;
    };

export class TeamBranchIntegration extends Context.Service<
  TeamBranchIntegration,
  {
    readonly integrateBranches: (
      input: GitIntegrateBranchesInput,
    ) => Effect.Effect<GitIntegrateBranchesResult, GitCommandError>;
  }
>()("t3/fork/git/TeamBranchIntegration") {}

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const integrateBranches = Effect.fn("GitWorkflowService.integrateBranches")(function* (
    input: GitIntegrateBranchesInput,
  ) {
    const handle = yield* registry.resolve({ cwd: input.cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "GitWorkflowService.integrateBranches",
            command: "vcs-route",
            cwd: input.cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitCommandError({
        operation: "GitWorkflowService.integrateBranches",
        command: "vcs-route",
        cwd: input.cwd,
        detail:
          "The GitWorkflowService.integrateBranches command currently supports Git repositories only; detected " +
          handle.kind +
          ".",
      });
    }

    const refs = yield* git.listRefs({
      cwd: input.cwd,
      query: input.integrationBranch,
      refKind: "local",
      refresh: true,
    });
    const existing = refs.refs.find((ref) => !ref.isRemote && ref.name === input.integrationBranch);
    const worktreePath =
      existing?.worktreePath ??
      (yield* git.createWorktree({
        cwd: input.cwd,
        refName: existing ? input.integrationBranch : input.baseBranch,
        ...(existing ? {} : { newRefName: input.integrationBranch }),
        path: null,
      })).worktree.path;
    const initialStatus = yield* git.statusDetailsLocal(worktreePath);
    if (initialStatus.hasWorkingTreeChanges) {
      return yield* new GitCommandError({
        operation: "GitWorkflowService.integrateBranches",
        command: "git status",
        cwd: worktreePath,
        detail: "The integration worktree has uncommitted changes.",
      });
    }

    for (const branch of input.branches) {
      const merge = yield* git.execute({
        operation: "GitWorkflowService.integrateBranches",
        cwd: worktreePath,
        args: ["merge", "--no-ff", "--no-edit", branch],
        allowNonZeroExit: true,
      });
      if (merge.exitCode === 0) continue;

      const conflicts = yield* git.execute({
        operation: "GitWorkflowService.integrateBranches.conflicts",
        cwd: worktreePath,
        args: ["diff", "--name-only", "--diff-filter=U", "-z"],
        allowNonZeroExit: true,
      });
      const conflictingFiles = conflicts.stdout.split("\0").filter((path) => path.length > 0);
      const abort = yield* git.execute({
        operation: "GitWorkflowService.integrateBranches.abort",
        cwd: worktreePath,
        args: ["merge", "--abort"],
        allowNonZeroExit: true,
      });

      if (conflictingFiles.length === 0) {
        return yield* new GitCommandError({
          operation: "GitWorkflowService.integrateBranches",
          command: "git merge",
          cwd: worktreePath,
          exitCode: merge.exitCode,
          detail: merge.stderr.trim() || `Could not merge branch ${branch}.`,
        });
      }
      const finalStatus = yield* git.statusDetailsLocal(worktreePath);
      if (abort.exitCode !== 0 || finalStatus.hasWorkingTreeChanges) {
        return yield* new GitCommandError({
          operation: "GitWorkflowService.integrateBranches.abort",
          command: "git merge --abort",
          cwd: worktreePath,
          exitCode: abort.exitCode,
          detail: abort.stderr.trim() || "The conflicted merge could not be cleaned up.",
        });
      }
      return {
        status: "conflict" as const,
        branch: input.integrationBranch,
        worktreePath,
        conflictingBranch: branch,
        conflictingFiles,
      };
    }

    const head = yield* git.execute({
      operation: "GitWorkflowService.integrateBranches.head",
      cwd: worktreePath,
      args: ["rev-parse", "HEAD"],
    });
    return {
      status: "merged" as const,
      branch: input.integrationBranch,
      worktreePath,
      headSha: head.stdout.trim(),
    };
  });

  return TeamBranchIntegration.of({ integrateBranches });
});

export const layer = Layer.effect(TeamBranchIntegration, make);
