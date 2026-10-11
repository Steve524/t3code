import { describe, expect, it } from "vite-plus/test";

import { decide } from "./decide.ts";
import { engine, end, task } from "./engineTestFixtures.ts";
import type { CrewEvent } from "./types.ts";

const changes = "review/outcome/changes";
function reviewLoop(resetOn?: string[], by: "user" | "lead" = "user") {
  return engine(
    {
      work: { ...task, next: "review" },
      review: {
        ...task,
        outcomes: {
          changes: {
            to: "fix",
            max: 3,
            else: "approval",
            ...(resetOn === undefined ? {} : { resetOn }),
          },
          approve: "approval",
        },
      },
      fix: { ...task, next: "review" },
      approval: {
        type: "gate",
        by,
        prompt: "Approve?",
        outcomes: { reject: "fix", approve: "done" },
      },
      done: end,
    },
    by === "lead" ? { home: { mode: "lead", role: "worker" } } : {},
  );
}
function exhaustReview(run: ReturnType<typeof reviewLoop>) {
  run.start();
  run.complete(run.latest("work"));
  for (let round = 0; round < 3; round++) {
    run.complete(run.latest("review"), "changes");
    run.complete(run.latest("fix"));
  }
  return run.complete(run.latest("review"), "changes");
}

describe("limited routes", () => {
  it("AC 4 counts three send-backs, then takes else without skipping review", () => {
    const run = reviewLoop();
    run.start();
    run.complete(run.latest("work"));
    for (const used of [1, 2, 3]) {
      const result = run.complete(run.latest("review"), "changes");
      expect(result.effects).toContainEqual({
        type: "launch_card",
        cardId: `fix:${used}`,
        attempt: 1,
      });
      expect(run.snapshot.routeCounters[changes]).toBe(used);
      run.complete(run.latest("fix"));
      expect(run.latest("review").state).toBe("dispatching");
    }
    const result = run.complete(run.latest("review"), "changes");
    expect(result.events).toContainEqual({ type: "route.limit_reached", routeId: changes });
    expect(run.latest("approval").state).toBe("needs_you");
    expect(run.snapshot.routeCounters[changes]).toBe(3);
    expect(run.snapshot.visits.review).toBe(4);
  });

  it.each([
    { name: "AC 4a user gate", by: "user" as const, resolver: "user" as const, used: 0 },
    { name: "AC 4b lead gate", by: "lead" as const, resolver: "lead" as const, used: 3 },
    {
      name: "user override of a lead gate",
      by: "lead" as const,
      resolver: "user" as const,
      used: 0,
    },
  ])("$name resets only for the user", ({ by, resolver, used }) => {
    const run = reviewLoop(undefined, by);
    exhaustReview(run);
    run.send({
      type: "gate.resolved",
      cardId: run.latest("approval").id,
      outcome: "reject",
      by: resolver,
      note: "Another round",
    });
    expect(run.snapshot.routeCounters[changes]).toBe(used);
    expect(run.latest("fix").state).toBe("dispatching");
    run.complete(run.latest("fix"));
    expect(run.snapshot.visits.review).toBe(5);
    run.complete(run.latest("review"), "changes");
    expect(run.snapshot.routeCounters[changes]).toBe(used === 0 ? 1 : 3);
    expect(used === 0 ? run.latest("fix").state : run.latest("approval").state).toBe(
      used === 0 ? "dispatching" : "waiting_lead",
    );
  });

  it.each([
    { resetOn: [], used: 3 },
    { resetOn: ["work"], used: 3 },
    { resetOn: ["approval"], used: 0 },
  ])("resetOn=$resetOn overrides region reset", ({ resetOn, used }) => {
    const run = reviewLoop(resetOn);
    exhaustReview(run);
    run.send({
      type: "gate.resolved",
      cardId: run.latest("approval").id,
      outcome: "reject",
      by: "user",
      note: "",
    });
    expect(run.snapshot.routeCounters[changes]).toBe(used);
  });

  it("resetOn applies when the named task finishes, not when it starts", () => {
    const run = reviewLoop(["fix"]);
    run.start();
    run.complete(run.latest("work"));
    run.complete(run.latest("review"), "changes");
    expect(run.snapshot.routeCounters[changes]).toBe(1);
    run.complete(run.latest("fix"));
    expect(run.snapshot.routeCounters[changes]).toBe(0);
  });

  it("a user gate resets only counters in its own compiled loop region", () => {
    const run = engine({
      work: { ...task, next: { to: "work", max: 1, else: "review" } },
      review: { ...task, next: { to: "review", max: 1, else: "gate" } },
      gate: { type: "gate", prompt: "Again?", outcomes: { yes: "review", no: "done" } },
      done: end,
    });
    run.start();
    run.complete(run.latest("work"));
    run.complete(run.latest("work"));
    run.complete(run.latest("review"));
    run.complete(run.latest("review"));
    run.send({
      type: "gate.resolved",
      cardId: run.latest("gate").id,
      outcome: "yes",
      by: "user",
      note: "",
    });
    expect(run.snapshot.routeCounters).toEqual({ "work/next": 1, "review/next": 0 });
  });

  it("keeps counters independent for different outcomes", () => {
    const run = engine({
      work: {
        ...task,
        outcomes: {
          a: { to: "work", max: 1, else: "done" },
          b: { to: "work", max: 2, else: "done" },
        },
      },
      done: end,
    });
    run.start();
    run.complete(run.latest("work"), "a");
    run.complete(run.latest("work"), "b");
    expect(run.snapshot.routeCounters).toEqual({ "work/outcome/a": 1, "work/outcome/b": 1 });
    run.complete(run.latest("work"), "a");
    expect(run.snapshot.status).toBe("completed");
  });
});

describe("outcomes, attempts and lifecycle", () => {
  it.each(["failed", "no_report", "pass"])(
    "explicit %s route takes precedence over next and default handling",
    (outcome) => {
      const run = engine({
        work: { ...task, next: "wrong", outcomes: { [outcome]: "right" } },
        wrong: end,
        right: { ...task, next: "done" },
        done: end,
      });
      run.start();
      const result = run.complete(run.latest("work"), outcome);
      expect(run.latest("right").state).toBe("dispatching");
      expect(run.snapshot.visits.wrong).toBeUndefined();
      expect(result.effects.some((effect) => effect.type === "send_follow_up")).toBe(false);
    },
  );

  it.each([
    { mode: "first-step", policy: "ask", outcome: "no_report", state: "needs_you" },
    { mode: "lead", policy: "ask", outcome: "no_report", state: "waiting_lead" },
    { mode: "lead", policy: "retry-then-ask", outcome: "failed", state: "waiting_lead" },
    { mode: "first-step", policy: "done", outcome: "failed", state: "needs_you" },
  ])(
    "unmapped $outcome with $policy in $mode mode asks without taking next",
    ({ mode, policy, outcome, state }) => {
      const run = engine(
        { work: { ...task, next: "done" }, done: end },
        {
          defaults: { onNoReport: policy },
          home: mode === "lead" ? { mode, role: "worker" } : { mode },
        },
      );
      run.start();
      run.complete(run.latest("work"), outcome);
      expect(run.snapshot.cards.find((card) => card.type === "decision")?.state).toBe(state);
      expect(run.snapshot.visits.done).toBeUndefined();
      expect(run.snapshot.budget.cards).toBe(1);
    },
  );

  it("onNoReport done can be overridden per step", () => {
    const run = engine(
      { work: { ...task, onNoReport: "done", outcomes: { done: "done" } }, done: end },
      { defaults: { onNoReport: "ask" } },
    );
    run.start();
    run.send({ type: "card.turn_finished", cardId: "work:1", attempt: 1, status: "completed" });
    expect(run.snapshot.status).toBe("completed");
  });

  it("AC 24 reminder is one new attempt on the same thread, without changing counters", () => {
    const run = engine({
      work: { ...task, next: { to: "work", max: 3, else: "done" } },
      done: end,
    });
    run.start();
    run.dispatched(run.latest("work"));
    const result = run.send({
      type: "card.turn_finished",
      cardId: "work:1",
      attempt: 1,
      status: "completed",
    });
    expect(result.effects).toContainEqual({
      type: "send_follow_up",
      cardId: "work:1",
      attempt: 2,
      threadId: "thread:work:1",
      reason: "reminder",
    });
    expect(run.snapshot.routeCounters["work/next"]).toBe(0);
    expect(run.snapshot.budget.cards).toBe(2);
    expect(run.latest("work").reminderSent).toBe(true);
    run.dispatched(run.latest("work"));
    run.send({ type: "card.turn_finished", cardId: "work:1", attempt: 2, status: "completed" });
    expect(run.snapshot.cards.filter((card) => card.type === "decision")).toHaveLength(1);
    expect(run.snapshot.budget.cards).toBe(2);
  });

  it("a failed turn skips the reminder, while a recorded report wins over turn status", () => {
    const failed = engine({ work: { ...task, next: "done" }, done: end });
    failed.start();
    failed.send({ type: "card.turn_finished", cardId: "work:1", attempt: 1, status: "failed" });
    expect(failed.snapshot.cards.find((card) => card.type === "decision")?.state).toBe("needs_you");
    const reported = engine({ work: { ...task, next: "done" }, done: end });
    reported.start();
    reported.send({
      type: "card.reported",
      cardId: "work:1",
      attempt: 1,
      outcome: "done",
      summary: "Saved",
      artifacts: { answer: 42 },
    });
    expect(reported.snapshot.visits.done).toBeUndefined();
    expect(reported.snapshot.artifacts).toEqual({});
    reported.send({ type: "card.turn_finished", cardId: "work:1", attempt: 1, status: "failed" });
    expect(reported.snapshot.status).toBe("completed");
    expect(reported.snapshot.artifacts).toEqual({ answer: 42 });
  });

  it("ignores callbacks for previous attempts and duplicate completion", () => {
    const run = engine({ work: { ...task, next: "later" }, later: task });
    run.start();
    run.dispatched(run.latest("work"));
    run.send({ type: "card.turn_finished", cardId: "work:1", attempt: 1, status: "completed" });
    run.send({
      type: "card.reported",
      cardId: "work:1",
      attempt: 1,
      outcome: "done",
      summary: "late",
      artifacts: {},
    });
    run.complete({ ...run.latest("work"), attempt: 1 });
    expect(run.snapshot.visits.later).toBeUndefined();
    run.complete(run.latest("work"));
    run.send({ type: "card.turn_finished", cardId: "work:1", attempt: 2, status: "completed" });
    expect(run.snapshot.visits.later).toBe(1);
  });

  it("manual retry has its own attempt and budget usage, with no route traversal", () => {
    const run = engine(
      { work: { ...task, next: { to: "work", max: 2, else: "done" } }, done: end },
      { defaults: { onNoReport: "ask" } },
    );
    run.start();
    run.dispatched(run.latest("work"));
    run.complete(run.latest("work"), "no_report");
    run.send({ type: "user.card_action", cardId: "work:1", action: "retry" });
    expect(run.latest("work")).toMatchObject({ attempt: 2, state: "dispatching" });
    expect(run.snapshot.budget.cards).toBe(2);
    expect(run.snapshot.routeCounters["work/next"]).toBe(0);
    expect(run.snapshot.cards.find((card) => card.type === "decision")?.state).toBe("skipped");
  });

  it("escalation lets the user resolve a lead decision and refuses the lead afterwards", () => {
    const run = engine(
      { work: { ...task, next: "done" }, done: end },
      { home: { mode: "lead", role: "worker" }, defaults: { onNoReport: "ask" } },
    );
    run.start();
    run.complete(run.latest("work"), "no_report");
    const cardId = run.snapshot.cards.find((card) => card.type === "decision")!.id;
    run.send({ type: "gate.escalated", cardId, reason: "Need a person" });
    expect(() =>
      run.send({ type: "gate.resolved", cardId, by: "lead", outcome: "done", note: "" }),
    ).toThrow("Only the user");
    run.send({ type: "gate.resolved", cardId, by: "user", outcome: "done", note: "Go" });
    expect(run.snapshot.status).toBe("completed");
  });

  it.each([0, 1])(
    "script exit %i routes to pass/fail and uses one card budget slot",
    (exitCode) => {
      const run = engine({
        work: { type: "script", run: "true", outcomes: { pass: "yes", fail: "no" } },
        yes: end,
        no: { type: "end", status: "failed" },
      });
      expect(run.start().effects).toContainEqual({
        type: "run_script",
        cardId: "work:1",
        attempt: 1,
      });
      run.send({
        type: "script.finished",
        cardId: "work:1",
        attempt: 1,
        exitCode,
        outputTail: "result",
      });
      expect(run.snapshot.status).toBe(exitCode === 0 ? "completed" : "failed");
      expect(run.snapshot.budget.cards).toBe(1);
    },
  );
});

describe("pause, cancel and purity", () => {
  it("pause lets a working card finish, queues its successor, and resume dispatches it", () => {
    const run = engine({
      work: { ...task, next: "later" },
      later: { ...task, next: "done" },
      done: end,
    });
    run.start();
    run.send({ type: "run.paused" }, 1_000);
    expect(run.complete(run.latest("work"), "done", 2_000).effects).toEqual([]);
    expect(run.latest("later").state).toBe("queued");
    expect(run.snapshot.status).toBe("paused");
    expect(run.send({ type: "run.resumed" }, 3_000).effects).toContainEqual({
      type: "launch_card",
      cardId: "later:1",
      attempt: 1,
    });
  });

  it("cancel stops active cards and cannot dispatch or resume a terminal run", () => {
    const run = engine({ work: { ...task, next: "later" }, later: task });
    run.start();
    run.dispatched(run.latest("work"));
    const result = run.send({ type: "run.cancel_requested" });
    expect(result.effects).toContainEqual({
      type: "stop_thread",
      cardId: "work:1",
      attempt: 1,
      threadId: "thread:work:1",
    });
    expect(run.snapshot.status).toBe("cancelled");
    expect(run.send({ type: "run.resumed" }).effects).toEqual([]);
    expect(run.complete(run.latest("work")).effects).toEqual([]);
    expect(run.snapshot.visits.later).toBeUndefined();
  });

  it("is deterministic, does not mutate input, and survives a JSON snapshot roundtrip", () => {
    const run = engine({ work: { ...task, next: "done" }, done: end });
    run.start();
    const before = JSON.stringify(run.snapshot);
    const event: CrewEvent = {
      type: "card.completed",
      cardId: "work:1",
      attempt: 1,
      outcome: "done",
      seq: 2,
      at: 500,
    };
    const first = decide(run.snapshot, event);
    expect(JSON.stringify(run.snapshot)).toBe(before);
    expect(decide(JSON.parse(before), event)).toEqual(first);
    expect(first.snapshot.budget.activeSeconds).toBe(0.5);
    expect(decide(first.snapshot, event).effects).toEqual([]);
  });

  it("rejects backwards event time without modifying the previous snapshot", () => {
    const run = engine({ work: task });
    run.start();
    run.send({ type: "run.paused" }, 10);
    const before = JSON.stringify(run.snapshot);
    expect(() => run.send({ type: "run.resumed" }, 9)).toThrow("timestamps");
    expect(JSON.stringify(run.snapshot)).toBe(before);
  });
});
