import {
  EnvironmentId,
  CheckpointRef,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  TeamRoleId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type TeamWorkflow,
} from "@t3tools/contracts";
import { BUILT_IN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ThreadBootstrap from "../../orchestration/Services/ThreadBootstrap.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderInstance } from "../../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../../provider/Services/ProviderInstanceRegistry.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { TeamToolkitHandlersLive } from "./handlers.ts";
import { TeamToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-team");
const ORCHESTRATOR_ID = ThreadId.make("thread-team-orchestrator");
const WORKER_ID = ThreadId.make("thread-team-worker");
const HOST_INSTANCE_ID = ProviderInstanceId.make("codex-host");
const ROLE_INSTANCE_ID = ProviderInstanceId.make("claude-work");

const workflow = (overrides: Partial<TeamWorkflow> = {}): TeamWorkflow => ({
  ...BUILT_IN_TEAM_WORKFLOW,
  roles: BUILT_IN_TEAM_WORKFLOW.roles.map((role) =>
    role.id === TeamRoleId.make("frontend")
      ? {
          ...role,
          modelSelection: {
            instanceId: ROLE_INSTANCE_ID,
            model: "claude-sonnet",
            options: [{ id: "effort", value: "high" }],
          },
          runtimeMode: "approval-required",
        }
      : role,
  ),
  ...overrides,
});

function shell(
  input: Partial<OrchestrationThreadShell> & Pick<OrchestrationThreadShell, "id" | "team">,
): OrchestrationThreadShell {
  return {
    projectId: PROJECT_ID,
    title: "Team thread",
    modelSelection: { instanceId: HOST_INSTANCE_ID, model: "gpt-host" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

const orchestrator = (teamWorkflow = workflow()) =>
  shell({
    id: ORCHESTRATOR_ID,
    title: "Ship the feature",
    team: { role: "orchestrator", workflow: teamWorkflow },
  });

const worker = (
  overrides: Partial<OrchestrationThreadShell> = {},
  orchestratorThreadId = ORCHESTRATOR_ID,
) =>
  shell({
    id: WORKER_ID,
    title: "Build UI",
    modelSelection: {
      instanceId: ROLE_INSTANCE_ID,
      model: "claude-sonnet",
      options: [{ id: "effort", value: "high" }],
    },
    runtimeMode: "approval-required",
    branch: "team/thread-t/frontend-build-ui",
    worktreePath: "/workspace/project-worker",
    team: {
      role: "worker",
      orchestratorThreadId,
      roleId: TeamRoleId.make("frontend"),
      roleLabel: "Frontend",
      taskTitle: "Build UI",
    },
    ...overrides,
  });

function detail(thread: OrchestrationThreadShell): OrchestrationThread {
  return {
    ...thread,
    messages: [
      {
        id: MessageId.make("assistant-worker"),
        role: "assistant",
        text: "Done.",
        turnId: TurnId.make("turn-worker"),
        streaming: false,
        createdAt: "2026-09-15T10:01:00.000Z",
        updatedAt: "2026-09-15T10:01:00.000Z",
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [
      {
        turnId: TurnId.make("turn-worker"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-team-worker/1"),
        status: "ready",
        files: [{ path: "src/ui.ts", kind: "modified", additions: 8, deletions: 3 }],
        assistantMessageId: MessageId.make("assistant-worker"),
        completedAt: "2026-09-15T10:01:00.000Z",
      },
    ],
    deletedAt: null,
  };
}

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["team"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-team"),
  threadId: ORCHESTRATOR_ID,
  providerSessionId: "provider-session-team",
  providerInstanceId: HOST_INSTANCE_ID,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

interface HarnessOptions {
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly providerAvailable?: boolean;
  readonly integrateResult?: GitWorkflowService.GitIntegrateBranchesResult;
}

const makeHarness = Effect.fn("makeTeamToolkitHarness")(function* (options: HarnessOptions = {}) {
  const threads = options.threads ?? [orchestrator()];
  const bootstrapCommands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const engineCommands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const integrationInputs = yield* Ref.make<
    ReadonlyArray<GitWorkflowService.GitIntegrateBranchesInput>
  >([]);
  const recordBootstrap: ThreadBootstrap.ThreadBootstrapShape["dispatch"] = (command) =>
    Ref.update(bootstrapCommands, (commands) => [...commands, command]).pipe(
      Effect.as({ sequence: 1 }),
    );
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Ref.update(engineCommands, (commands) => [...commands, command]).pipe(
      Effect.as({ sequence: 1 }),
    );
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(Option.fromNullishOr(threads.find((thread) => thread.id === threadId))),
      getProjectShellById: (projectId) =>
        Effect.succeed(
          projectId === PROJECT_ID
            ? Option.some({
                id: PROJECT_ID,
                title: "Project",
                workspaceRoot: "/workspace/project",
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-09-15T10:00:00.000Z",
                updatedAt: "2026-09-15T10:00:00.000Z",
              })
            : Option.none(),
        ),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [],
          threads,
          updatedAt: "2026-09-15T10:00:00.000Z",
        }),
      getThreadDetailById: (threadId) =>
        Effect.succeed(
          Option.fromNullishOr(threads.find((thread) => thread.id === threadId)).pipe(
            Option.map(detail),
          ),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.mock(ThreadBootstrap.ThreadBootstrap)({ dispatch: recordBootstrap }),
    Layer.mock(ProviderInstanceRegistry)({
      getInstance: () =>
        Effect.succeed(
          options.providerAvailable === false ? undefined : ({ enabled: true } as ProviderInstance),
        ),
    }),
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      listRefs: () =>
        Effect.succeed({
          refs: [
            {
              name: "main",
              current: true,
              isDefault: true,
              worktreePath: "/workspace/project",
            },
          ],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 1,
        }),
      integrateBranches: (input) =>
        Ref.update(integrationInputs, (inputs) => [...inputs, input]).pipe(
          Effect.as(
            options.integrateResult ?? {
              status: "merged",
              branch: "team/thread-t/integration",
              worktreePath: "/workspace/integration",
              headSha: "abc123",
            },
          ),
        ),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* TeamToolkit.pipe(
    Effect.provide(TeamToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof TeamToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["team"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!.result as Tool.Success<(typeof TeamToolkit.tools)[Name]>),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );
  return { bootstrapCommands, engineCommands, integrationInputs, call };
});

describe("team toolkit handlers", () => {
  it.effect("spawns a worker with the resolved role settings and worktree bootstrap", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("team_spawn_worker", {
        roleId: TeamRoleId.make("frontend"),
        title: "Build UI",
        task: "Implement the settings form.",
      });
      expect(result.branch).toBe("team/thread-t/frontend-build-ui");
      const command = (yield* Ref.get(harness.bootstrapCommands))[0];
      expect(command).toMatchObject({
        type: "thread.turn.start",
        message: { text: "Implement the settings form." },
        modelSelection: {
          instanceId: ROLE_INSTANCE_ID,
          model: "claude-sonnet",
          options: [{ id: "effort", value: "high" }],
        },
        runtimeMode: "approval-required",
        bootstrap: {
          createThread: {
            projectId: PROJECT_ID,
            title: "Build UI",
            branch: "main",
            worktreePath: null,
            team: {
              role: "worker",
              orchestratorThreadId: ORCHESTRATOR_ID,
              roleId: "frontend",
              roleLabel: "Frontend",
              taskTitle: "Build UI",
            },
          },
          prepareWorktree: {
            projectCwd: "/workspace/project",
            baseBranch: "main",
            branch: "team/thread-t/frontend-build-ui",
          },
          runSetupScript: true,
        },
      });

      yield* harness.call("team_spawn_worker", {
        roleId: TeamRoleId.make("backend"),
        title: "Build API",
        task: "Implement the endpoint.",
      });
      expect((yield* Ref.get(harness.bootstrapCommands))[1]).toMatchObject({
        modelSelection: { instanceId: HOST_INSTANCE_ID, model: "gpt-host" },
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("lists resolved roles and owned workers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ threads: [orchestrator(), worker()] });
      const result = yield* harness.call("team_roster", {});
      expect(result.limits).toEqual({ maxParallelWorkers: 4, maxReviewRounds: 2 });
      expect(result.roles.find((role) => role.id === TeamRoleId.make("frontend"))).toMatchObject({
        modelSelection: { instanceId: ROLE_INSTANCE_ID, model: "claude-sonnet" },
        runtimeMode: "approval-required",
      });
      expect(result.workers).toMatchObject([
        {
          workerThreadId: WORKER_ID,
          roleId: "frontend",
          branch: "team/thread-t/frontend-build-ui",
          state: "idle",
        },
      ]);
    }),
  );

  it.effect("fails instead of replacing an unavailable provider instance", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ providerAvailable: false });
      const error = yield* harness
        .call("team_spawn_worker", {
          roleId: TeamRoleId.make("frontend"),
          title: "Build UI",
          task: "Implement it.",
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "TeamProviderUnavailableError",
        instanceId: ROLE_INSTANCE_ID,
      });
      expect(yield* Ref.get(harness.bootstrapCommands)).toEqual([]);
    }),
  );

  it.effect("enforces parallel worker, disabled role, and review round limits", () =>
    Effect.gen(function* () {
      const runningWorker = worker({
        session: {
          threadId: WORKER_ID,
          status: "running",
          providerName: "Claude",
          providerInstanceId: ROLE_INSTANCE_ID,
          runtimeMode: "approval-required",
          activeTurnId: TurnId.make("turn-running"),
          lastError: null,
          updatedAt: "2026-09-15T10:00:00.000Z",
        },
      });
      const limited = yield* makeHarness({
        threads: [orchestrator(workflow({ maxParallelWorkers: 1 })), runningWorker],
      });
      expect(
        yield* limited
          .call("team_spawn_worker", {
            roleId: TeamRoleId.make("frontend"),
            title: "Second worker",
            task: "Implement it.",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "TeamWorkerLimitError", limit: 1 });

      const disabled = workflow({
        roles: workflow().roles.map((role) =>
          role.id === TeamRoleId.make("frontend") ? { ...role, enabled: false } : role,
        ),
      });
      const disabledHarness = yield* makeHarness({ threads: [orchestrator(disabled)] });
      expect(
        yield* disabledHarness
          .call("team_spawn_worker", {
            roleId: TeamRoleId.make("frontend"),
            title: "Disabled",
            task: "Implement it.",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "TeamRoleDisabledError" });

      const reviewHarness = yield* makeHarness({
        threads: [orchestrator(workflow({ maxReviewRounds: 1 }))],
      });
      expect(
        yield* reviewHarness
          .call("team_spawn_worker", {
            roleId: TeamRoleId.make("qa"),
            title: "Review",
            task: "Review it.",
            reviewRound: 2,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "TeamReviewRoundLimitError", limit: 1, reviewRound: 2 });

      yield* reviewHarness.call("team_spawn_worker", {
        roleId: TeamRoleId.make("qa"),
        title: "Review integration",
        task: "Review the integrated changes.",
        baseBranch: "team/thread-t/integration",
        reviewRound: 1,
      });
      expect((yield* Ref.get(reviewHarness.bootstrapCommands))[0]).toMatchObject({
        bootstrap: {
          createThread: {
            branch: "team/thread-t/integration",
            team: { roleId: "qa", reviewRound: 1 },
          },
          prepareWorktree: { baseBranch: "team/thread-t/integration" },
        },
      });
    }),
  );

  it.effect("rejects messaging a running worker", () =>
    Effect.gen(function* () {
      const running = worker({
        latestTurn: {
          turnId: TurnId.make("turn-running"),
          state: "running",
          requestedAt: "2026-09-15T10:00:00.000Z",
          startedAt: "2026-09-15T10:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      });
      const harness = yield* makeHarness({ threads: [orchestrator(), running] });
      const error = yield* harness
        .call("team_message_worker", {
          workerThreadId: WORKER_ID,
          message: "Please revise it.",
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "WorkerBusyError", workerThreadId: WORKER_ID });
      expect(yield* Ref.get(harness.bootstrapCommands)).toEqual([]);
    }),
  );

  it.effect("enforces ownership for every worker-specific tool", () =>
    Effect.gen(function* () {
      const foreign = worker({}, ThreadId.make("other-orchestrator"));
      const harness = yield* makeHarness({ threads: [orchestrator(), foreign] });
      const getError = yield* harness
        .call("team_get_worker", { workerThreadId: WORKER_ID })
        .pipe(Effect.flip);
      const messageError = yield* harness
        .call("team_message_worker", { workerThreadId: WORKER_ID, message: "Continue." })
        .pipe(Effect.flip);
      const stopError = yield* harness
        .call("team_stop_worker", { workerThreadId: WORKER_ID })
        .pipe(Effect.flip);
      expect([getError, messageError, stopError].map((error) => error._tag)).toEqual([
        "TeamWorkerOwnershipError",
        "TeamWorkerOwnershipError",
        "TeamWorkerOwnershipError",
      ]);
      expect(yield* Ref.get(harness.bootstrapCommands)).toEqual([]);
      expect(yield* Ref.get(harness.engineCommands)).toEqual([]);
    }),
  );

  it.effect("returns worker details and dispatches message and stop commands", () =>
    Effect.gen(function* () {
      const ownedWorker = worker();
      const harness = yield* makeHarness({ threads: [orchestrator(), ownedWorker] });
      const result = yield* harness.call("team_get_worker", { workerThreadId: WORKER_ID });
      expect(result).toMatchObject({
        workerThreadId: WORKER_ID,
        worktreePath: "/workspace/project-worker",
        lastAssistantMessage: "Done.",
        diffStats: { files: 1, additions: 8, deletions: 3 },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      });
      yield* harness.call("team_message_worker", {
        workerThreadId: WORKER_ID,
        message: "Please revise it.",
      });
      yield* harness.call("team_stop_worker", { workerThreadId: WORKER_ID });
      expect(yield* Ref.get(harness.bootstrapCommands)).toMatchObject([
        { type: "thread.turn.start", threadId: WORKER_ID, message: { text: "Please revise it." } },
      ]);
      expect(yield* Ref.get(harness.engineCommands)).toMatchObject([
        { type: "thread.session.stop", threadId: WORKER_ID },
      ]);
    }),
  );

  it.effect("integrates owned worker branches in order without targeting the base branch", () =>
    Effect.gen(function* () {
      const ownedWorker = worker();
      const harness = yield* makeHarness({ threads: [orchestrator(), ownedWorker] });
      const result = yield* harness.call("team_integrate", {
        branches: ["team/thread-t/frontend-build-ui"],
      });

      expect(result).toEqual({
        status: "merged",
        branch: "team/thread-t/integration",
        headSha: "abc123",
      });
      expect(yield* Ref.get(harness.integrationInputs)).toEqual([
        {
          cwd: "/workspace/project",
          baseBranch: "main",
          integrationBranch: "team/thread-t/integration",
          branches: ["team/thread-t/frontend-build-ui"],
        },
      ]);

      const foreign = yield* harness
        .call("team_integrate", { branches: ["feature/not-owned"] })
        .pipe(Effect.flip);
      expect(foreign).toMatchObject({
        _tag: "TeamIntegrationBranchOwnershipError",
        branch: "feature/not-owned",
      });

      const baseTarget = yield* harness
        .call("team_integrate", {
          branches: ["team/thread-t/frontend-build-ui"],
          targetBranch: "main",
        })
        .pipe(Effect.flip);
      expect(baseTarget).toMatchObject({ _tag: "TeamIntegrationTargetError", branch: "main" });
      expect(yield* Ref.get(harness.integrationInputs)).toHaveLength(1);
    }),
  );

  it.effect("returns the conflicting worker branch and files", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        threads: [orchestrator(), worker()],
        integrateResult: {
          status: "conflict",
          branch: "team/thread-t/integration",
          worktreePath: "/workspace/integration",
          conflictingBranch: "team/thread-t/frontend-build-ui",
          conflictingFiles: ["src/ui.ts"],
        },
      });
      expect(
        yield* harness.call("team_integrate", {
          branches: ["team/thread-t/frontend-build-ui"],
        }),
      ).toEqual({
        status: "conflict",
        branch: "team/thread-t/integration",
        conflictingBranch: "team/thread-t/frontend-build-ui",
        conflictingFiles: ["src/ui.ts"],
      });
    }),
  );

  it.effect("refuses a credential without the team capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call("team_roster", {}, ["pull-requests"]).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "team",
      });
    }),
  );
});
