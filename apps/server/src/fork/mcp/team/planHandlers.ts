import { CommandId, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { requireMcpCapability } from "../../../mcp/McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import { ProviderInstanceRegistry } from "../../../provider/Services/ProviderInstanceRegistry.ts";
import { ThreadBootstrap } from "../../orchestration/Services/ThreadBootstrap.ts";
import { PLAN_LOOP_SKILL_VERSION } from "../../provider/PlanLoopSkill.ts";
import {
  FindingDisposition,
  hashPlan,
  isPlanRunError,
  makePlanRunStore,
  PlanPurpose,
  PlanRunError,
  recordPlan,
  recordReview,
  reservePlanWork,
  withPlanRunLock,
  type PlanRun,
  type PlanReservation,
} from "./planRun.ts";

export const PlanRunInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("start"),
    researchDepth: Schema.optional(Schema.Literals(["none", "web", "deep"])),
  }),
  Schema.Struct({ action: Schema.Literal("status") }),
  Schema.Struct({ action: Schema.Literal("cancel") }),
  Schema.Struct({ action: Schema.Literal("resume") }),
  Schema.Struct({
    action: Schema.Literal("dispatch"),
    requestId: TrimmedNonEmptyString,
    purpose: PlanPurpose,
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
    task: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("record-plan"),
    requestId: TrimmedNonEmptyString,
    dispositions: Schema.optional(Schema.Array(FindingDisposition)),
  }),
  Schema.Struct({ action: Schema.Literal("record-review"), requestId: TrimmedNonEmptyString }),
]);

// MCP requires an object at the root; decode the action-specific union before execution.
export const PlanRunToolInput = Schema.Struct({
  action: Schema.Literals([
    "start",
    "status",
    "cancel",
    "resume",
    "dispatch",
    "record-plan",
    "record-review",
  ]),
  researchDepth: Schema.optional(Schema.Literals(["none", "web", "deep"])),
  requestId: Schema.optional(TrimmedNonEmptyString),
  purpose: Schema.optional(PlanPurpose),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(40))),
  task: Schema.optional(TrimmedNonEmptyString),
  dispositions: Schema.optional(Schema.Array(FindingDisposition)),
});

const decodeInput = Schema.decodeUnknownEffect(PlanRunInput);
export const handlePlanTool = (input: typeof PlanRunToolInput.Type) =>
  decodeInput(input).pipe(
    Effect.mapError(
      () =>
        new PlanRunError({
          detail:
            "Dispatch needs requestId, purpose, title and task. Recording a result needs requestId.",
        }),
    ),
    Effect.flatMap(handlePlanRun),
  );

const fail = (detail: string) => new PlanRunError({ detail });
const encodeDispositions = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(FindingDisposition)),
);
const attempt = <A>(body: () => A) =>
  Effect.try({
    try: body,
    catch: (cause) => (isPlanRunError(cause) ? cause : fail(String(cause))),
  });
const updateReservation = (run: PlanRun, reservation: PlanReservation): PlanRun => ({
  ...run,
  reservations: run.reservations.map((item) =>
    item.requestId === reservation.requestId ? reservation : item,
  ),
});

/** Stop only IDs durably allocated to this owner. Repeating cancellation is safe. */
export const stopPlanWorkers = (ownerId: ThreadId, run: PlanRun) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    for (const workerId of new Set(
      run.reservations
        .filter((item) => item.status !== "completed")
        .map((item) => item.workerThreadId),
    )) {
      const worker = yield* snapshots.getThreadShellById(workerId);
      if (Option.isNone(worker)) continue;
      if (
        worker.value.team?.role !== "worker" ||
        worker.value.team.orchestratorThreadId !== ownerId
      )
        return yield* fail("Reserved worker ownership changed.");
      yield* engine.dispatch({
        type: "thread.session.stop",
        threadId: workerId,
        commandId: CommandId.make(
          `server:plan-stop:${ownerId}:${workerId}:${run.resumedThroughSequence}`,
        ),
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
    }
  });

/** Used by completion-report recovery as well as the owner's ordinary Stop action. */
export const recoverCancelledPlan = (ownerId: ThreadId) =>
  withPlanRunLock(
    Effect.gen(function* () {
      const store = yield* makePlanRunStore;
      const run = yield* store.read(ownerId);
      if (run?.phase === "cancelled") yield* stopPlanWorkers(ownerId, run);
    }),
  );

export const handlePlanRun = (input: typeof PlanRunInput.Type) =>
  withPlanRunLock(
    Effect.gen(function* () {
      const scope = yield* requireMcpCapability("team");
      const snapshots = yield* ProjectionSnapshotQuery;
      const engine = yield* OrchestrationEngineService;
      const store = yield* makePlanRunStore;
      const found = yield* snapshots.getThreadShellById(scope.threadId);
      if (
        Option.isNone(found) ||
        found.value.team?.role !== "orchestrator" ||
        found.value.team.workflow.protocolId !== "t3-plan-loop"
      ) {
        return yield* fail("Use a Research and plan orchestrator thread.");
      }
      const owner = found.value;
      const team = found.value.team;
      let run = yield* store.read(owner.id);
      if (input.action === "start") {
        if (run) return run;
        if (team.workflow.skillVersion !== PLAN_LOOP_SKILL_VERSION)
          return yield* fail(
            "This thread uses an incompatible planning skill version. Start a thread with the current preset.",
          );
        const project = yield* snapshots.getProjectShellById(owner.projectId);
        if (Option.isNone(project)) return yield* fail("Project not found.");
        // Capture a commit, not a moving branch name. Child-process arguments never pass through a shell.
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const baseline = yield* spawner
          .string(
            ChildProcess.make("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
              cwd: owner.worktreePath ?? project.value.workspaceRoot,
            }),
          )
          .pipe(
            Effect.map((result) => result.trim()),
            Effect.mapError(() => fail("Planning requires a Git project with a baseline commit.")),
          );
        if (!/^[a-f0-9]{40,64}$/u.test(baseline))
          return yield* fail("Planning requires a valid Git commit baseline.");
        const workflow = {
          ...team.workflow,
          researchDepth: input.researchDepth ?? team.workflow.researchDepth ?? ("none" as const),
          roles: team.workflow.roles.map((role) => ({
            ...role,
            modelSelection: role.modelSelection ?? owner.modelSelection,
            runtimeMode: role.runtimeMode ?? owner.runtimeMode,
          })),
        };
        return yield* store.save(owner.id, {
          resumedThroughSequence: yield* engine.latestSequence,
          workflow,
          baseline,
          phase: "planning",
          plan: null,
          reservations: [],
          reviews: [],
        });
      }
      if (!run) return yield* fail("Start the planning run first.");
      if (input.action === "cancel") {
        run = yield* store.save(owner.id, { ...run, phase: "cancelled" });
        yield* stopPlanWorkers(owner.id, run);
        return run;
      }
      if (run.phase === "cancelled") {
        yield* stopPlanWorkers(owner.id, run);
        if (input.action !== "resume") return run;
        // Resume preserves usage and invalidates approval; no launch is replayed.
        run = yield* store.save(owner.id, {
          ...run,
          phase: "planning",
          resumedThroughSequence: yield* engine.latestSequence,
        });
      }

      const turns = yield* ProjectionTurnRepository;
      // Reconcile by reserved message identity, never by the worker's latest assistant output.
      for (const reservation of run.reservations) {
        if (reservation.status !== "reserved" && reservation.status !== "dispatched") continue;
        const rows = yield* turns.listByThreadId({ threadId: reservation.workerThreadId });
        const row = rows.find((item) => item.pendingMessageId === reservation.messageId);
        let recovered = reservation;
        if (row?.state === "completed" && row.turnId && row.assistantMessageId) {
          recovered = {
            ...reservation,
            status: "completed",
            result: {
              workerThreadId: reservation.workerThreadId,
              turnId: row.turnId,
              messageId: row.assistantMessageId,
            },
          };
        } else if (
          !row ||
          row.state === "error" ||
          row.state === "interrupted" ||
          row.state === "completed"
        ) {
          recovered = {
            ...reservation,
            status: "failed",
            error:
              "Reserved launch has no pending/running turn or completed result. Attempt retained; no automatic retry.",
          };
        } else if (reservation.status === "reserved") {
          recovered = { ...reservation, status: "dispatched" };
        }
        if (recovered !== reservation)
          run = yield* store.save(
            owner.id,
            updateReservation(
              { ...run, phase: recovered.status === "failed" ? "blocked" : run.phase },
              recovered,
            ),
          );
      }
      if (run.phase === "approved" && run.plan) {
        const detail = yield* snapshots.getThreadDetailById(run.plan.workerThreadId, {
          activityKinds: [],
        });
        const text = Option.isSome(detail)
          ? detail.value.messages.find((item) => item.id === run!.plan!.messageId)?.text
          : undefined;
        if (text === undefined || hashPlan(text) !== run.plan.hash)
          run = yield* store.save(owner.id, { ...run, phase: "blocked" });
      }
      if (input.action === "status" || input.action === "resume") return run;
      if (input.action === "record-plan" || input.action === "record-review") {
        const reservation = run.reservations.find((item) => item.requestId === input.requestId);
        if (!reservation?.result || reservation.status !== "completed")
          return yield* fail("Wait for a completed reserved turn before recording its result.");
        if (input.action === "record-plan" && reservation.purpose !== "planner")
          return yield* fail("Only the planner's completed result can become a plan version.");
        const detail = yield* snapshots.getThreadDetailById(reservation.workerThreadId, {
          activityKinds: [],
        });
        const message = Option.isSome(detail)
          ? detail.value.messages.find(
              (item) =>
                item.id === reservation.result!.messageId &&
                item.role === "assistant" &&
                !item.streaming,
            )
          : undefined;
        if (!message) return yield* fail("Complete reserved result is unavailable.");
        const updated = yield* attempt(() =>
          input.action === "record-plan"
            ? recordPlan(run!, reservation.result!, message.text, input.dispositions)
            : recordReview(run!, input.requestId, reservation.result!, message.text),
        );
        return yield* store.save(owner.id, updated);
      }
      const reserved = yield* attempt(() => reservePlanWork(run!, input));
      if (reserved.duplicate) return run;
      const roleId = input.purpose.startsWith("research") ? "researcher" : input.purpose;
      const role = run.workflow.roles.find(
        (candidate) => candidate.id === roleId && candidate.enabled,
      );
      if (!role) return yield* fail(`The saved ${roleId} role is disabled or missing.`);
      const modelSelection = role.modelSelection ?? owner.modelSelection;
      const providers = yield* ProviderInstanceRegistry;
      const provider = yield* providers.getInstance(modelSelection.instanceId);
      if (!provider?.enabled)
        return yield* fail("The saved role provider is unavailable; configure it before dispatch.");
      const project = yield* snapshots.getProjectShellById(owner.projectId);
      if (Option.isNone(project)) return yield* fail("Project not found.");
      const reservation = reserved.reservation;
      const existing = yield* snapshots.getThreadShellById(reservation.workerThreadId);
      const reused = run.reservations.some(
        (item) => item.workerThreadId === reservation.workerThreadId,
      );
      if (reused && Option.isNone(existing))
        return yield* fail("The saved role worker is missing. Refusing to silently replace it.");
      if (
        Option.isSome(existing) &&
        (existing.value.team?.role !== "worker" ||
          existing.value.team.orchestratorThreadId !== owner.id)
      )
        return yield* fail("Reserved worker ownership changed.");
      if (
        Option.isSome(existing) &&
        (existing.value.latestTurn?.state === "running" ||
          existing.value.session?.status === "starting" ||
          existing.value.session?.status === "running")
      )
        return yield* fail("The saved worker is still busy; wait for its completion report.");
      const runtimeMode = role.runtimeMode ?? owner.runtimeMode;
      let task = input.task;
      if (input.purpose === "reviewer") {
        const plan = run.plan!;
        const detail = yield* snapshots.getThreadDetailById(plan.workerThreadId, {
          activityKinds: [],
        });
        const text = Option.isSome(detail)
          ? detail.value.messages.find((item) => item.id === plan.messageId)?.text
          : undefined;
        if (text === undefined) return yield* fail("The saved plan text is unavailable.");
        if (hashPlan(text) !== plan.hash)
          return yield* fail("Saved plan content changed. Record its new version before review.");
        task += `\n\nReview this exact plan. Return the verdict JSON described by your role instructions.\nplanHash: ${plan.hash}\nbaseline: ${run.baseline}\nFinding dispositions: ${encodeDispositions(plan.dispositions)}\n\n${text}`;
      }
      run = yield* store.save(owner.id, reserved.run);
      const bootstrap = yield* ThreadBootstrap;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const launched = yield* bootstrap
        .dispatch({
          type: "thread.turn.start",
          commandId: reservation.commandId,
          threadId: reservation.workerThreadId,
          message: { messageId: reservation.messageId, role: "user", text: task, attachments: [] },
          modelSelection,
          runtimeMode,
          interactionMode: owner.interactionMode,
          createdAt,
          ...(Option.isSome(existing)
            ? {}
            : {
                titleSeed: input.title,
                bootstrap: {
                  createThread: {
                    projectId: owner.projectId,
                    title: input.title,
                    modelSelection,
                    runtimeMode,
                    interactionMode: owner.interactionMode,
                    branch: run.baseline,
                    worktreePath: null,
                    team: {
                      role: "worker" as const,
                      orchestratorThreadId: owner.id,
                      roleId: role.id,
                      roleLabel: role.label,
                      taskTitle: input.title,
                      ...(input.purpose === "reviewer"
                        ? {
                            reviewRound: run.reservations.filter(
                              (item) => item.purpose === "reviewer",
                            ).length,
                          }
                        : {}),
                    },
                    createdAt,
                  },
                  prepareWorktree: {
                    projectCwd: project.value.workspaceRoot,
                    baseBranch: run.baseline,
                    branch: `team/plan-${owner.id.slice(0, 8)}/${reservation.workerThreadId.slice(0, 8)}`,
                    requireWorktree: true,
                  },
                  runSetupScript: false,
                },
              }),
        })
        .pipe(Effect.result);
      return yield* store.save(
        owner.id,
        updateReservation(
          { ...run, phase: launched._tag === "Failure" ? "blocked" : run.phase },
          {
            ...reservation,
            status: launched._tag === "Success" ? "dispatched" : "failed",
            error:
              launched._tag === "Success"
                ? null
                : "Worker launch failed. The attempt remains charged; inspect the worker before retrying.",
          },
        ),
      );
    }),
  ).pipe(Effect.mapError((cause) => (isPlanRunError(cause) ? cause : fail(String(cause)))));
