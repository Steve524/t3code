import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  EventId,
  MessageId,
  TeamWorkflow,
  ThreadId,
  TurnId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

import { ReviewVerdict } from "../../provider/PlanReviewVerdict.ts";

export class PlanRunError extends Schema.TaggedError<PlanRunError>()("PlanRunError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

const Source = Schema.Struct({ workerThreadId: ThreadId, turnId: TurnId, messageId: MessageId });
export const FindingDisposition = Schema.Struct({
  id: TrimmedNonEmptyString,
  decision: Schema.Literals(["accepted", "rejected"]),
  evidence: TrimmedNonEmptyString,
});
const PlannerSource = Schema.Struct({ threadId: ThreadId, proposedPlanId: TrimmedNonEmptyString });
const PlanSource = Schema.Union([Source, PlannerSource]);
const planFields = {
  hash: Schema.String,
  version: Schema.Int,
  dispositions: Schema.Array(FindingDisposition),
};
const Plan = Schema.Union([
  Schema.Struct({ ...Source.fields, ...planFields }),
  Schema.Struct({ ...PlannerSource.fields, ...planFields }),
]);
export const PlanPurpose = Schema.Literals([
  "planner",
  "reviewer",
  "research-lead",
  "research-worker",
]);
const Reservation = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  fingerprint: Schema.String,
  purpose: PlanPurpose,
  workerThreadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  planHash: Schema.NullOr(Schema.String),
  status: Schema.Literals(["reserved", "dispatched", "failed", "completed"]),
  error: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Source),
});
export type PlanReservation = typeof Reservation.Type;
export const PlanRun = Schema.Struct({
  resumedThroughSequence: Schema.Int,
  workflow: TeamWorkflow,
  baseline: TrimmedNonEmptyString,
  phase: Schema.Literals(["planning", "research", "review", "approved", "blocked", "cancelled"]),
  plan: Schema.NullOr(Plan),
  reservations: Schema.Array(Reservation),
  reviews: Schema.Array(
    Schema.Struct({
      requestId: Schema.String,
      source: Source,
      verdict: Schema.NullOr(ReviewVerdict),
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type PlanRun = typeof PlanRun.Type;
const decodeRun = Schema.decodeUnknownEffect(PlanRun);
const decodeVerdict = Schema.decodeUnknownSync(Schema.fromJsonString(ReviewVerdict));
export const isPlanRunError = Schema.is(PlanRunError);
export const hashPlan = (text: string) =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
export const PLAN_RUN_ACTIVITY = "team.plan-run.updated";

// ponytail: A process-wide lock serializes these low-volume calls across MCP sessions. Use keyed locks if independent runs contend.
const lock = Semaphore.makeUnsafe(1);
export const withPlanRunLock = lock.withPermits(1);
const fail = (detail: string) => new PlanRunError({ detail });

const requireRecordedReviews = (run: PlanRun) => {
  if (
    run.reservations.some(
      (item) =>
        item.purpose === "reviewer" &&
        item.status !== "failed" &&
        !run.reviews.some((review) => review.requestId === item.requestId),
    )
  ) {
    throw fail(
      "The previous review must finish and be recorded with action=record-review before continuing.",
    );
  }
};

export function reservePlanWork(
  run: PlanRun,
  input: {
    requestId: string;
    purpose: typeof PlanPurpose.Type;
    task: string;
    title: string;
    workerThreadId?: ThreadId | undefined;
  },
): { run: PlanRun; reservation: PlanReservation; duplicate: boolean } {
  // Keep fingerprints of older requests unchanged when no follow-up target is supplied.
  const fingerprint = hashPlan(
    JSON.stringify([
      input.purpose,
      input.title,
      input.task,
      ...(input.workerThreadId ? [input.workerThreadId] : []),
    ]),
  );
  const duplicate = run.reservations.find((item) => item.requestId === input.requestId);
  if (duplicate) {
    if (duplicate.fingerprint !== fingerprint)
      throw fail("Request ID was already used for a different task.");
    return { run, reservation: duplicate, duplicate: true };
  }
  if (run.phase === "cancelled") throw fail("This run is cancelled. Resume it explicitly first.");
  if (input.purpose === "planner" && run.workflow.skillVersion !== "1.0.0")
    throw fail(
      "You are the planner. Ask the user and draft the plan in this chat; do not dispatch a planner worker.",
    );
  if (run.phase === "approved" && input.purpose !== "planner")
    throw fail("Record a revised plan before dispatching more work.");
  if (input.workerThreadId && input.purpose !== "research-worker")
    throw fail("workerThreadId is supported only for research-worker follow-ups.");
  const previous = run.reservations.filter((item) => item.purpose === input.purpose);
  const researchWorkers = run.reservations.filter((item) => item.purpose === "research-worker");
  const latestWorkers = [
    ...new Map(researchWorkers.map((item) => [item.workerThreadId, item])).values(),
  ];
  if (
    input.purpose === "research-lead" &&
    latestWorkers.some((item) => item.status !== "completed")
  )
    throw fail("Wait for all research workers and follow-ups to complete before synthesis.");
  if (input.purpose === "reviewer") {
    if (!run.plan) throw fail("Record a completed plan before requesting review.");
    if (previous.length >= run.workflow.maxReviewRounds)
      throw fail("Review attempt budget exhausted.");
    requireRecordedReviews(run);
    const research = run.reservations.filter((item) => item.purpose.startsWith("research"));
    if (
      research.some((item) => item.status === "reserved" || item.status === "dispatched") ||
      (run.workflow.researchDepth !== "none" &&
        (research.findLast((item) => item.purpose === "research-lead")?.status !== "completed" ||
          latestWorkers.some((item) => item.status !== "completed") ||
          research.findLastIndex((item) => item.purpose === "research-worker") >
            research.findLastIndex((item) => item.purpose === "research-lead")))
    ) {
      throw fail("Wait for selected research to complete before requesting review.");
    }
  }
  if (input.purpose === "research-worker") {
    if (run.workflow.researchDepth !== "deep")
      throw fail("Research workers require deep research.");
    const owned = previous.filter((item) => item.workerThreadId === input.workerThreadId);
    if (input.workerThreadId && owned.length === 0)
      throw fail("Follow-up target must be an owned research worker in this run.");
    if (owned.length >= 2)
      throw fail(
        "Research-worker follow-up budget exhausted: one follow-up per worker, including failed attempts.",
      );
    if (!input.workerThreadId && latestWorkers.length >= (run.workflow.deepResearchWorkers ?? 3))
      throw fail("Total research-worker budget exhausted.");
  }
  if (input.purpose === "research-lead" && run.workflow.researchDepth === "none") {
    throw fail("Research is disabled in this run.");
  }
  if (
    run.reservations.filter((item) => item.status === "reserved" || item.status === "dispatched")
      .length >= run.workflow.maxParallelWorkers
  ) {
    throw fail("Parallel worker limit reached. Wait for completion reports.");
  }
  const existing =
    input.purpose === "research-worker"
      ? previous.find((item) => item.workerThreadId === input.workerThreadId)
      : previous[0];
  if (
    existing &&
    previous.some(
      (item) =>
        item.workerThreadId === existing.workerThreadId &&
        (item.status === "reserved" || item.status === "dispatched"),
    )
  ) {
    throw fail("This role already has pending work.");
  }
  const reservation: PlanReservation = {
    requestId: input.requestId,
    fingerprint,
    purpose: input.purpose,
    workerThreadId: existing?.workerThreadId ?? ThreadId.make(NodeCrypto.randomUUID()),
    messageId: MessageId.make(NodeCrypto.randomUUID()),
    commandId: CommandId.make(`server:plan-dispatch:${NodeCrypto.randomUUID()}`),
    planHash: input.purpose === "reviewer" ? run.plan!.hash : null,
    status: "reserved",
    error: null,
    result: null,
  };
  return {
    run: {
      ...run,
      phase:
        input.purpose === "reviewer"
          ? "review"
          : input.purpose.startsWith("research")
            ? "research"
            : "planning",
      reservations: [...run.reservations, reservation],
    },
    reservation,
    duplicate: false,
  };
}

export function recordPlan(
  run: PlanRun,
  source: typeof PlanSource.Type,
  text: string,
  dispositions: ReadonlyArray<typeof FindingDisposition.Type> = [],
): PlanRun {
  if (run.phase === "cancelled") throw fail("Resume the run before recording a plan.");
  const hash = hashPlan(text);
  if (run.plan?.hash === hash) return run;
  requireRecordedReviews(run);
  const latestReview = run.reviews.at(-1);
  if (latestReview && !latestReview.verdict) {
    throw fail(
      "Retry the invalid review against the same saved plan before recording a revision. The retry counts toward the review budget.",
    );
  }
  const findings = latestReview?.verdict?.findings ?? [];
  if (findings.some((finding) => !dispositions.some((item) => item.id === finding.id)))
    throw fail("Record a disposition and evidence for each previous finding.");
  return {
    ...run,
    phase: "planning",
    plan: { ...source, hash, version: (run.plan?.version ?? 0) + 1, dispositions },
  };
}

/** Read the exact saved version, including plans from legacy planner workers. */
export const readPlanText = Effect.fn("TeamPlan.readPlanText")(function* (plan: typeof Plan.Type) {
  const snapshots = yield* ProjectionSnapshotQuery;
  const detail = yield* snapshots.getThreadDetailById(
    "proposedPlanId" in plan ? plan.threadId : plan.workerThreadId,
    { activityKinds: [] },
  );
  if (Option.isNone(detail)) return undefined;
  return "proposedPlanId" in plan
    ? detail.value.proposedPlans.find((item) => item.id === plan.proposedPlanId)?.planMarkdown
    : detail.value.messages.find((item) => item.id === plan.messageId)?.text;
});

export function recordReview(
  run: PlanRun,
  requestId: string,
  source: typeof Source.Type,
  text: string,
): PlanRun {
  if (run.reviews.some((review) => review.requestId === requestId)) return run;
  const attempt = run.reservations.find((item) => item.requestId === requestId);
  if (
    !attempt ||
    attempt.purpose !== "reviewer" ||
    attempt.workerThreadId !== source.workerThreadId ||
    attempt.result?.turnId !== source.turnId ||
    attempt.result.messageId !== source.messageId
  ) {
    throw fail("Review result does not match a completed reserved reviewer turn.");
  }
  let verdict: typeof ReviewVerdict.Type | null = null;
  let error: string | null = null;
  try {
    const json = extractJsonObject(text);
    if (text.slice(text.indexOf(json) + json.length).includes("{"))
      throw fail("Reviewer output must contain only one verdict JSON object.");
    verdict = decodeVerdict(json);
    if (
      verdict.planHash !== attempt.planHash ||
      verdict.planHash !== run.plan?.hash ||
      verdict.baseline !== run.baseline
    ) {
      throw fail("Review refers to a stale plan or baseline.");
    }
    if (new Set(verdict.findings.map((item) => item.id)).size !== verdict.findings.length)
      throw fail("Finding IDs must be unique.");
    if (
      verdict.verdict === "APPROVED" &&
      verdict.findings.some((item) => item.severity !== "minor")
    ) {
      throw fail("APPROVED contains unresolved material findings.");
    }
  } catch (cause) {
    error = isPlanRunError(cause)
      ? cause.detail
      : "Reviewer output is not a valid complete verdict JSON object.";
    verdict = null;
  }
  return {
    ...run,
    phase:
      run.phase === "cancelled"
        ? "cancelled"
        : verdict?.verdict === "APPROVED"
          ? "approved"
          : "blocked",
    reviews: [...run.reviews, { requestId, source, verdict, error }],
  };
}

/** Replay through a captured head, explicitly overriding the event store's default page limit. */
export const makePlanRunStore = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const read = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const head = yield* engine.latestSequence;
      let run: PlanRun | null = null;
      let stoppedAt = 0;
      yield* engine
        .readThreadEvents({
          threadId,
          fromSequenceExclusive: 0,
          toSequenceInclusive: head,
          limit: Math.max(1, head),
        })
        .pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (
                event.type === "thread.session-stop-requested" ||
                event.type === "thread.turn-interrupt-requested"
              )
                stoppedAt = event.sequence;
              if (
                event.type === "thread.activity-appended" &&
                event.payload.activity.kind === PLAN_RUN_ACTIVITY
              ) {
                run = yield* decodeRun(event.payload.activity.payload).pipe(
                  Effect.mapError(() =>
                    fail("Saved run state is invalid; refusing to reset its budgets."),
                  ),
                );
              }
            }),
          ),
        );
      const restored = run as PlanRun | null;
      return restored && stoppedAt > restored.resumedThroughSequence
        ? { ...restored, phase: "cancelled" as const }
        : restored;
    });
  const save = (threadId: ThreadId, run: PlanRun) =>
    Effect.gen(function* () {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:plan-state:${NodeCrypto.randomUUID()}`),
        threadId,
        activity: {
          id: EventId.make(NodeCrypto.randomUUID()),
          tone: "info",
          kind: PLAN_RUN_ACTIVITY,
          summary: `Planning run: ${run.phase}`,
          payload: run,
          turnId: null,
          createdAt,
        },
        createdAt,
      });
      return run;
    });
  return { read, save };
});
