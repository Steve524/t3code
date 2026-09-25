import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { RESEARCH_PLAN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { expect, it } from "@effect/vitest";
import * as FileSystem from "effect/FileSystem";

import { ServerConfig } from "../../../config.ts";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import { layerConfig } from "../../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { ProviderInstanceRegistry } from "../../../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../../../provider/ProviderDriver.ts";
import { ThreadBootstrap } from "../../orchestration/Services/ThreadBootstrap.ts";
import * as TeamReports from "../../orchestration/TeamReportReactor.ts";
import { handlePlanRun, recoverCancelledPlan } from "./planHandlers.ts";
import {
  makePlanRunStore,
  recordPlan,
  reservePlanWork,
  type PlanReservation,
  type PlanRun,
} from "./planRun.ts";

const owner = ThreadId.make("planning-owner");
const projectId = ProjectId.make("planning-project");
const modelSelection = {
  instanceId: ProviderInstanceId.make("test-provider"),
  model: "test-model",
};
const now = "2026-09-25T12:00:00.000Z";
const cmd = () => CommandId.make(NodeCrypto.randomUUID());
const initial = (): PlanRun => ({
  resumedThroughSequence: 0,
  workflow: { ...RESEARCH_PLAN_TEAM_WORKFLOW, researchDepth: "deep", maxReviewRounds: 2 },
  baseline: "a".repeat(40),
  phase: "planning",
  plan: null,
  reservations: [],
  reviews: [],
});

const diskLayer = (root: string) =>
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(layerConfig),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), root)),
    Layer.provideMerge(NodeServices.layer),
  );

const initialize = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: cmd(),
    projectId,
    title: "Planning",
    workspaceRoot: process.cwd(),
    defaultModelSelection: null,
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: cmd(),
    threadId: owner,
    projectId,
    title: "Plan",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    team: { role: "orchestrator", workflow: initial().workflow },
    createdAt: now,
  });
  yield* handlePlanRun({ action: "start", researchDepth: "deep" });
});

// Launch through the real engine without starting a provider subprocess or making a worktree.
const bootstrapLayer = Layer.effect(
  ThreadBootstrap,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    return ThreadBootstrap.of({
      dispatch: (command) =>
        Effect.gen(function* () {
          expect(command.bootstrap?.runSetupScript).not.toBe(true);
          const create = command.bootstrap?.createThread;
          if (create) {
            expect(command.bootstrap?.prepareWorktree?.requireWorktree).toBe(true);
            yield* engine.dispatch({
              type: "thread.create",
              commandId: cmd(),
              threadId: command.threadId,
              ...create,
            });
          }
          const { bootstrap: _bootstrap, ...start } = command;
          return yield* engine.dispatch(start);
        }).pipe(Effect.orDie),
    });
  }),
);
const invocation = Layer.succeed(McpInvocationContext, {
  threadId: owner,
  environmentId: EnvironmentId.make("test-environment"),
  providerSessionId: "test-session",
  providerInstanceId: modelSelection.instanceId,
  capabilities: new Set(["team"] as const),
  issuedAt: 1,
});
const handlers = Layer.mergeAll(
  TeamReports.layer,
  bootstrapLayer,
  invocation,
  Layer.mock(ProviderInstanceRegistry)({
    getInstance: () => Effect.succeed({ enabled: true } as ProviderInstance),
  }),
);

const complete = (reservation: PlanReservation, text: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const turns = yield* ProjectionTurnRepository;
    const turnId = TurnId.make(`turn-${reservation.requestId}`);
    const messageId = MessageId.make(`result-${reservation.requestId}`);
    yield* engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: cmd(),
      threadId: reservation.workerThreadId,
      messageId,
      turnId,
      delta: text,
      createdAt: now,
    });
    yield* engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: cmd(),
      threadId: reservation.workerThreadId,
      messageId,
      turnId,
      createdAt: now,
    });
    yield* turns.upsertByTurnId({
      threadId: reservation.workerThreadId,
      turnId,
      pendingMessageId: reservation.messageId,
      sourceProposedPlanThreadId: null,
      sourceProposedPlanId: null,
      assistantMessageId: messageId,
      state: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointTurnCount: null,
      checkpointRef: null,
      checkpointStatus: null,
      checkpointFiles: [],
    });
    yield* turns.deletePendingTurnStartByThreadId({ threadId: reservation.workerThreadId });
  });

it.effect(
  "serializes duplicate/parallel dispatch, binds exact results, and preserves budgets and cancellation across disk reopen",
  () =>
    Effect.gen(function* () {
      const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "t3-plan-guards-",
      });
      const layer = handlers.pipe(Layer.provideMerge(diskLayer(root)));
      const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer> | Scope.Scope>) =>
        Effect.scoped(effect.pipe(Effect.provide(layer)));
      yield* run(
        Effect.gen(function* () {
          yield* initialize;
          const started = yield* handlePlanRun({ action: "start", researchDepth: "none" });
          expect(started.workflow.researchDepth).toBe("deep");
          expect(
            started.workflow.roles.every(
              (role) => role.modelSelection?.model === modelSelection.model,
            ),
          ).toBe(true);
          expect(started.baseline).toMatch(/^[a-f0-9]{40,64}$/u);
          const calls = yield* Effect.forEach(
            Array.from({ length: 6 }, (_, index) => index),
            (index) =>
              handlePlanRun({
                action: "dispatch",
                requestId: `research-${index % 4}`,
                purpose: "research-worker",
                title: "Research",
                task: "Inspect evidence",
              }).pipe(Effect.result),
            { concurrency: "unbounded" },
          );
          expect(calls.some((result) => result._tag === "Failure")).toBe(true);
          const state = yield* handlePlanRun({ action: "status" });
          expect(state.reservations).toHaveLength(3);
          expect(new Set(state.reservations.map((item) => item.workerThreadId)).size).toBe(3);
          const reactor = yield* TeamReports.TeamReportReactor;
          yield* reactor.start();
          const engine = yield* OrchestrationEngineService;
          const stopped = yield* engine.dispatch({
            type: "thread.session.stop",
            commandId: cmd(),
            threadId: owner,
            createdAt: now,
          });
          yield* reactor.drainThrough(stopped.sequence);
          for (const worker of state.reservations) {
            const events = yield* engine
              .readThreadEvents({
                threadId: worker.workerThreadId,
                fromSequenceExclusive: 0,
                toSequenceInclusive: yield* engine.latestSequence,
              })
              .pipe(Stream.runCollect);
            expect(
              events.filter((event) => event.type === "thread.session-stop-requested"),
            ).toHaveLength(1);
          }
        }),
      );
      yield* run(
        Effect.gen(function* () {
          const state = yield* handlePlanRun({ action: "status" });
          expect(state.phase).toBe("cancelled");
          expect(state.reservations).toHaveLength(3);
          yield* recoverCancelledPlan(owner);
          expect((yield* handlePlanRun({ action: "cancel" })).phase).toBe("cancelled");
          yield* handlePlanRun({ action: "resume" });
          const blocked = yield* handlePlanRun({
            action: "dispatch",
            requestId: "replacement",
            purpose: "research-worker",
            title: "Research",
            task: "More",
          }).pipe(Effect.result);
          expect(blocked._tag).toBe("Failure");
          const snapshots = yield* ProjectionSnapshotQuery;
          expect((yield* snapshots.getShellSnapshot()).threads).toHaveLength(4);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "recovers a reserved review, rejects partial output, and invalidates saved approval after a plan change",
  () =>
    Effect.gen(function* () {
      const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "t3-plan-review-",
      });
      const layer = handlers.pipe(Layer.provideMerge(diskLayer(root)));
      const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer> | Scope.Scope>) =>
        Effect.scoped(effect.pipe(Effect.provide(layer)));
      yield* run(
        Effect.gen(function* () {
          yield* initialize;
          const dispatched = yield* handlePlanRun({
            action: "dispatch",
            requestId: "plan",
            purpose: "planner",
            title: "Plan",
            task: "Draft",
          });
          yield* complete(dispatched.reservations[0]!, "Full plan " + "🧪 evidence\n".repeat(600));
          const planned = yield* handlePlanRun({ action: "record-plan", requestId: "plan" });
          expect(planned.plan?.version).toBe(1);
          const reviewing = yield* handlePlanRun({
            action: "dispatch",
            requestId: "review",
            purpose: "reviewer",
            title: "Review",
            task: "Inspect",
          });
          expect(
            (yield* handlePlanRun({ action: "record-review", requestId: "review" }).pipe(
              Effect.result,
            ))._tag,
          ).toBe("Failure");
          const store = yield* makePlanRunStore;
          // Simulate loss of the post-launch acknowledgement; launch and turn identities remain durable.
          yield* store.save(owner, {
            ...reviewing,
            reservations: reviewing.reservations.map((item) =>
              item.requestId === "review" ? { ...item, status: "reserved" } : item,
            ),
          });
          const verdict = `{"verdict":"APPROVED","planHash":"${planned.plan!.hash}","baseline":"${planned.baseline}","summary":"Checked","findings":[],"coverage":["Project"],"limitations":[]}`;
          yield* complete(reviewing.reservations.at(-1)!, verdict);
        }),
      );
      yield* run(
        Effect.gen(function* () {
          const reviewed = yield* handlePlanRun({ action: "record-review", requestId: "review" });
          expect(reviewed.phase).toBe("approved");
          expect(reviewed.reservations).toHaveLength(2);
          const store = yield* makePlanRunStore;
          yield* store.save(owner, recordPlan(reviewed, reviewed.plan!, "Changed plan"));
        }),
      );
      yield* run(
        Effect.gen(function* () {
          const state = yield* handlePlanRun({ action: "status" });
          expect(state.phase).toBe("planning");
          expect(state.plan!.version).toBe(2);
          expect(state.reviews).toHaveLength(1);
          const engine = yield* OrchestrationEngineService;
          yield* engine.dispatch({
            type: "thread.session.stop",
            commandId: cmd(),
            threadId: owner,
            createdAt: now,
          });
          // An in-flight state write must not erase a concurrent Stop request.
          const store = yield* makePlanRunStore;
          yield* store.save(owner, state);
        }),
      );
      yield* run(
        Effect.gen(function* () {
          expect((yield* handlePlanRun({ action: "status" })).phase).toBe("cancelled");
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "reads past the default event page and conservatively recovers an unlaunched reservation",
  () =>
    Effect.gen(function* () {
      const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "t3-plan-history-",
      });
      const layer = handlers.pipe(Layer.provideMerge(diskLayer(root)));
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* initialize;
          const engine = yield* OrchestrationEngineService;
          for (let index = 0; index < 1001; index++)
            yield* engine.dispatch({
              type: "thread.activity.append",
              commandId: cmd(),
              threadId: owner,
              activity: {
                id: EventId.make(NodeCrypto.randomUUID()),
                tone: "info",
                kind: "test.filler",
                summary: "history",
                payload: {},
                turnId: null,
                createdAt: now,
              },
              createdAt: now,
            });
          const store = yield* makePlanRunStore;
          const reserved = reservePlanWork(initial(), {
            requestId: "lost-launch",
            purpose: "research-worker",
            title: "Evidence",
            task: "Inspect",
          });
          yield* store.save(owner, reserved.run);
          expect((yield* store.read(owner))!.reservations).toHaveLength(1);
          const recovered = yield* handlePlanRun({ action: "status" });
          expect(recovered.reservations[0]!.status).toBe("failed");
          expect(
            Option.isNone(
              yield* (yield* ProjectionSnapshotQuery).getThreadShellById(
                reserved.reservation.workerThreadId,
              ),
            ),
          ).toBe(true);
        }).pipe(Effect.provide(layer)),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);
