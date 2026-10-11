import { describe, expect, it } from "vite-plus/test";

import { engine, end, task } from "./engineTestFixtures.ts";

describe("decision and join races", () => {
  it("forcing a blocked card closes its old decision so a late answer cannot route twice", () => {
    const run = engine(
      { work: { ...task, next: "after" }, after: task },
      { defaults: { onNoReport: "ask" } },
    );
    run.start();
    run.complete(run.latest("work"), "no_report");
    const cardId = run.snapshot.cards.find((card) => card.type === "decision")!.id;
    run.send({
      type: "user.card_action",
      cardId: "work:1",
      action: "force_outcome",
      outcome: "done",
    });
    expect(run.snapshot.cards.find((card) => card.id === cardId)?.state).toBe("skipped");
    run.send({ type: "gate.resolved", cardId, by: "user", outcome: "done", note: "late" });
    expect(run.snapshot.visits.after).toBe(1);
  });

  it("skip without a mapped skipped outcome asks, even with an unconditional next", () => {
    const run = engine(
      { work: { ...task, next: "after" }, after: task },
      { defaults: { onNoReport: "ask" } },
    );
    run.start();
    run.complete(run.latest("work"), "no_report");
    run.send({ type: "user.card_action", cardId: "work:1", action: "skip" });
    expect(run.snapshot.visits.after).toBeUndefined();
    const decisions = run.snapshot.cards.filter((card) => card.type === "decision");
    expect(decisions.map((card) => card.state)).toEqual(["skipped", "needs_you"]);
    expect(new Set(decisions.map((card) => card.id)).size).toBe(2);
  });

  it("join any discards a cancelled nested fanout's budget gate", () => {
    const run = engine(
      {
        work: { type: "parallel", branches: ["a", "b"], join: "any", next: "after" },
        a: task,
        b: { ...task, next: "fan" },
        fan: { ...task, type: "fanout", over: "artifacts.items" },
        after: task,
      },
      {},
      { artifacts: { items: Array.from({ length: 20 }, (_, i) => i) } },
    );
    run.start();
    run.complete(run.latest("b"));
    expect(run.snapshot.budgetGate?.kind).toBe("maxFanoutItems");
    run.complete(run.latest("a"));
    expect(run.snapshot.budgetGate).toBeNull();
    expect(run.latest("after").state).toBe("dispatching");
    expect(run.snapshot.cards.some((card) => card.stepId === "fan")).toBe(false);
  });

  it("a late dispatch acknowledgement for a losing branch emits a stop for its actual thread", () => {
    const run = engine({
      work: { type: "parallel", branches: ["a", "b"], join: "any", next: "after" },
      a: task,
      b: task,
      after: task,
    });
    run.start();
    run.complete(run.latest("a"));
    const result = run.dispatched(run.latest("b"));
    expect(result.effects).toContainEqual({
      type: "stop_thread",
      cardId: "b:1",
      attempt: 1,
      threadId: "thread:b:1",
    });
    expect(run.latest("b").state).toBe("stopping");
  });

  it("resetOn of a fanout step runs at the join, not on the first item", () => {
    const run = engine(
      {
        work: { ...task, next: { to: "fan", max: 2, else: "done", resetOn: ["fan"] } },
        fan: { ...task, type: "fanout", over: "artifacts.items", next: "work" },
        done: end,
      },
      {},
      { artifacts: { items: [1, 2] } },
    );
    run.start();
    run.complete(run.latest("work"));
    expect(run.snapshot.routeCounters["work/next"]).toBe(1);
    run.complete(run.snapshot.cards.find((card) => card.id === "fan:1:0")!);
    expect(run.snapshot.routeCounters["work/next"]).toBe(1);
    run.complete(run.snapshot.cards.find((card) => card.id === "fan:1:1")!);
    expect(run.snapshot.routeCounters["work/next"]).toBe(0);
  });

  it("a user decision on a fanout item resets the containing loop region", () => {
    const run = engine(
      {
        work: { ...task, next: { to: "fan", max: 2, else: "done" } },
        fan: { ...task, type: "fanout", over: "artifacts.items", next: "work" },
        done: end,
      },
      { defaults: { onNoReport: "ask" } },
      { artifacts: { items: [1, 2] } },
    );
    run.start();
    run.complete(run.latest("work"));
    run.complete(
      run.snapshot.cards.find((card) => card.id === "fan:1:0")!,
      "no_report",
    );
    const cardId = run.snapshot.cards.find((card) => card.type === "decision")!.id;
    run.send({ type: "gate.resolved", cardId, by: "user", outcome: "done", note: "" });
    expect(run.snapshot.routeCounters["work/next"]).toBe(0);
    expect(run.snapshot.groups[0]?.finished).toEqual([0]);
  });

  it("a card that reported before its launch returned still takes its thread", () => {
    const run = engine({
      work: { ...task, next: "fix" },
      fix: { ...task, continue: "same-thread" },
    });
    run.start();
    const work = run.latest("work");
    run.send({
      type: "card.reported",
      cardId: work.id,
      attempt: 1,
      outcome: "done",
      summary: "Reported during launch.",
      artifacts: {},
    });
    run.dispatched(work);
    expect(run.latest("work")).toMatchObject({ state: "reported", threadId: "thread:work:1" });
    const finished = run.send({
      type: "card.turn_finished",
      cardId: work.id,
      attempt: 1,
      status: "completed",
    });
    // The follow-up step can only reuse the thread if the card kept it.
    expect(finished.effects).toContainEqual({
      type: "send_follow_up",
      cardId: "fix:1",
      attempt: 1,
      threadId: "thread:work:1",
      reason: "continue",
    });
  });
});
