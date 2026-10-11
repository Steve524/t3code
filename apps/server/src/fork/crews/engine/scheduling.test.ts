import { describe, expect, it } from "vite-plus/test";

import { engine, end, task, worker } from "./engineTestFixtures.ts";

function fanout(
  count: number,
  extra: Record<string, unknown> = {},
  options: Parameters<typeof engine>[2] = {},
) {
  return engine(
    {
      work: { ...task, next: "fan" },
      fan: { ...task, type: "fanout", over: "artifacts.plan.tasks", maxParallel: 3, next: "done" },
      done: end,
    },
    extra,
    {
      ...options,
      artifacts: {
        plan: { tasks: Array.from({ length: count }, (_, index) => ({ title: `Task ${index}` })) },
      },
    },
  );
}
const activeStates = new Set(["dispatching", "working", "reported", "stopping"]);

describe("dispatch caps and joins", () => {
  it("AC 2 three working, one queued; a completion starts the queued item", () => {
    const run = fanout(4);
    run.start();
    run.complete(run.latest("work"));
    for (const card of run.snapshot.cards.filter((card) => card.state === "dispatching"))
      run.dispatched(card);
    expect(
      run.snapshot.cards.filter((card) => card.stepId === "fan").map((card) => card.state),
    ).toEqual(["working", "working", "working", "queued"]);
    const result = run.complete(run.snapshot.cards.find((card) => card.stepId === "fan")!);
    expect(result.effects).toContainEqual({ type: "launch_card", cardId: "fan:1:3", attempt: 1 });
    expect(run.snapshot.cards.filter((card) => activeStates.has(card.state))).toHaveLength(3);
  });

  it.each([
    { name: "run cap", extra: { defaults: { maxParallel: 2 } }, options: {}, count: 2 },
    {
      name: "role cap",
      extra: { roles: { worker: { ...worker, maxConcurrent: 1 } } },
      options: {},
      count: 1,
    },
    {
      name: "provider-instance cap",
      extra: {},
      options: { roleInstances: { worker: "provider-a" }, providerCaps: { "provider-a": 2 } },
      count: 2,
    },
    {
      name: "shared writer lock",
      extra: { defaults: { isolation: "shared" } },
      options: {},
      count: 1,
    },
    {
      name: "read-only does not acquire writer lock",
      extra: { defaults: { isolation: "read-only" } },
      options: {},
      count: 3,
    },
  ])("honors $name before emitting effects", ({ extra, options, count }) => {
    const run = fanout(4, extra, options);
    run.start();
    const result = run.complete(run.latest("work"));
    expect(result.effects.filter((effect) => effect.type === "launch_card")).toHaveLength(count);
    expect(run.snapshot.cards.filter((card) => card.state === "dispatching")).toHaveLength(count);
  });

  it("provider caps are shared across roles", () => {
    const run = engine(
      {
        work: { type: "parallel", branches: ["a", "b"], next: "done" },
        a: task,
        b: { ...task, role: "other" },
        done: end,
      },
      { roles: { worker, other: worker } },
      { roleInstances: { worker: "p", other: "p" }, providerCaps: { p: 1 } },
    );
    run.start();
    expect(run.latest("a").state).toBe("dispatching");
    expect(run.latest("b").state).toBe("queued");
    run.complete(run.latest("a"));
    expect(run.latest("b").state).toBe("dispatching");
  });

  it.each(["all", "any"] as const)("parallel join %s advances exactly once", (join) => {
    const run = engine({
      work: { type: "parallel", branches: ["a", "b"], join, next: "after" },
      a: task,
      b: task,
      after: { ...task, next: "done" },
      done: end,
    });
    run.start();
    run.dispatched(run.latest("a"));
    run.dispatched(run.latest("b"));
    const result = run.complete(run.latest("a"));
    if (join === "all") {
      expect(run.snapshot.visits.after).toBeUndefined();
      run.complete(run.latest("b"));
    } else {
      expect(result.effects).toContainEqual({
        type: "stop_thread",
        cardId: "b:1",
        attempt: 1,
        threadId: "thread:b:1",
      });
      expect(run.latest("b").state).toBe("stopping");
      run.complete(run.latest("b"));
      expect(run.latest("b").state).toBe("cancelled");
    }
    expect(run.snapshot.visits.after).toBe(1);
    run.complete(run.latest("a"));
    expect(run.snapshot.visits.after).toBe(1);
  });

  it.each(["all", "any"] as const)(
    "fanout join %s keeps queued siblings from escaping the join",
    (join) => {
      const run = engine(
        {
          work: {
            ...task,
            type: "fanout",
            over: "artifacts.items",
            join,
            maxParallel: 2,
            next: "after",
          },
          after: task,
        },
        {},
        { artifacts: { items: [1, 2, 3] } },
      );
      run.start();
      run.complete(run.snapshot.cards[0]!);
      if (join === "any") {
        expect(run.snapshot.cards.find((card) => card.itemIndex === 2)?.state).toBe("skipped");
        expect(run.snapshot.cards.find((card) => card.itemIndex === 1)?.state).toBe("stopping");
      } else {
        expect(run.snapshot.visits.after).toBeUndefined();
        run.complete(run.snapshot.cards.find((card) => card.itemIndex === 1)!);
        run.complete(run.snapshot.cards.find((card) => card.itemIndex === 2)!);
      }
      expect(run.snapshot.visits.after).toBe(1);
    },
  );

  it("nested joins respect the ancestor cap and finish inner branches before the outer join", () => {
    const run = engine({
      work: { type: "parallel", maxParallel: 2, branches: ["inner", "right"], next: "done" },
      inner: { type: "parallel", branches: ["a", "b"], next: "after" },
      a: task,
      b: task,
      after: task,
      right: task,
      done: end,
    });
    run.start();
    expect(run.snapshot.cards.filter((card) => card.state === "dispatching")).toHaveLength(2);
    expect(run.latest("b").state).toBe("queued");
    run.complete(run.latest("right"));
    expect(run.latest("b").state).toBe("dispatching");
    run.complete(run.latest("a"));
    expect(run.snapshot.visits.after).toBeUndefined();
    run.complete(run.latest("b"));
    expect(run.latest("after").state).toBe("dispatching");
    expect(run.snapshot.visits.done).toBeUndefined();
    run.complete(run.latest("after"));
    expect(run.snapshot.status).toBe("completed");
  });

  it("a branch explicitly reaching the group's next target waits at the join", () => {
    const run = engine({
      work: { type: "parallel", branches: ["a", "b"], next: "after" },
      a: { ...task, next: "after" },
      b: task,
      after: task,
    });
    run.start();
    run.complete(run.latest("a"));
    expect(run.snapshot.visits.after).toBeUndefined();
    run.complete(run.latest("b"));
    expect(run.snapshot.visits.after).toBe(1);
  });

  it("a stopped sibling holds its capacity until the stop finishes", () => {
    const run = engine(
      {
        work: { type: "parallel", branches: ["a", "b"], join: "any", next: "after" },
        a: task,
        b: task,
        after: { type: "parallel", branches: ["c", "d"], next: "done" },
        c: task,
        d: task,
        done: end,
      },
      { defaults: { maxParallel: 2 } },
    );
    run.start();
    run.complete(run.latest("a"));
    expect(run.latest("b").state).toBe("stopping");
    expect(run.latest("c").state).toBe("dispatching");
    expect(run.latest("d").state).toBe("queued");
    run.complete(run.latest("b"));
    expect(run.latest("d").state).toBe("dispatching");
  });

  it("an empty fanout joins without dispatching an agent", () => {
    const run = fanout(0);
    run.start();
    const result = run.complete(run.latest("work"));
    expect(run.snapshot.status).toBe("completed");
    expect(result.effects.filter((effect) => effect.type === "launch_card")).toEqual([]);
  });
});

describe("budgets", () => {
  it.each(["first-step", "lead"])(
    "AC 21 asks the user before launching any of 20 items in %s mode",
    (mode) => {
      const run = fanout(20, { home: mode === "lead" ? { mode, role: "worker" } : { mode } });
      run.start();
      const result = run.complete(run.latest("work"));
      expect(result.effects.filter((effect) => effect.type === "launch_card")).toEqual([]);
      expect(run.snapshot.cards.filter((card) => card.stepId === "fan")).toEqual([]);
      expect(run.snapshot.budgetGate).toEqual({
        kind: "maxFanoutItems",
        by: "user",
        groupId: "fan:1",
        total: 20,
        choices: ["all", "first", "stop"],
      });
      expect(run.snapshot.status).toBe("waiting");
    },
  );

  it.each([
    { choice: "all" as const, count: 20, limit: 20 },
    { choice: "first" as const, count: 12, limit: 12 },
    { choice: "stop" as const, count: 0, limit: 12 },
  ])("fanout choice $choice dispatches only the selected items", ({ choice, count, limit }) => {
    const run = fanout(20);
    run.start();
    run.complete(run.latest("work"));
    run.send({ type: "budget.fanout_selected", groupId: "fan:1", choice });
    expect(run.snapshot.cards.filter((card) => card.stepId === "fan")).toHaveLength(count);
    expect(run.snapshot.budget.limits.maxFanoutItems).toBe(limit);
    expect(run.snapshot.budgetGate).toBeNull();
    if (choice === "stop") expect(run.snapshot.status).toBe("cancelled");
    else
      expect(
        run.snapshot.cards.filter((card) => card.stepId === "fan").map((card) => card.item),
      ).toEqual(Array.from({ length: count }, (_, index) => ({ title: `Task ${index}` })));
  });

  it("fanout extensions unblock a group and apply only to the run", () => {
    const run = fanout(20);
    run.start();
    run.complete(run.latest("work"));
    run.send({ type: "budget.extended", kind: "maxFanoutItems", by: 8 });
    expect(run.snapshot.budget.limits.maxFanoutItems).toBe(20);
    expect(run.snapshot.cards.filter((card) => card.stepId === "fan")).toHaveLength(20);
    expect(run.snapshot.crew.limits).toBeUndefined();
  });

  it("AC 22 blocks the 61st dispatch, lets active cards finish, then extends by 20", () => {
    const run = fanout(64, {
      home: { mode: "lead", role: "worker" },
      limits: { maxFanoutItems: 100 },
    });
    run.start();
    run.complete(run.latest("work"));
    while (run.snapshot.budget.cards < 60)
      run.complete(run.snapshot.cards.find((card) => card.state === "dispatching")!);
    const result = run.complete(run.snapshot.cards.find((card) => card.state === "dispatching")!);
    expect(run.snapshot.budgetGate).toMatchObject({ kind: "maxCards", by: "user" });
    expect(run.snapshot.budget.cards).toBe(60);
    expect(result.effects.filter((effect) => effect.type === "launch_card")).toEqual([]);
    for (const card of run.snapshot.cards.filter((card) => card.state === "dispatching"))
      run.complete(card);
    expect(run.snapshot.cards.some((card) => card.state === "queued")).toBe(true);
    expect(run.snapshot.status).toBe("waiting");
    const extended = run.send({ type: "budget.extended", kind: "maxCards", by: 20 });
    expect(run.snapshot.budget.limits.maxCards).toBe(80);
    expect(extended.effects.filter((effect) => effect.type === "launch_card")).toHaveLength(3);
    expect(run.snapshot.budget.cards).toBe(63);
  });

  it("gates do not count and reminders cannot bypass maxCards", () => {
    const run = engine(
      {
        work: { ...task, next: "gate" },
        gate: { type: "gate", prompt: "Done?", outcomes: { yes: "done" } },
        done: end,
      },
      { limits: { maxCards: 1 } },
    );
    run.start();
    run.dispatched(run.latest("work"));
    const result = run.send({
      type: "card.turn_finished",
      cardId: "work:1",
      attempt: 1,
      status: "completed",
    });
    expect(result.effects.some((effect) => effect.type === "send_follow_up")).toBe(false);
    expect(run.snapshot.budget.cards).toBe(1);
    expect(run.snapshot.budgetGate?.kind).toBe("maxCards");
    run.send({ type: "budget.extended", kind: "maxCards", by: 1 });
    expect(run.snapshot.budget.cards).toBe(2);
    run.complete(run.latest("work"));
    expect(run.latest("gate").state).toBe("needs_you");
    expect(run.snapshot.budget.cards).toBe(2);
  });

  it("AC 23 ten hours waiting on a user gate do not count as active time", () => {
    const run = engine(
      {
        work: { ...task, next: "gate" },
        gate: { type: "gate", prompt: "Continue?", outcomes: { yes: "after" } },
        after: task,
      },
      { limits: { maxHours: 1 } },
    );
    run.start();
    run.complete(run.latest("work"), "done", 1_000);
    expect(run.snapshot.activeSince).toBeNull();
    run.send(
      { type: "gate.resolved", cardId: "gate:1", outcome: "yes", by: "user", note: "" },
      36_001_000,
    );
    expect(run.snapshot.budget.activeSeconds).toBe(1);
    expect(run.snapshot.budgetGate).toBeNull();
    expect(run.latest("after").state).toBe("dispatching");
  });

  it("maxHours closes event intervals, opens a user gate and resumes after extension", () => {
    const run = engine(
      { work: { ...task, next: "after" }, after: task },
      { limits: { maxHours: 1 } },
    );
    run.start();
    const result = run.complete(run.latest("work"), "done", 3_600_000);
    expect(run.snapshot.budget.activeSeconds).toBe(3_600);
    expect(run.snapshot.budgetGate).toMatchObject({ kind: "maxHours", by: "user" });
    expect(result.effects.filter((effect) => effect.type === "launch_card")).toEqual([]);
    run.send({ type: "budget.extended", kind: "maxHours", by: 2 }, 40_000_000);
    expect(run.snapshot.budget.activeSeconds).toBe(3_600);
    expect(run.latest("after").state).toBe("dispatching");
  });

  it("overlapping cards count one active interval, and pause excludes elapsed time even with a running card", () => {
    const run = fanout(4);
    run.start();
    run.complete(run.latest("work"));
    run.send({ type: "run.paused" }, 1_000);
    run.send({ type: "run.resumed" }, 36_001_000);
    run.complete(
      run.snapshot.cards.find((card) => card.stepId === "fan")!,
      "done",
      36_002_000,
    );
    expect(run.snapshot.budget.activeSeconds).toBe(2);
  });

  it("budget extension never clears an explicit pause, and resume never bypasses a budget", () => {
    const run = engine(
      { work: { ...task, next: "after" }, after: task },
      { limits: { maxCards: 1 } },
    );
    run.start();
    run.complete(run.latest("work"));
    expect(run.send({ type: "run.resumed" }).effects).toEqual([]);
    expect(run.latest("after").state).toBe("queued");
    run.send({ type: "run.paused" });
    expect(run.send({ type: "budget.extended", kind: "maxCards", by: 1 }).effects).toEqual([]);
    expect(run.snapshot.status).toBe("paused");
    run.send({ type: "run.resumed" });
    expect(run.latest("after").state).toBe("dispatching");
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid card-budget extension %s",
    (by) => {
      const run = fanout(4);
      run.start();
      expect(() => run.send({ type: "budget.extended", kind: "maxCards", by })).toThrow(
        "Budget extensions",
      );
      expect(run.snapshot.budget.limits.maxCards).toBe(60);
    },
  );
});
