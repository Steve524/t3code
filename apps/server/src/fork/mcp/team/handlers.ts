// @effect-diagnostics nodeBuiltinImport:off - lstat detects dangling symlinks before workspace writes.
import * as NodeFSP from "node:fs/promises";

import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationThreadShell,
  type TeamRole,
  type TeamWorkflow,
} from "@t3tools/contracts";
import { deriveLocalBranchNameFromRemoteRef, sanitizeBranchFragment } from "@t3tools/shared/git";
import {
  DEFAULT_PLANS_DIR,
  DEFAULT_RESEARCH_DIR,
  isReadOnlyTeamRoleKind,
  teamReadOnlyLaunch,
} from "@t3tools/shared/team";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as TeamBranchIntegration from "../../git/TeamBranchIntegration.ts";
import * as ThreadBootstrap from "../../orchestration/Services/ThreadBootstrap.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderInstanceRegistry from "../../../provider/Services/ProviderInstanceRegistry.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import { isolatedReadOnlyTask, withPlanText } from "../../provider/teamReadOnly.ts";
import {
  TeamBaseBranchUnavailableError,
  TeamIntegrationBranchOwnershipError,
  TeamIntegrationTargetError,
  TeamIntegrationUnsupportedError,
  TeamOperationFailedError,
  TeamOrchestratorRequiredError,
  TeamPlanFileError,
  TeamPlanArtifactPathError,
  TeamPlanWorkflowRequiredError,
  TeamProjectNotFoundError,
  TeamProviderUnavailableError,
  TeamReviewRoundLimitError,
  TeamRoleDisabledError,
  TeamRoleNotFoundError,
  TeamThreadNotFoundError,
  TeamToolkit,
  TeamWorkerLimitError,
  TeamWorkerNotFoundError,
  TeamWorkerOwnershipError,
  WorkerBusyError,
} from "./tools.ts";

type Operation = TeamOperationFailedError["operation"];

const isRunning = (thread: OrchestrationThreadShell) =>
  thread.session?.status === "starting" ||
  thread.session?.status === "running" ||
  thread.latestTurn?.state === "running";

/**
 * How a role's worker runs. Read-only roles ignore their own runtime mode: where the provider can be
 * held to read-only they share the planner's checkout in its read-only modes; otherwise they get an
 * isolated worktree and the planner's modes (docs/fork/research-plan-team-testing.md, Phase 2).
 */
const workerModes = (
  role: TeamRole,
  orchestrator: OrchestrationThreadShell,
  driverKind: string | undefined,
) => {
  const readOnly = isReadOnlyTeamRoleKind(role.kind);
  const launch = readOnly && driverKind !== undefined ? teamReadOnlyLaunch(driverKind) : null;
  return {
    readOnly,
    sharesCheckout: launch !== null,
    runtimeMode:
      launch?.runtimeMode ??
      (readOnly ? orchestrator.runtimeMode : (role.runtimeMode ?? orchestrator.runtimeMode)),
    interactionMode: launch?.interactionMode ?? orchestrator.interactionMode,
  };
};

const isReadOnlyWorker = (workflow: TeamWorkflow, worker: OrchestrationThreadShell) => {
  const team = worker.team;
  if (team?.role !== "worker") return false;
  const kind = workflow.roles.find((role) => role.id === team.roleId)?.kind;
  return kind !== undefined && isReadOnlyTeamRoleKind(kind);
};

const workerState = (thread: OrchestrationThreadShell) =>
  thread.session?.status ?? thread.latestTurn?.state ?? "idle";

const orchestratorSlug = (threadId: ThreadId) =>
  sanitizeBranchFragment(threadId).replaceAll("/", "-").slice(0, 8);

const workerSummary = (thread: OrchestrationThreadShell) => {
  const team = thread.team;
  if (team?.role !== "worker") return null;
  return {
    workerThreadId: thread.id,
    roleId: team.roleId,
    roleLabel: team.roleLabel,
    taskTitle: team.taskTitle,
    reviewRound: team.reviewRound ?? null,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    state: workerState(thread),
    branch: thread.branch,
    updatedAt: thread.updatedAt,
  };
};

const mapFailure = (operation: Operation) =>
  Effect.mapError((cause: unknown) => new TeamOperationFailedError({ operation, cause }));

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const bootstrap = yield* ThreadBootstrap.ThreadBootstrap;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const integration = yield* TeamBranchIntegration.TeamBranchIntegration;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceFiles = yield* WorkspaceFileSystem.WorkspaceFileSystem;

  const randomId = <A>(makeId: (value: string) => A) =>
    crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(makeId));
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const requireOrchestrator = Effect.fn("TeamToolkit.requireOrchestrator")(function* (
    operation: Operation,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("team");
    const found = yield* snapshots.getThreadShellById(scope.threadId).pipe(mapFailure(operation));
    if (Option.isNone(found)) {
      return yield* new TeamThreadNotFoundError({ threadId: scope.threadId });
    }
    const team = found.value.team;
    if (team?.role !== "orchestrator") {
      return yield* new TeamOrchestratorRequiredError({});
    }
    return { ...found.value, team };
  });

  const requireOwnedWorker = Effect.fn("TeamToolkit.requireOwnedWorker")(function* (
    operation: Operation,
    workerThreadId: ThreadId,
  ) {
    const orchestrator = yield* requireOrchestrator(operation);
    const found = yield* snapshots.getThreadShellById(workerThreadId).pipe(mapFailure(operation));
    if (Option.isNone(found)) {
      return yield* new TeamWorkerNotFoundError({ workerThreadId });
    }
    const worker = found.value;
    if (worker.team?.role !== "worker" || worker.team.orchestratorThreadId !== orchestrator.id) {
      return yield* new TeamWorkerOwnershipError({ workerThreadId });
    }
    return { orchestrator, worker };
  });

  const listWorkers = (orchestratorId: ThreadId, operation: Operation) =>
    snapshots.getShellSnapshot().pipe(
      mapFailure(operation),
      Effect.map((snapshot) =>
        snapshot.threads.filter(
          (thread) =>
            thread.team?.role === "worker" && thread.team.orchestratorThreadId === orchestratorId,
        ),
      ),
    );

  const defaultBranch = Effect.fn("TeamToolkit.defaultBranch")(function* (
    projectCwd: string,
    operation: Operation,
  ) {
    const refs = yield* git
      .listRefs({ cwd: projectCwd, refKind: "all" })
      .pipe(mapFailure(operation));
    const ref = refs.refs.find((candidate) => candidate.isDefault && !candidate.isRemote);
    const fallback = refs.refs.find((candidate) => candidate.isDefault);
    if (ref) return ref.name;
    if (fallback) {
      return deriveLocalBranchNameFromRemoteRef(fallback.name);
    }
    return yield* new TeamBaseBranchUnavailableError({});
  });

  const plannerCwd = Effect.fn("TeamToolkit.plannerCwd")(function* (
    orchestrator: OrchestrationThreadShell,
    operation: Operation,
  ) {
    if (orchestrator.worktreePath !== null) return orchestrator.worktreePath;
    const project = yield* snapshots
      .getProjectShellById(orchestrator.projectId)
      .pipe(mapFailure(operation));
    if (Option.isNone(project)) return yield* new TeamProjectNotFoundError({});
    return project.value.workspaceRoot;
  });

  /** Reads a plan file from the planner's checkout, for a reviewer that can't see it. */
  const readPlan = Effect.fn("TeamToolkit.readPlan")(function* (cwd: string, planPath: string) {
    const relative = path.relative(cwd, path.resolve(cwd, planPath));
    if (
      path.isAbsolute(planPath) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return yield* new TeamPlanFileError({ planPath, reason: "outside-checkout" });
    }
    const text = yield* fileSystem
      .readFileString(path.join(cwd, relative))
      .pipe(Effect.mapError(() => new TeamPlanFileError({ planPath, reason: "unreadable" })));
    return { path: planPath, text };
  });

  return TeamToolkit.of({
    team_write_plan_artifact: (input) =>
      Effect.gen(function* () {
        const orchestrator = yield* requireOrchestrator("write");
        const workflow = orchestrator.team.workflow;
        if (workflow.type !== "plan") return yield* new TeamPlanWorkflowRequiredError({});
        const requested = input.relativePath.replaceAll("\\", "/");
        if (
          requested.startsWith("/") ||
          /[:\p{Cc}]/u.test(requested) ||
          requested
            .split("/")
            .some((segment) => segment === ".." || (segment !== "." && /[. ]$/.test(segment)))
        ) {
          return yield* new TeamPlanArtifactPathError({
            relativePath: input.relativePath,
            reason: "invalid-path",
          });
        }
        const cwd = yield* plannerCwd(orchestrator, "write");
        const normalize = (relative: string) =>
          path
            .relative(cwd, path.resolve(cwd, relative.replaceAll("\\", "/")))
            .replaceAll("\\", "/");
        const relativePath = normalize(requested);
        const folders = [
          workflow.plansDir ?? DEFAULT_PLANS_DIR,
          workflow.researchDir ?? DEFAULT_RESEARCH_DIR,
          "docs/adr",
        ].map(normalize);
        if (
          !relativePath.endsWith(".md") ||
          (!folders.some((folder) => relativePath.startsWith(`${folder}/`)) &&
            !["CONTEXT.md", "CONTEXT-MAP.md"].includes(path.basename(relativePath)))
        ) {
          return yield* new TeamPlanArtifactPathError({
            relativePath: input.relativePath,
            reason: "outside-allowlist",
          });
        }

        // Check every component, including a missing target's parents and dangling links.
        let current = cwd;
        for (const segment of relativePath.split("/")) {
          current = path.join(current, segment);
          const stat = yield* Effect.tryPromise({
            try: async () => {
              try {
                return await NodeFSP.lstat(current);
              } catch (cause) {
                if (Predicate.hasProperty(cause, "code") && cause.code === "ENOENT") return null;
                throw cause;
              }
            },
            catch: (cause) => new TeamOperationFailedError({ operation: "write", cause }),
          });
          if (stat?.isSymbolicLink()) {
            return yield* new TeamPlanArtifactPathError({
              relativePath: input.relativePath,
              reason: "symlink",
            });
          }
        }
        return yield* workspaceFiles
          .writeFile({ cwd, relativePath, contents: input.contents })
          .pipe(mapFailure("write"));
      }),

    team_roster: () =>
      Effect.gen(function* () {
        const orchestrator = yield* requireOrchestrator("roster");
        const workers = yield* listWorkers(orchestrator.id, "roster");
        const workflow = orchestrator.team.workflow;
        const roles = yield* Effect.forEach(
          workflow.roles.filter((role) => role.enabled),
          (role) =>
            Effect.gen(function* () {
              const modelSelection = role.modelSelection ?? orchestrator.modelSelection;
              const provider = yield* providers.getInstance(modelSelection.instanceId);
              return {
                id: role.id,
                label: role.label,
                kind: role.kind,
                summary: role.summary,
                modelSelection,
                runtimeMode: workerModes(role, orchestrator, provider?.driverKind).runtimeMode,
              };
            }),
        );
        return {
          roles,
          limits: {
            maxParallelWorkers: workflow.maxParallelWorkers,
            maxReviewRounds: workflow.maxReviewRounds,
          },
          workers: workers.flatMap((worker) => {
            const summary = workerSummary(worker);
            return summary ? [summary] : [];
          }),
        };
      }),

    team_spawn_worker: (input) =>
      Effect.gen(function* () {
        const orchestrator = yield* requireOrchestrator("spawn");
        const workflow = orchestrator.team.workflow;
        const role = workflow.roles.find((candidate) => candidate.id === input.roleId);
        if (!role) return yield* new TeamRoleNotFoundError({ roleId: input.roleId });
        if (!role.enabled) return yield* new TeamRoleDisabledError({ roleId: input.roleId });
        if (
          (role.kind === "reviewer" || role.kind === "plan-reviewer") &&
          input.reviewRound !== undefined &&
          input.reviewRound > workflow.maxReviewRounds
        ) {
          return yield* new TeamReviewRoundLimitError({
            limit: workflow.maxReviewRounds,
            reviewRound: input.reviewRound,
          });
        }

        const workers = yield* listWorkers(orchestrator.id, "spawn");
        if (workers.filter(isRunning).length >= workflow.maxParallelWorkers) {
          return yield* new TeamWorkerLimitError({ limit: workflow.maxParallelWorkers });
        }

        const modelSelection = role.modelSelection ?? orchestrator.modelSelection;
        const provider = yield* providers.getInstance(modelSelection.instanceId);
        if (!provider?.enabled) {
          return yield* new TeamProviderUnavailableError({
            instanceId: modelSelection.instanceId,
          });
        }

        const project = yield* snapshots
          .getProjectShellById(orchestrator.projectId)
          .pipe(mapFailure("spawn"));
        if (Option.isNone(project)) return yield* new TeamProjectNotFoundError({});

        const { readOnly, sharesCheckout, runtimeMode, interactionMode } = workerModes(
          role,
          orchestrator,
          provider.driverKind,
        );
        const baseBranch = sharesCheckout
          ? orchestrator.branch
          : (input.baseBranch ??
            orchestrator.branch ??
            (yield* defaultBranch(project.value.workspaceRoot, "spawn")));
        const workerThreadId = yield* randomId(ThreadId.make);
        // ponytail: Short refs leave room for deep Windows checkout paths; deeper homes need Git long-path support.
        const roleSlug = sanitizeBranchFragment(role.id).replaceAll("/", "-").slice(0, 8);
        const branch = sharesCheckout
          ? null
          : `team/${orchestratorSlug(orchestrator.id)}/${roleSlug}-${workerThreadId.slice(0, 8)}`;
        const messageId = yield* randomId(MessageId.make);
        const commandId = yield* randomId((id) => CommandId.make(`server:team-spawn:${id}`));
        const createdAt = yield* nowIso;
        const isolatedBase = readOnly && !sharesCheckout ? baseBranch : null;
        let text = input.task;
        if (isolatedBase !== null) {
          text = isolatedReadOnlyTask(text, isolatedBase);
          if (input.planPath !== undefined) {
            const cwd = orchestrator.worktreePath ?? project.value.workspaceRoot;
            text = withPlanText(text, yield* readPlan(cwd, input.planPath));
          }
        }

        yield* bootstrap
          .dispatch({
            type: "thread.turn.start",
            commandId,
            threadId: workerThreadId,
            message: {
              messageId,
              role: "user",
              text,
              attachments: [],
            },
            modelSelection,
            titleSeed: input.title,
            runtimeMode,
            interactionMode,
            bootstrap: {
              createThread: {
                projectId: orchestrator.projectId,
                title: input.title,
                modelSelection,
                runtimeMode,
                interactionMode,
                branch: baseBranch,
                worktreePath: sharesCheckout ? orchestrator.worktreePath : null,
                team: {
                  role: "worker",
                  orchestratorThreadId: orchestrator.id,
                  roleId: role.id,
                  roleLabel: role.label,
                  taskTitle: input.title,
                  ...(input.reviewRound === undefined ? {} : { reviewRound: input.reviewRound }),
                },
                createdAt,
              },
              ...(branch === null || baseBranch === null
                ? {}
                : {
                    prepareWorktree: {
                      projectCwd: project.value.workspaceRoot,
                      baseBranch,
                      branch,
                    },
                  }),
              runSetupScript: !readOnly,
            },
            createdAt,
          })
          .pipe(mapFailure("spawn"));

        return { workerThreadId, branch };
      }),

    team_get_worker: ({ workerThreadId }) =>
      Effect.gen(function* () {
        const { orchestrator, worker } = yield* requireOwnedWorker("get", workerThreadId);
        const detail = yield* snapshots.getThreadDetailById(worker.id).pipe(mapFailure("get"));
        if (Option.isNone(detail)) return yield* new TeamWorkerNotFoundError({ workerThreadId });
        const team = worker.team;
        if (team?.role !== "worker") {
          return yield* new TeamWorkerOwnershipError({ workerThreadId });
        }
        const latestCheckpoint = detail.value.checkpoints.at(-1);
        const diffStats = (latestCheckpoint?.files ?? []).reduce(
          (total, file) => ({
            files: total.files + 1,
            additions: total.additions + file.additions,
            deletions: total.deletions + file.deletions,
          }),
          { files: 0, additions: 0, deletions: 0 },
        );
        const lastAssistantMessage = detail.value.messages.findLast(
          (message) => message.role === "assistant" && !message.streaming,
        );
        return {
          ...workerSummary(worker)!,
          worktreePath: worker.worktreePath,
          lastAssistantMessage:
            lastAssistantMessage === undefined ? null : lastAssistantMessage.text.slice(0, 4_000),
          diffStats: isReadOnlyWorker(orchestrator.team.workflow, worker) ? null : diffStats,
          hasPendingApprovals: worker.hasPendingApprovals,
          hasPendingUserInput: worker.hasPendingUserInput,
          pullRequests: visibleThreadPullRequests(detail.value.pullRequests),
        };
      }),

    team_message_worker: ({ workerThreadId, message, planPath }) =>
      Effect.gen(function* () {
        const { orchestrator, worker } = yield* requireOwnedWorker("message", workerThreadId);
        if (isRunning(worker)) return yield* new WorkerBusyError({ workerThreadId });
        const isolated =
          isReadOnlyWorker(orchestrator.team.workflow, worker) &&
          worker.worktreePath !== orchestrator.worktreePath;
        const text =
          isolated && planPath !== undefined
            ? withPlanText(
                message,
                yield* readPlan(yield* plannerCwd(orchestrator, "message"), planPath),
              )
            : message;
        const createdAt = yield* nowIso;
        yield* bootstrap
          .dispatch({
            type: "thread.turn.start",
            commandId: yield* randomId((id) => CommandId.make(`server:team-message:${id}`)),
            threadId: worker.id,
            message: {
              messageId: yield* randomId(MessageId.make),
              role: "user",
              text,
              attachments: [],
            },
            modelSelection: worker.modelSelection,
            runtimeMode: worker.runtimeMode,
            interactionMode: worker.interactionMode,
            createdAt,
          })
          .pipe(mapFailure("message"));
        return { workerThreadId };
      }),

    team_stop_worker: ({ workerThreadId }) =>
      Effect.gen(function* () {
        const { worker } = yield* requireOwnedWorker("stop", workerThreadId);
        yield* engine
          .dispatch({
            type: "thread.session.stop",
            commandId: yield* randomId((id) => CommandId.make(`server:team-stop:${id}`)),
            threadId: worker.id,
            createdAt: yield* nowIso,
          })
          .pipe(mapFailure("stop"));
        return { workerThreadId };
      }),

    team_integrate: (input) =>
      Effect.gen(function* () {
        const orchestrator = yield* requireOrchestrator("integrate");
        if (orchestrator.team.workflow.type === "plan") {
          return yield* new TeamIntegrationUnsupportedError({});
        }
        const project = yield* snapshots
          .getProjectShellById(orchestrator.projectId)
          .pipe(mapFailure("integrate"));
        if (Option.isNone(project)) return yield* new TeamProjectNotFoundError({});

        const baseBranch =
          orchestrator.branch ?? (yield* defaultBranch(project.value.workspaceRoot, "integrate"));
        const integrationBranch =
          input.targetBranch ?? `team/${orchestratorSlug(orchestrator.id)}/integration`;
        if (integrationBranch === baseBranch) {
          return yield* new TeamIntegrationTargetError({ branch: baseBranch });
        }

        const workers = yield* listWorkers(orchestrator.id, "integrate");
        for (const branch of input.branches) {
          if (!workers.some((worker) => worker.branch === branch)) {
            return yield* new TeamIntegrationBranchOwnershipError({ branch });
          }
        }

        const result = yield* integration
          .integrateBranches({
            cwd: project.value.workspaceRoot,
            baseBranch,
            integrationBranch,
            branches: input.branches,
          })
          .pipe(mapFailure("integrate"));
        return result.status === "merged"
          ? { status: result.status, branch: result.branch, headSha: result.headSha }
          : {
              status: result.status,
              branch: result.branch,
              conflictingBranch: result.conflictingBranch,
              conflictingFiles: result.conflictingFiles,
            };
      }),
  });
});

export const TeamToolkitHandlersLive = TeamToolkit.toLayer(make);
