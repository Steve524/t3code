import {
  CommandId,
  ComposerContextId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

const TEAM_REPORT_KIND = "team-report";
const ASSISTANT_MESSAGE_LIMIT = 1_500;

type PendingWorker = {
  readonly workerThreadId: ThreadId;
  readonly signalKeys: Set<string>;
};

type OwnerState = {
  readonly pending: Map<ThreadId, PendingWorker>;
  readonly reportedSignals: Set<string>;
  autoReports: number;
  busy: boolean;
  pauseReported: boolean;
  suppressed: boolean;
};

type TeamReport = {
  readonly workerThreadId: ThreadId;
  readonly roleLabel: string;
  readonly title: string;
  readonly state: string;
  readonly branch: string | null;
  readonly diffStats: {
    readonly files: number;
    readonly additions: number;
    readonly deletions: number;
  };
  readonly lastAssistantMessage: string | null;
};

export class TeamReportReactor extends Context.Service<
  TeamReportReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    readonly drainThrough: (sequence: number) => Effect.Effect<void>;
  }
>()("t3/orchestration/TeamReportReactor") {}

const isBusy = (thread: Pick<OrchestrationThreadShell, "session" | "latestTurn">) =>
  thread.session?.status === "starting" ||
  thread.session?.status === "running" ||
  thread.latestTurn?.state === "running";

const isStopped = (thread: Pick<OrchestrationThreadShell, "session">) =>
  thread.session?.status === "stopped" || thread.session?.status === "interrupted";

const isTeamReportContext = (context: unknown) => {
  if (context === undefined || context === null || typeof context !== "object") return false;
  const records = (context as { readonly records?: ReadonlyArray<{ readonly kind?: string }> })
    .records;
  return records?.some((record) => record.kind === TEAM_REPORT_KIND) === true;
};

const countAutoReports = (thread: OrchestrationThread) => {
  const lastRealUserMessage = thread.messages.findLastIndex(
    (message) => message.role === "user" && !isTeamReportContext(message.context),
  );
  return thread.messages
    .slice(lastRealUserMessage + 1)
    .filter((message) => message.role === "user" && isTeamReportContext(message.context)).length;
};

const workerState = (thread: OrchestrationThreadShell) => {
  if (thread.hasPendingApprovals) return "approval requested";
  if (thread.hasPendingUserInput) return "user input requested";
  return thread.latestTurn?.state ?? thread.session?.status ?? "idle";
};

const reportText = (reports: ReadonlyArray<TeamReport>) =>
  [
    "Team update",
    ...reports.map((report) => {
      const output = report.lastAssistantMessage ?? "No assistant output.";
      return [
        `### ${report.roleLabel}: ${report.title}`,
        `State: ${report.state}`,
        `Branch: ${report.branch ?? "default"}`,
        `Diff: ${report.diffStats.files} files, +${report.diffStats.additions}/-${report.diffStats.deletions}`,
        output,
      ].join("\n");
    }),
  ].join("\n\n");

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const owners = new Map<ThreadId, OwnerState>();

  const ownerState = (ownerThreadId: ThreadId) => {
    const existing = owners.get(ownerThreadId);
    if (existing) return existing;
    const created: OwnerState = {
      pending: new Map(),
      reportedSignals: new Set(),
      autoReports: 0,
      busy: false,
      pauseReported: false,
      suppressed: false,
    };
    owners.set(ownerThreadId, created);
    return created;
  };

  const randomId = <A>(makeId: (value: string) => A) =>
    crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(makeId));

  const buildReport = Effect.fn("TeamReportReactor.buildReport")(function* (
    pending: PendingWorker,
  ) {
    const shell = yield* snapshots.getThreadShellById(pending.workerThreadId);
    const detail = yield* snapshots.getThreadDetailById(pending.workerThreadId, {
      activityKinds: [],
    });
    if (Option.isNone(shell) || shell.value.team?.role !== "worker" || Option.isNone(detail)) {
      return null;
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
      workerThreadId: shell.value.id,
      roleLabel: shell.value.team.roleLabel,
      title: shell.value.team.taskTitle,
      state: workerState(shell.value),
      branch: shell.value.branch,
      diffStats,
      lastAssistantMessage: lastAssistantMessage?.text.slice(0, ASSISTANT_MESSAGE_LIMIT) ?? null,
    } satisfies TeamReport;
  });

  const appendPauseActivity = Effect.fn("TeamReportReactor.appendPauseActivity")(function* (
    owner: OrchestrationThreadShell & {
      readonly team: Extract<
        NonNullable<OrchestrationThreadShell["team"]>,
        { role: "orchestrator" }
      >;
    },
    state: OwnerState,
  ) {
    if (state.pauseReported) return;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: yield* randomId((id) => CommandId.make(`server:team-report-paused:${id}`)),
      threadId: owner.id,
      activity: {
        id: yield* randomId(EventId.make),
        tone: "info",
        kind: "team.reports.paused",
        summary: "Paused automatic team updates. Send a message to continue.",
        payload: { automaticReports: state.autoReports },
        turnId: null,
        createdAt,
      },
      createdAt,
    });
    state.pauseReported = true;
  });

  const flush = Effect.fn("TeamReportReactor.flush")(function* (ownerThreadId: ThreadId) {
    const state = owners.get(ownerThreadId);
    if (!state || state.pending.size === 0) return;
    const found = yield* snapshots.getThreadShellById(ownerThreadId);
    if (Option.isNone(found) || found.value.team?.role !== "orchestrator") {
      owners.delete(ownerThreadId);
      return;
    }
    const owner = { ...found.value, team: found.value.team };
    if (state.suppressed) {
      state.pending.clear();
      state.suppressed = true;
      return;
    }
    if (state.busy) return;
    if (state.autoReports >= owner.team.workflow.maxAutoReports) {
      yield* appendPauseActivity(owner, state);
      return;
    }

    const pending = [...state.pending.values()];
    const reports = (yield* Effect.forEach(pending, buildReport)).filter(
      (report): report is TeamReport => report !== null,
    );
    if (reports.length === 0) {
      state.pending.clear();
      return;
    }

    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:team-report:${uuid}`),
      threadId: owner.id,
      message: {
        messageId: MessageId.make(uuid),
        role: "user",
        text: reportText(reports),
        attachments: [],
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId: ComposerContextId.make(uuid),
              label: "Team update",
              kind: TEAM_REPORT_KIND,
              payload: { reports },
            },
          ],
        },
      },
      modelSelection: owner.modelSelection,
      runtimeMode: owner.runtimeMode,
      interactionMode: owner.interactionMode,
      createdAt,
    });

    for (const item of pending) {
      for (const signalKey of item.signalKeys) state.reportedSignals.add(signalKey);
      state.pending.delete(item.workerThreadId);
    }
    state.autoReports += 1;
  });

  const queueWorker = Effect.fn("TeamReportReactor.queueWorker")(function* (
    worker: OrchestrationThreadShell & {
      readonly team: Extract<NonNullable<OrchestrationThreadShell["team"]>, { role: "worker" }>;
    },
    signalKey: string,
  ) {
    const state = ownerState(worker.team.orchestratorThreadId);
    if (state.reportedSignals.has(signalKey)) return;
    const pending = state.pending.get(worker.id) ?? {
      workerThreadId: worker.id,
      signalKeys: new Set<string>(),
    };
    pending.signalKeys.add(signalKey);
    state.pending.set(worker.id, pending);
    yield* flush(worker.team.orchestratorThreadId);
  });

  const readShell = Effect.fn("TeamReportReactor.readShell")(function* (threadId: ThreadId) {
    const found = yield* snapshots.getThreadShellById(threadId);
    return Option.getOrNull(found);
  });

  const resetOwner = Effect.fn("TeamReportReactor.resetOwner")(function* (threadId: ThreadId) {
    const thread = yield* readShell(threadId);
    if (thread?.team?.role !== "orchestrator") return;
    const state = ownerState(threadId);
    state.autoReports = 0;
    state.pauseReported = false;
    state.suppressed = false;
  });

  const clearOwner = (threadId: ThreadId) => {
    const state = owners.get(threadId);
    if (!state) return;
    state.pending.clear();
    state.suppressed = true;
  };

  const processEvent = Effect.fn("TeamReportReactor.processEvent")(function* (
    event: OrchestrationEvent,
  ) {
    if (event.type === "thread.message-sent") {
      if (event.payload.role === "user" && !isTeamReportContext(event.payload.context)) {
        yield* resetOwner(event.payload.threadId);
      }
      return;
    }
    if (
      event.type === "thread.turn-interrupt-requested" ||
      event.type === "thread.session-stop-requested"
    ) {
      clearOwner(event.payload.threadId);
      return;
    }
    if (event.type === "thread.turn-start-requested") {
      const thread = yield* readShell(event.payload.threadId);
      if (thread?.team?.role === "orchestrator") {
        ownerState(thread.id).busy = true;
      }
      return;
    }
    if (event.type === "thread.activity-appended") {
      const kind = event.payload.activity.kind;
      if (kind !== "approval.requested" && kind !== "user-input.requested") return;
      const worker = yield* readShell(event.payload.threadId);
      if (worker?.team?.role === "worker") {
        yield* queueWorker(
          { ...worker, team: worker.team },
          `${kind}:${event.payload.activity.id}`,
        );
      }
      return;
    }
    if (event.type !== "thread.session-set") return;

    const thread = yield* readShell(event.payload.threadId);
    if (!thread) return;
    if (thread.team?.role === "orchestrator") {
      const state = ownerState(thread.id);
      state.busy =
        event.payload.session.status === "starting" || event.payload.session.status === "running";
      if (
        event.payload.session.status === "stopped" ||
        event.payload.session.status === "interrupted"
      ) {
        clearOwner(thread.id);
      } else {
        yield* flush(thread.id);
      }
      return;
    }
    if (
      thread.team?.role === "worker" &&
      thread.latestTurn !== null &&
      thread.latestTurn.state !== "running"
    ) {
      yield* queueWorker(
        { ...thread, team: thread.team },
        `turn:${thread.latestTurn.turnId}:${thread.latestTurn.state}`,
      );
    }
  });

  const processEventSafely = (event: OrchestrationEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("team report reactor failed to process event", {
              eventType: event.type,
              threadId: event.aggregateId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);
  const seenSequence = yield* SubscriptionRef.make(0);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));

  const recover = Effect.fn("TeamReportReactor.recover")(function* (
    snapshot: OrchestrationReadModel,
  ) {
    const orchestrators = new Map(
      snapshot.threads
        .filter((thread) => thread.team?.role === "orchestrator")
        .map((thread) => [thread.id, thread] as const),
    );
    for (const owner of orchestrators.values()) {
      const state = ownerState(owner.id);
      state.autoReports = countAutoReports(owner);
      state.busy = isBusy(owner);
      state.suppressed = isStopped(owner);
    }
    for (const thread of snapshot.threads) {
      if (
        thread.team?.role !== "worker" ||
        thread.latestTurn === null ||
        thread.latestTurn.state === "running" ||
        thread.latestTurn.completedAt === null
      ) {
        continue;
      }
      const owner = orchestrators.get(thread.team.orchestratorThreadId);
      const ownerTurnStarted = owner?.latestTurn?.startedAt ?? owner?.latestTurn?.requestedAt;
      if (!owner || (ownerTurnStarted && thread.latestTurn.completedAt <= ownerTurnStarted)) {
        continue;
      }
      const state = ownerState(owner.id);
      const signalKey = `turn:${thread.latestTurn.turnId}:${thread.latestTurn.state}`;
      state.pending.set(thread.id, {
        workerThreadId: thread.id,
        signalKeys: new Set([signalKey]),
      });
    }
    yield* Effect.forEach(orchestrators.keys(), flush, { discard: true });
  });

  const start: TeamReportReactor["Service"]["start"] = Effect.fn("TeamReportReactor.start")(
    function* () {
      const events = yield* engine.subscribeDomainEvents;
      const snapshot = yield* snapshots.getSnapshot().pipe(Effect.orDie);
      yield* recover(snapshot).pipe(Effect.orDie);
      yield* noteSeen(snapshot.snapshotSequence);
      yield* forkParked(
        Stream.runForEach(events, (event) =>
          worker.enqueue(event).pipe(Effect.andThen(noteSeen(event.sequence))),
        ),
      );
    },
  );

  const drainThrough: TeamReportReactor["Service"]["drainThrough"] = Effect.fn(
    "TeamReportReactor.drainThrough",
  )(function* (target) {
    yield* SubscriptionRef.changes(seenSequence).pipe(
      Stream.filter((seen) => seen >= target),
      Stream.runHead,
    );
    yield* worker.drain;
  });

  return { start, drain: worker.drain, drainThrough } satisfies TeamReportReactor["Service"];
});

export const layer = Layer.effect(TeamReportReactor, make);
