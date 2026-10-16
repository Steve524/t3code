import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runForkMigrations } from "../persistence/ForkMigrations.ts";
import { makeCrewRunStore, type CrewRunRecord, type CrewCardRow } from "./CrewRunStore.ts";
import { buildCrewRunView } from "./crewRunView.ts";
import { engine, end, task, led } from "./engine/engineTestFixtures.ts";
import { decide } from "./engine/decide.ts";
import type { CrewEvent } from "./engine/types.ts";

const selection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
function record(run: ReturnType<typeof engine>): CrewRunRecord {
  return {
    runId: "run",
    projectId: ProjectId.make("project"),
    crewId: "example",
    crew: run.snapshot.crew,
    files: {},
    scriptTools: {},
    start: {
      projectId: ProjectId.make("project"),
      crewId: "example",
      inputs: { brief: "Build it" },
      attachments: [],
      workspace: { mode: "current-checkout" },
      runtimeMode: "full-access",
      clientRequestId: "request",
    },
    inputs: { brief: "Build it" },
    roles: {
      worker: {
        name: "Worker",
        modelSelection: selection,
        driver: "codex",
        runtimeMode: "full-access",
      },
    },
    toolboxes: {
      worker: {
        skills: [],
        mcp: [{ name: "storybook", source: "repo", command: "old-command", args: [], env: {} }],
        tools: [],
      },
    },
    toolboxMode: "extend",
    homeThreadId: ThreadId.make("home"),
    integrationBranch: null,
    integrationWorktree: null,
    snapshot: run.snapshot,
    createdAt: "2026-10-14T10:00:00Z",
    updatedAt: "2026-10-14T10:00:00Z",
  };
}
function rows(run: CrewRunRecord): CrewCardRow[] {
  return run.snapshot.cards.map((card) => ({
    cardId: `${run.runId}:${card.id}`,
    stepId: card.stepId,
    stepType: card.type,
    visit: card.visit,
    itemIndex: card.itemIndex,
    roleId: card.roleId,
    modelSelection: selection,
    threadId: card.threadId === null ? null : ThreadId.make(card.threadId),
    state: card.state,
    attempt: card.attempt,
    outcome: card.outcome,
    summary: card.report?.summary ?? card.note,
    gate: null,
    decidedBy: card.decidedBy,
    sourceCardId: card.sourceCardId,
    branch: null,
    worktreePath: null,
    ownershipViolations: [],
    startedAt: null,
    finishedAt: null,
    updatedAt: run.updatedAt,
  }));
}

describe("board control and persisted display data", () => {
  it("derives columns from card step types without crew board settings", () => {
    const run = engine({
      work: { ...task, next: "check" },
      check: { ...task, next: "approval" },
      approval: { type: "gate", prompt: "Ship?", outcomes: { yes: "done" } },
      done: end,
    });
    run.start();
    run.complete(run.latest("work"));
    run.complete(run.latest("check"));
    const saved = record(run);
    const view = buildCrewRunView(saved, rows(saved), { toolbox: false });
    expect(view.cards.map((card) => card.column)).toEqual(["task", "task", "gate"]);
    expect(view.columns).toEqual([
      { id: "task", label: "task" },
      { id: "gate", label: "gate" },
    ]);
  });

  it("stops without routing even with onNoReport: done, waits for acknowledgement, then retries", () => {
    const run = engine({
      work: { ...task, onNoReport: "done", next: "next" },
      next: { ...task, next: "done" },
      done: end,
    });
    run.start();
    run.dispatched(run.latest("work"));
    const stopping = run.send({ type: "user.card_action", cardId: "work:1", action: "stop" });
    expect(stopping.effects).toContainEqual({
      type: "stop_thread",
      cardId: "work:1",
      attempt: 1,
      threadId: "thread:work:1",
    });
    run.send({ type: "user.card_action", cardId: "work:1", action: "retry" });
    expect(run.latest("work").attempt).toBe(1);
    run.send({ type: "card.turn_finished", cardId: "work:1", attempt: 1, status: "cancelled" });
    expect(run.latest("work")).toMatchObject({
      state: "blocked",
      outcome: "failed",
      note: "Stopped by you.",
    });
    expect(run.snapshot.visits.next).toBeUndefined();
    run.send({ type: "user.card_action", cardId: "work:1", action: "retry" });
    expect(run.latest("work")).toMatchObject({ state: "dispatching", attempt: 2 });
    run.send({ type: "user.card_action", cardId: "work:1", action: "stop" });
    expect(run.latest("work").state).toBe("dispatching");
    run.send({ type: "card.turn_finished", cardId: "work:1", attempt: 1, status: "cancelled" });
    expect(run.latest("work").state).toBe("dispatching");
  });
  it("records route entry separately from attempts and retains it after counters reset", () => {
    const run = engine({
      work: {
        ...task,
        outcomes: { changes: { to: "fix", max: 3, else: "done", label: "Review send-backs" } },
      },
      fix: { ...task, next: "work" },
      done: end,
    });
    run.start();
    run.complete(run.latest("work"), "changes");
    run.complete(run.latest("fix"));
    run.complete(run.latest("work"), "changes");
    const fix = run.latest("fix");
    run.dispatched(fix);
    run.send({ type: "user.card_action", cardId: fix.id, action: "stop" });
    run.send({ type: "card.turn_finished", cardId: fix.id, attempt: 1, status: "cancelled" });
    run.send({ type: "user.card_action", cardId: fix.id, action: "retry" });
    run.send({
      type: "route.counters_reset",
      regionId: "user",
      routeIds: ["work/outcome/changes"],
      cause: "user",
    });
    const saved = record(run);
    const view = buildCrewRunView(saved, rows(saved), { toolbox: false });
    expect(view.cards.find((card) => card.cardId === `run:${fix.id}`)).toMatchObject({
      attempt: 2,
      enteredVia: { id: "work/outcome/changes", used: 2, max: 3 },
    });
    expect(view.routes[0]).toMatchObject({ used: 0, max: 3, label: "Review send-backs" });
  });
  it("records script exits, output tails, merge counts and conflicts", () => {
    const run = engine({
      work: { type: "script", run: "check", next: "merge" },
      merge: { type: "merge", next: "done" },
      done: end,
    });
    run.start();
    run.send({
      type: "script.finished",
      cardId: "work:1",
      attempt: 1,
      exitCode: 7,
      outputTail: "Failed check",
    });
    // Script failures without a mapped fail route ask for an outcome.
    expect(run.latest("work").scriptExitCode).toBe(7);
    expect(run.latest("work").report?.summary).toBe("Failed check");
    const mergeRun = engine({
      work: { ...task, next: "merge" },
      merge: { type: "merge", next: "done" },
      done: end,
    });
    mergeRun.start();
    mergeRun.complete(mergeRun.latest("work"));
    mergeRun.send({ type: "merge.started", cardId: "merge:1" });
    mergeRun.send({ type: "merge.card_merged", cardId: "merge:1", sourceCardId: "work:1" });
    mergeRun.send({ type: "merge.conflict", cardId: "merge:1", paths: ["src/a.ts"] });
    const saved = record(mergeRun);
    const view = buildCrewRunView(saved, rows(saved), { toolbox: false });
    expect(view.cards.find((card) => card.stepType === "merge")).toMatchObject({
      mergedCount: 1,
      conflictPaths: ["src/a.ts"],
      lane: "needs_you",
    });
  });
  it("keeps frozen toolboxes out of streams and shows budget extensions on reload", () => {
    const run = engine({ work: { ...task, next: "done" }, done: end });
    run.start();
    run.send({ type: "budget.extended", kind: "maxCards", by: 20 });
    const saved = record(run);
    expect(buildCrewRunView(saved, rows(saved), { toolbox: false }).roles[0]).not.toHaveProperty(
      "toolbox",
    );
    expect(
      buildCrewRunView(saved, rows(saved), { toolbox: true }).roles[0]?.toolbox?.mcp[0]?.command,
    ).toBe("old-command");
    expect(buildCrewRunView(saved, rows(saved), { toolbox: false }).budget.cards.extended).toBe(20);
  });
  it("moves only the lead decision into needs-you after escalation and records the user's answer", () => {
    const run = engine(
      { work: { ...task, onNoReport: "ask", outcomes: { done: "done" } }, done: end },
      led,
    );
    run.start();
    run.send({ type: "card.turn_finished", cardId: "work:1", attempt: 1, status: "completed" });
    const decision = run.snapshot.cards.find((card) => card.type === "decision")!;
    const before = record(run);
    expect(
      buildCrewRunView(before, rows(before), { toolbox: false }).cards.filter(
        (card) => card.lane === "needs_you",
      ),
    ).toHaveLength(0);
    run.send({ type: "gate.escalated", cardId: decision.id, reason: "Need your judgment" });
    const after = record(run);
    expect(
      buildCrewRunView(after, rows(after), { toolbox: false }).cards.filter(
        (card) => card.lane === "needs_you",
      ),
    ).toMatchObject([{ note: "Need your judgment" }]);
    run.send({
      type: "gate.resolved",
      cardId: decision.id,
      outcome: "done",
      note: "Approved",
      by: "user",
    });
    expect(run.snapshot.cards.find((card) => card.id === decision.id)).toMatchObject({
      decidedBy: "user",
      state: "done",
      note: "Approved",
    });
  });

  it.effect("lists persisted briefs and all role threads, and counts a budget gate once", () =>
    Effect.gen(function* () {
      yield* runForkMigrations();
      const sql = yield* SqlClient.SqlClient;
      const store = makeCrewRunStore(sql);
      const run = engine({ work: { ...task, next: "done" }, done: end });
      run.start();
      run.send({ type: "budget.exhausted", kind: "maxCards" });
      const saved = record(run);
      yield* store.insertRun({ ...saved, crewHash: "hash" });
      yield* store.setHome("run", {
        threadId: ThreadId.make("home"),
        worktree: null,
        branch: null,
      });
      yield* sql`INSERT INTO fork_crew_thread_index (thread_id, run_id, card_id, attempt) VALUES ('home', 'run', 'work:1', 1), ('role-old', 'run', 'work:1', 1), ('role-new', 'run', 'work:1', 2)`;
      const summaries = yield* store.listRuns(saved.projectId, undefined);
      expect(summaries).toMatchObject([
        { brief: "Build it", needsYou: 1, cardThreadIds: ["role-old", "role-new"] },
      ]);
      yield* sql`UPDATE fork_crew_runs SET status = 'cancelled' WHERE run_id = 'run'`;
      expect((yield* store.listRuns(saved.projectId, undefined))[0]?.needsYou).toBe(0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("starts the retry's elapsed time at its own dispatch and clears the stop note", () =>
    Effect.gen(function* () {
      yield* runForkMigrations();
      const sql = yield* SqlClient.SqlClient;
      const store = makeCrewRunStore(sql);
      const saved = record(engine({ work: { ...task, next: "done" }, done: end }));
      yield* store.insertRun({ ...saved, crewHash: "hash" });
      const events: CrewEvent[] = [
        { type: "run.created", seq: 1, at: 0 },
        {
          type: "card.dispatched",
          cardId: "work:1",
          attempt: 1,
          threadId: "home",
          orchestrationRunId: "turn-1",
          seq: 2,
          at: 60_000,
        },
        { type: "user.card_action", cardId: "work:1", action: "stop", seq: 3, at: 120_000 },
        {
          type: "card.turn_finished",
          cardId: "work:1",
          attempt: 1,
          status: "cancelled",
          seq: 4,
          at: 180_000,
        },
        { type: "user.card_action", cardId: "work:1", action: "retry", seq: 5, at: 240_000 },
        {
          type: "card.dispatched",
          cardId: "work:1",
          attempt: 2,
          threadId: "home",
          orchestrationRunId: "turn-2",
          seq: 6,
          at: 300_000,
        },
      ];
      for (const event of events) {
        const run = (yield* store.getRun("run"))!;
        const result = decide(run.snapshot, event);
        yield* store.commit({
          run,
          event,
          ...result,
          at: DateTime.formatIso(DateTime.makeUnsafe(event.at)),
        });
      }
      expect((yield* store.listCards("run"))[0]).toMatchObject({
        attempt: 2,
        startedAt: "1970-01-01T00:05:00.000Z",
        summary: null,
        state: "working",
      });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
