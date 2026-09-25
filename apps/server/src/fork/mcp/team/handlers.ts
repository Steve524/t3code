import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { deriveLocalBranchNameFromRemoteRef, sanitizeBranchFragment } from "@t3tools/shared/git";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as TeamBranchIntegration from "../../git/TeamBranchIntegration.ts";
import * as ThreadBootstrap from "../../orchestration/Services/ThreadBootstrap.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderInstanceRegistry from "../../../provider/Services/ProviderInstanceRegistry.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ServerConfig from "../../../config.ts";
import { writeTeamArtifact } from "./artifacts.ts";
import { completedTurnResult, pageResult } from "./results.ts";
import {
  TeamArtifact,
  TeamBaseBranchUnavailableError,
  TeamIntegrationBranchOwnershipError,
  TeamIntegrationTargetError,
  TeamOperationFailedError,
  TeamNotesDestinationRequiredError,
  TeamOrchestratorRequiredError,
  TeamProjectNotFoundError,
  TeamProviderUnavailableError,
  TeamReviewRoundLimitError,
  TeamRoleDisabledError,
  TeamRoleNotFoundError,
  TeamResultCursorError,
  TeamThreadNotFoundError,
  TeamToolkit,
  TeamWorkerLimitError,
  TeamWorkerNotFoundError,
  TeamWorkerOwnershipError,
  TeamWorkerResultUnavailableError,
  WorkerBusyError,
} from "./tools.ts";

type Operation = TeamOperationFailedError["operation"];

const isRunning = (thread: OrchestrationThreadShell) =>
  thread.session?.status === "starting" ||
  thread.session?.status === "running" ||
  thread.latestTurn?.state === "running";

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
  const config = yield* ServerConfig.ServerConfig;

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

  const requireCompletedResult = Effect.fn("TeamToolkit.requireCompletedResult")(function* (
    workerThreadId: ThreadId,
    turnId: Parameters<typeof completedTurnResult>[1],
    operation: Operation,
  ) {
    const { orchestrator, worker } = yield* requireOwnedWorker(operation, workerThreadId);
    // ponytail: This rereads the worker's full message history per page; add a targeted message query if long-lived teams make retrieval slow.
    const detail = yield* snapshots
      .getThreadDetailById(worker.id, { activityKinds: [] })
      .pipe(mapFailure(operation));
    if (Option.isNone(detail)) return yield* new TeamWorkerNotFoundError({ workerThreadId });
    const message = completedTurnResult(detail.value, turnId);
    if (message === null) {
      return yield* new TeamWorkerResultUnavailableError({ workerThreadId, turnId });
    }
    return { orchestrator, message };
  });

  return TeamToolkit.of({
    team_roster: () =>
      Effect.gen(function* () {
        const orchestrator = yield* requireOrchestrator("roster");
        const workers = yield* listWorkers(orchestrator.id, "roster");
        const workflow = orchestrator.team.workflow;
        return {
          roles: workflow.roles
            .filter((role) => role.enabled)
            .map((role) => ({
              id: role.id,
              label: role.label,
              kind: role.kind,
              summary: role.summary,
              modelSelection: role.modelSelection ?? orchestrator.modelSelection,
              runtimeMode: role.runtimeMode ?? orchestrator.runtimeMode,
            })),
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
          role.kind === "reviewer" &&
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

        const baseBranch =
          input.baseBranch ??
          orchestrator.branch ??
          (yield* defaultBranch(project.value.workspaceRoot, "spawn"));
        const workerThreadId = yield* randomId(ThreadId.make);
        // ponytail: Short refs leave room for deep Windows checkout paths; deeper homes need Git long-path support.
        const roleSlug = sanitizeBranchFragment(role.id).replaceAll("/", "-").slice(0, 8);
        const branch = `team/${orchestratorSlug(orchestrator.id)}/${roleSlug}-${workerThreadId.slice(0, 8)}`;
        const messageId = yield* randomId(MessageId.make);
        const commandId = yield* randomId((id) => CommandId.make(`server:team-spawn:${id}`));
        const createdAt = yield* nowIso;
        const runtimeMode = role.runtimeMode ?? orchestrator.runtimeMode;

        yield* bootstrap
          .dispatch({
            type: "thread.turn.start",
            commandId,
            threadId: workerThreadId,
            message: {
              messageId,
              role: "user",
              text: input.task,
              attachments: [],
            },
            modelSelection,
            titleSeed: input.title,
            runtimeMode,
            interactionMode: orchestrator.interactionMode,
            bootstrap: {
              createThread: {
                projectId: orchestrator.projectId,
                title: input.title,
                modelSelection,
                runtimeMode,
                interactionMode: orchestrator.interactionMode,
                branch: baseBranch,
                worktreePath: null,
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
              prepareWorktree: {
                projectCwd: project.value.workspaceRoot,
                baseBranch,
                branch,
              },
              runSetupScript: true,
            },
            createdAt,
          })
          .pipe(mapFailure("spawn"));

        return { workerThreadId, branch };
      }),

    team_get_worker: ({ workerThreadId }) =>
      Effect.gen(function* () {
        const { worker } = yield* requireOwnedWorker("get", workerThreadId);
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
          diffStats,
          hasPendingApprovals: worker.hasPendingApprovals,
          hasPendingUserInput: worker.hasPendingUserInput,
          pullRequests: visibleThreadPullRequests(detail.value.pullRequests),
        };
      }),

    team_get_worker_result: ({ workerThreadId, turnId, cursor = 0 }) =>
      Effect.gen(function* () {
        const { message } = yield* requireCompletedResult(workerThreadId, turnId, "result");
        const page = pageResult(message.text, cursor);
        if (page === null) return yield* new TeamResultCursorError({ cursor });
        return {
          workerThreadId,
          turnId,
          messageId: message.id,
          turnCompleted: true as const,
          ...page,
        };
      }),

    team_export_worker_result: ({ workerThreadId, turnId, kind, destination }) =>
      Effect.gen(function* () {
        if (kind === "research" && destination === undefined) {
          return yield* new TeamNotesDestinationRequiredError({});
        }
        const scope = yield* McpInvocationContext.requireMcpCapability("team");
        const { orchestrator, message } = yield* requireCompletedResult(
          workerThreadId,
          turnId,
          "export",
        );
        const project = yield* snapshots
          .getProjectShellById(orchestrator.projectId)
          .pipe(mapFailure("export"));
        if (Option.isNone(project)) return yield* new TeamProjectNotFoundError({});
        const createdAt = yield* nowIso;
        const saved = yield* Effect.tryPromise(() =>
          writeTeamArtifact({
            environmentId: scope.environmentId,
            threadId: orchestrator.id,
            projectRoot: project.value.workspaceRoot,
            title: orchestrator.title,
            kind,
            destination: destination ?? { kind: "temporary" },
            content: message.text,
            attachmentsDir: config.attachmentsDir,
            date: createdAt,
          }),
        ).pipe(mapFailure("export"));
        const artifact = {
          ...saved,
          kind,
          sourceWorkerThreadId: workerThreadId,
          sourceTurnId: turnId,
          sourceMessageId: message.id,
          createdAt,
        };
        yield* engine
          .dispatch({
            type: "thread.activity.append",
            commandId: yield* randomId((id) => CommandId.make(`server:team-artifact:${id}`)),
            threadId: orchestrator.id,
            activity: {
              id: yield* randomId(EventId.make),
              tone: "info",
              kind: "team.artifact.exported",
              summary: `Saved ${kind} artifact`,
              payload: artifact,
              turnId: null,
              createdAt,
            },
            createdAt,
          })
          .pipe(mapFailure("export"));
        return artifact;
      }),

    team_list_artifacts: () =>
      Effect.gen(function* () {
        const orchestrator = yield* requireOrchestrator("artifacts");
        const detail = yield* snapshots
          .getThreadDetailById(orchestrator.id, { activityKinds: ["team.artifact.exported"] })
          .pipe(mapFailure("artifacts"));
        if (Option.isNone(detail)) {
          return yield* new TeamThreadNotFoundError({ threadId: orchestrator.id });
        }
        const decode = Schema.decodeUnknownOption(TeamArtifact);
        return {
          artifacts: detail.value.activities.flatMap((activity) =>
            activity.kind === "team.artifact.exported"
              ? Option.match(decode(activity.payload), {
                  onNone: () => [],
                  onSome: (artifact) => [artifact],
                })
              : [],
          ),
        };
      }),

    team_message_worker: ({ workerThreadId, message }) =>
      Effect.gen(function* () {
        const { worker } = yield* requireOwnedWorker("message", workerThreadId);
        if (isRunning(worker)) return yield* new WorkerBusyError({ workerThreadId });
        const createdAt = yield* nowIso;
        yield* bootstrap
          .dispatch({
            type: "thread.turn.start",
            commandId: yield* randomId((id) => CommandId.make(`server:team-message:${id}`)),
            threadId: worker.id,
            message: {
              messageId: yield* randomId(MessageId.make),
              role: "user",
              text: message,
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
