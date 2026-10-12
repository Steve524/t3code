import { describe, expect, it } from "vite-plus/test";

import { engine, end, led, task } from "./engineTestFixtures.ts";
import type { CrewEffect } from "./types.ts";

type Run = ReturnType<typeof engine>;

// Three steps in a row, then the user's approval.
const chain = {
  work: { ...task, next: "review" },
  review: { ...task, next: "polish" },
  polish: { ...task, next: "ship" },
  ship: { type: "gate", prompt: "Ship it?", outcomes: { approve: "done" } },
  done: end,
};
const gated = {
  work: { ...task, next: "check" },
  check: { type: "gate", by: "lead", prompt: "Good?", outcomes: { yes: "done", no: "work" } },
  done: end,
};
const withHome = (home: Record<string, unknown>) => ({ ...led, home: { ...led.home, ...home } });
const sent = <T extends CrewEffect["type"]>(result: { effects: CrewEffect[] }, type: T) =>
  result.effects.filter(
    (effect): effect is Extract<CrewEffect, { type: T }> => effect.type === type,
  );
/** Ends the turn the lead is on. */
const idle = (run: Run) =>
  run.send({ type: "lead.turn_finished", turnId: run.snapshot.lead!.turn!.id });

describe("lead mode", () => {
  it("AC 13 starts the flow only when the kickoff turn ends", () => {
    const run = engine(chain, led);
    const created = run.send({ type: "run.created" });
    expect(created.effects).toEqual([{ type: "launch_lead", turnId: 1 }]);
    expect(run.snapshot).toMatchObject({ status: "running", cards: [] });
    // The end of any other turn in the home thread changes nothing.
    run.send({ type: "lead.turn_finished", turnId: 99 });
    expect(run.snapshot.cards).toEqual([]);
    const started = idle(run);
    expect(started.events).toContainEqual({ type: "lead.kickoff_finished" });
    expect(started.effects).toEqual([{ type: "launch_card", cardId: "work:1", attempt: 1 }]);
  });

  it("AC 14 holds milestones while the lead is busy and sends them as one update", () => {
    const run = engine(chain, led);
    run.start();
    const first = run.complete(run.latest("work"));
    expect(sent(first, "deliver_lead_update")).toMatchObject([
      { milestones: [expect.stringContaining("`work` (Worker) finished with `done`")] },
    ]);
    // The lead is on that update's turn, so what happens next waits in the digest.
    expect(sent(run.complete(run.latest("review")), "deliver_lead_update")).toEqual([]);
    expect(sent(run.complete(run.latest("polish")), "deliver_lead_update")).toEqual([]);
    expect(run.snapshot.lead?.digest).toHaveLength(3);
    const batched = idle(run);
    expect(batched.events).toContainEqual({ type: "lead.update_delivered" });
    expect(sent(batched, "deliver_lead_update")).toMatchObject([
      {
        milestones: [
          expect.stringContaining("`review`"),
          expect.stringContaining("`polish`"),
          "The user is being asked at `ship`: Ship it?",
        ],
      },
    ]);
    expect(run.snapshot.lead?.digest).toEqual([]);

    // A finished run takes no more input, so its last milestones go out behind the lead's turn.
    const over = run.send({
      type: "gate.resolved",
      cardId: "ship:1",
      outcome: "approve",
      note: "Go",
      by: "user",
    });
    expect(run.snapshot.status).toBe("completed");
    expect(sent(over, "deliver_lead_update")).toMatchObject([
      { milestones: ["The user answered `approve` at `ship`: Go", "The run completed."] },
    ]);
  });

  it("tells the lead of a joined group once, with a line per card", () => {
    const run = engine(
      {
        work: { type: "parallel", branches: ["ui", "api"], next: "done" },
        ui: task,
        api: task,
        done: end,
      },
      led,
    );
    run.start();
    expect(sent(run.complete(run.latest("ui")), "deliver_lead_update")).toEqual([]);
    const joined = sent(run.complete(run.latest("api")), "deliver_lead_update");
    expect(joined).toHaveLength(1);
    expect(joined[0]?.milestones[0]?.split("\n")).toEqual([
      "`work` joined:",
      "  - `ui` (Worker) finished with `done`.",
      "  - `api` (Worker) finished with `done`.",
    ]);
  });

  it("asks the lead once it is idle, reminds it once, then asks the user", () => {
    const run = engine(gated, withHome({ updates: "decisions" }));
    run.start();
    const asked = run.complete(run.latest("work"));
    // With `updates: decisions` the lead hears of nothing but its decisions.
    expect(sent(asked, "deliver_lead_update")).toEqual([]);
    expect(sent(asked, "send_decision_request")).toMatchObject([
      { cardId: "check:1", outcomes: ["yes", "no"], reminder: false },
    ]);
    expect(run.latest("check").state).toBe("waiting_lead");

    expect(sent(idle(run), "send_decision_request")).toMatchObject([
      { cardId: "check:1", reminder: true },
    ]);
    const silent = idle(run);
    expect(sent(silent, "send_decision_request")).toEqual([]);
    expect(silent.events).toContainEqual({
      type: "gate.escalated",
      cardId: "check:1",
      reason: "The lead ended its turn twice without deciding.",
    });
    expect(run.latest("check")).toMatchObject({ state: "needs_you", reminderSent: true });
    expect(() =>
      run.send({ type: "gate.resolved", cardId: "check:1", by: "lead", outcome: "yes", note: "" }),
    ).toThrow("Only the user");
    run.send({ type: "gate.resolved", cardId: "check:1", by: "user", outcome: "yes", note: "" });
    expect(run.snapshot.status).toBe("completed");
  });

  it("a decision the lead answers in its turn needs no reminder", () => {
    const run = engine(gated, withHome({ updates: "decisions" }));
    run.start();
    run.complete(run.latest("work"));
    const decided = run.send({
      type: "gate.resolved",
      cardId: "check:1",
      by: "lead",
      outcome: "no",
      note: "Again",
    });
    expect(decided.effects).toContainEqual({ type: "launch_card", cardId: "work:2", attempt: 1 });
    expect(idle(run).effects).toEqual([]);
    expect(run.snapshot.lead?.turn).toBeNull();
  });

  it("the lead's own step waits for its thread and only reads the checkout", () => {
    const run = engine(
      { work: { ...task, next: "wrap" }, wrap: { ...task, role: "lead", next: "done" }, done: end },
      led,
    );
    run.start();
    // The update about `work` goes out first; the lead's step is its next turn.
    expect(sent(run.complete(run.latest("work")), "deliver_lead_update")).toHaveLength(1);
    expect(run.latest("wrap")).toMatchObject({ state: "queued", isolation: "read-only" });
    expect(idle(run).effects).toEqual([{ type: "launch_card", cardId: "wrap:1", attempt: 1 }]);
    // The lead is not told about its own work.
    expect(sent(run.complete(run.latest("wrap")), "deliver_lead_update")).toMatchObject([
      { milestones: ["The run completed."] },
    ]);
  });

  it.each([
    { canEdit: true, held: "queued", waiting: 1 },
    { canEdit: false, held: "dispatching", waiting: 0 },
  ])(
    "a lead with canEdit=$canEdit shares the checkout with shared cards",
    ({ canEdit, held, waiting }) => {
      const run = engine(
        {
          work: { type: "parallel", branches: ["build", "ask"], next: "done" },
          build: { ...task, isolation: "shared" },
          ask: { type: "gate", prompt: "Go?", outcomes: { go: "done" } },
          done: end,
        },
        withHome({ canEdit }),
      );
      // The gate opens as the group starts, so the lead is told before `build` is dispatched.
      const started = run.start();
      expect(sent(started, "deliver_lead_update")).toHaveLength(1);
      // An editing lead's turn holds the shared writer's place.
      expect(run.latest("build").state).toBe(held);
      idle(run);
      expect(run.latest("build").state).toBe("dispatching");
      // And its next update waits while a shared card is in the checkout.
      const answered = run.send({
        type: "gate.resolved",
        cardId: "ask:1",
        by: "user",
        outcome: "go",
        note: "",
      });
      expect(sent(answered, "deliver_lead_update")).toHaveLength(1 - waiting);
      expect(run.snapshot.lead?.digest).toHaveLength(waiting);
    },
  );
});
