import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  TeamRoleId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { layer, TeamReportReactor } from "./TeamReportReactor.ts";

const NOW = "2026-09-16T00:00:00.000Z";
const OWNER_ID = ThreadId.make("owner");
const WORKER_ONE_ID = ThreadId.make("worker-one");
const WORKER_TWO_ID = ThreadId.make("worker-two");
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(6),
  digest: (_algorithm, data) => Effect.succeed(data),
});

type TestThread = Omit<
  { -readonly [Key in keyof OrchestrationThread]: OrchestrationThread[Key] },
  "messages"
> & {
  messages: OrchestrationMessage[];
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
};

const workflow = (maxAutoReports = 30) => ({
  id: "default-team",
  name: "Default team",
  builtIn: true,
  roles: [],
  maxParallelWorkers: 4,
  maxReviewRounds: 2,
  maxAutoReports,
  orchestratorInstructions: "",
});

const makeThread = ({
  id,
  team,
  latestTurn = null,
  sessionStatus = "ready",
  maxAutoReports = 30,
}: {
  readonly id: ThreadId;
  readonly team: TestThread["team"];
  readonly latestTurn?: TestThread["latestTurn"];
  readonly sessionStatus?: NonNullable<TestThread["session"]>["status"];
  readonly maxAutoReports?: number;
}): TestThread => ({
  id,
  projectId: ProjectId.make("project"),
  title: id === OWNER_ID ? "Orchestrator" : `Task ${id}`,
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: id === OWNER_ID ? "main" : `team/${id}`,
  worktreePath: null,
  team:
    team?.role === "orchestrator"
      ? { role: "orchestrator", workflow: workflow(maxAutoReports) }
      : team,
  pullRequests: [],
  latestTurn,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId: id,
    status: sessionStatus,
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: latestTurn?.state === "running" ? latestTurn.turnId : null,
    lastError: null,
    updatedAt: NOW,
  },
  hasPendingApprovals: false,
  hasPendingUserInput: false,
});

const workerTeam = {
  role: "worker",
  orchestratorThreadId: OWNER_ID,
  roleId: TeamRoleId.make("builder"),
  roleLabel: "Builder",
  taskTitle: "Build the feature",
} as const;

const turn = (id: string, state: "running" | "completed" | "error" | "interrupted") => ({
  turnId: TurnId.make(id),
  state,
  requestedAt: "2026-09-16T00:00:01.000Z",
  startedAt: "2026-09-16T00:00:01.000Z",
  completedAt: state === "running" ? null : "2026-09-16T00:00:03.000Z",
  assistantMessageId: state === "running" ? null : MessageId.make(`message-${id}`),
});

const shellOf = (thread: TestThread): OrchestrationThreadShell => ({
  ...thread,
  latestUserMessageAt: null,
  hasPendingApprovals: thread.hasPendingApprovals,
  hasPendingUserInput: thread.hasPendingUserInput,
  hasActionableProposedPlan: false,
});

const sessionEvent = (
  sequence: number,
  thread: TestThread,
): Extract<OrchestrationEvent, { type: "thread.session-set" }> => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread",
  aggregateId: thread.id,
  type: "thread.session-set",
  occurredAt: NOW,
  commandId: CommandId.make(`command-${sequence}`),
  causationEventId: null,
  correlationId: CorrelationId.make(`correlation-${sequence}`),
  metadata: {},
  payload: { threadId: thread.id, session: thread.session! },
});

const approvalEvent = (
  sequence: number,
  worker: TestThread,
  activityId = "approval-one",
): Extract<OrchestrationEvent, { type: "thread.activity-appended" }> => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread",
  aggregateId: worker.id,
  type: "thread.activity-appended",
  occurredAt: NOW,
  commandId: CommandId.make(`command-${sequence}`),
  causationEventId: null,
  correlationId: CorrelationId.make(`correlation-${sequence}`),
  metadata: {},
  payload: {
    threadId: worker.id,
    activity: {
      id: EventId.make(activityId),
      tone: "approval",
      kind: "approval.requested",
      summary: "Command approval requested",
      payload: { requestId: "request-one" },
      turnId: worker.latestTurn?.turnId ?? null,
      createdAt: NOW,
    },
  },
});

const messageEvent = (
  sequence: number,
): Extract<OrchestrationEvent, { type: "thread.message-sent" }> => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread",
  aggregateId: OWNER_ID,
  type: "thread.message-sent",
  occurredAt: NOW,
  commandId: CommandId.make(`command-${sequence}`),
  causationEventId: null,
  correlationId: CorrelationId.make(`correlation-${sequence}`),
  metadata: {},
  payload: {
    threadId: OWNER_ID,
    messageId: MessageId.make(`message-${sequence}`),
    role: "user",
    text: "Continue",
    turnId: null,
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  },
});

const stopEvent = (
  sequence: number,
): Extract<OrchestrationEvent, { type: "thread.session-stop-requested" }> => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread",
  aggregateId: OWNER_ID,
  type: "thread.session-stop-requested",
  occurredAt: NOW,
  commandId: CommandId.make(`command-${sequence}`),
  causationEventId: null,
  correlationId: CorrelationId.make(`correlation-${sequence}`),
  metadata: {},
  payload: { threadId: OWNER_ID, createdAt: NOW },
});

const makeHarness = (initialThreads: ReadonlyArray<TestThread>) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const threads = new Map(initialThreads.map((thread) => [thread.id, thread]));
    const commands: OrchestrationCommand[] = [];
    let sequence = 0;
    const snapshot = (): OrchestrationReadModel => ({
      snapshotSequence: sequence,
      projects: [],
      threads: [...threads.values()],
      updatedAt: NOW,
    });
    const projection = {
      getSnapshot: () => Effect.sync(snapshot),
      getThreadShellById: (threadId: ThreadId) =>
        Effect.sync(() => Option.fromNullishOr(threads.get(threadId))).pipe(
          Effect.map(Option.map(shellOf)),
        ),
      getThreadDetailById: (threadId: ThreadId) =>
        Effect.sync(() => Option.fromNullishOr(threads.get(threadId))),
    } as unknown as ProjectionSnapshotQueryShape;
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence };
        }),
      subscribeDomainEvents: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
      streamDomainEvents: Stream.fromPubSub(events),
      latestSequence: Effect.sync(() => sequence),
    } as unknown as OrchestrationEngineShape;

    return {
      commands,
      threads,
      publish: (event: OrchestrationEvent) =>
        Effect.gen(function* () {
          sequence = event.sequence;
          yield* PubSub.publish(events, event);
        }),
      layer: layer.pipe(
        Layer.provide(Layer.succeed(ProjectionSnapshotQuery, projection)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
        Layer.provide(Layer.succeed(Crypto.Crypto, testCrypto)),
      ),
    };
  });

const turnStarts = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
      command.type === "thread.turn.start",
  );

describe("TeamReportReactor", () => {
  effectIt.effect("batches worker completions until the orchestrator is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = makeThread({
          id: OWNER_ID,
          team: { role: "orchestrator", workflow: workflow() },
          latestTurn: turn("owner", "running"),
          sessionStatus: "running",
        });
        const workerOne = makeThread({
          id: WORKER_ONE_ID,
          team: workerTeam,
          latestTurn: turn("one", "running"),
          sessionStatus: "running",
        });
        const workerTwo = makeThread({
          id: WORKER_TWO_ID,
          team: workerTeam,
          latestTurn: turn("two", "running"),
          sessionStatus: "running",
        });
        const harness = yield* makeHarness([owner, workerOne, workerTwo]);

        yield* Effect.gen(function* () {
          const reactor = yield* TeamReportReactor;
          yield* reactor.start();
          workerOne.latestTurn = turn("one", "completed");
          workerOne.session = { ...workerOne.session!, status: "ready", activeTurnId: null };
          workerTwo.latestTurn = turn("two", "completed");
          workerTwo.session = { ...workerTwo.session!, status: "ready", activeTurnId: null };
          yield* harness.publish(sessionEvent(1, workerOne));
          yield* harness.publish(sessionEvent(2, workerTwo));
          yield* reactor.drainThrough(2);
          expect(turnStarts(harness.commands)).toHaveLength(0);

          owner.latestTurn = turn("owner", "completed");
          owner.session = { ...owner.session!, status: "ready", activeTurnId: null };
          yield* harness.publish(sessionEvent(3, owner));
          yield* reactor.drainThrough(3);

          const reports = turnStarts(harness.commands);
          expect(reports).toHaveLength(1);
          expect(reports[0]?.message.text).toContain("team/worker-one");
          expect(reports[0]?.message.text).toContain("team/worker-two");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  effectIt.effect("reports a worker approval once without starting a worker turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = makeThread({
          id: OWNER_ID,
          team: { role: "orchestrator", workflow: workflow() },
        });
        const worker = makeThread({
          id: WORKER_ONE_ID,
          team: workerTeam,
          latestTurn: turn("one", "running"),
          sessionStatus: "running",
        });
        const harness = yield* makeHarness([owner, worker]);

        yield* Effect.gen(function* () {
          const reactor = yield* TeamReportReactor;
          yield* reactor.start();
          worker.hasPendingApprovals = true;
          yield* harness.publish(approvalEvent(1, worker));
          yield* reactor.drainThrough(1);
          yield* harness.publish(approvalEvent(2, worker));
          yield* reactor.drainThrough(2);

          const reports = turnStarts(harness.commands);
          expect(reports).toHaveLength(1);
          expect(reports[0]?.threadId).toBe(OWNER_ID);
          expect(reports[0]?.message.text).toContain("approval requested");
          expect(
            harness.commands.some(
              (command) => "threadId" in command && command.threadId === WORKER_ONE_ID,
            ),
          ).toBe(false);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  effectIt.effect("pauses at the report limit and resets on a real user message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = makeThread({
          id: OWNER_ID,
          team: { role: "orchestrator", workflow: workflow(1) },
          maxAutoReports: 1,
        });
        const workerOne = makeThread({
          id: WORKER_ONE_ID,
          team: workerTeam,
          latestTurn: turn("one", "running"),
          sessionStatus: "running",
        });
        const workerTwo = makeThread({
          id: WORKER_TWO_ID,
          team: workerTeam,
          latestTurn: turn("two", "running"),
          sessionStatus: "running",
        });
        const harness = yield* makeHarness([owner, workerOne, workerTwo]);

        yield* Effect.gen(function* () {
          const reactor = yield* TeamReportReactor;
          yield* reactor.start();
          workerOne.latestTurn = turn("one", "completed");
          workerOne.session = { ...workerOne.session!, status: "ready", activeTurnId: null };
          yield* harness.publish(sessionEvent(1, workerOne));
          yield* reactor.drainThrough(1);

          workerTwo.latestTurn = turn("two", "completed");
          workerTwo.session = { ...workerTwo.session!, status: "ready", activeTurnId: null };
          yield* harness.publish(sessionEvent(2, workerTwo));
          yield* reactor.drainThrough(2);
          expect(turnStarts(harness.commands)).toHaveLength(1);
          expect(
            harness.commands.filter((command) => command.type === "thread.activity.append"),
          ).toHaveLength(1);

          yield* harness.publish(messageEvent(3));
          yield* harness.publish(sessionEvent(4, owner));
          yield* reactor.drainThrough(4);
          expect(turnStarts(harness.commands)).toHaveLength(2);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  effectIt.effect("drops pending reports when the orchestrator stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = makeThread({
          id: OWNER_ID,
          team: { role: "orchestrator", workflow: workflow() },
          latestTurn: turn("owner", "running"),
          sessionStatus: "running",
        });
        const worker = makeThread({
          id: WORKER_ONE_ID,
          team: workerTeam,
          latestTurn: turn("one", "running"),
          sessionStatus: "running",
        });
        const harness = yield* makeHarness([owner, worker]);

        yield* Effect.gen(function* () {
          const reactor = yield* TeamReportReactor;
          yield* reactor.start();
          worker.latestTurn = turn("one", "completed");
          worker.session = { ...worker.session!, status: "ready", activeTurnId: null };
          yield* harness.publish(sessionEvent(1, worker));
          yield* harness.publish(stopEvent(2));
          owner.latestTurn = turn("owner", "completed");
          owner.session = { ...owner.session!, status: "ready", activeTurnId: null };
          yield* harness.publish(sessionEvent(3, owner));
          yield* reactor.drainThrough(3);
          expect(turnStarts(harness.commands)).toHaveLength(0);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  effectIt.effect("recovers an unreported completion at startup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = makeThread({
          id: OWNER_ID,
          team: { role: "orchestrator", workflow: workflow() },
          latestTurn: {
            ...turn("owner", "completed"),
            completedAt: "2026-09-16T00:00:02.000Z",
          },
        });
        const worker = makeThread({
          id: WORKER_ONE_ID,
          team: workerTeam,
          latestTurn: turn("one", "completed"),
        });
        worker.messages.push({
          id: MessageId.make("worker-answer"),
          role: "assistant",
          text: "The feature is ready.",
          turnId: worker.latestTurn!.turnId,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        });
        const harness = yield* makeHarness([owner, worker]);

        yield* Effect.gen(function* () {
          const reactor = yield* TeamReportReactor;
          yield* reactor.start();
          yield* reactor.drain;
          const reports = turnStarts(harness.commands);
          expect(reports).toHaveLength(1);
          expect(reports[0]?.message.text).toContain("The feature is ready.");
          expect(reports[0]?.message.context?.records[0]?.kind).toBe("team-report");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );
});
