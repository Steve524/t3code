import { describe, expect, it } from "vite-plus/test";

import { end, engine, task, worker } from "./engineTestFixtures.ts";

/** Two fan-out cards in their own worktrees, then a merge of what they did. */
function merging(
  mergeStep: Record<string, unknown> = {},
  options: Parameters<typeof engine>[2] = {},
) {
  const run = engine(
    {
      work: { ...task, type: "fanout", over: "artifacts.plan.tasks", next: "integrate" },
      integrate: { type: "merge", next: "done", ...mergeStep },
      done: end,
    },
    { roles: { worker, fixer: worker } },
    { ...options, artifacts: { plan: { tasks: [{ id: "a" }, { id: "b" }, { id: "c" }] } } },
  );
  run.start();
  return { run };
}

/** Finishes the fan-out and brings the merge card to the point where branches are merged. */
function startMerge(run: ReturnType<typeof merging>["run"]) {
  for (const card of run.snapshot.cards.filter((card) => card.stepId === "work")) {
    run.dispatched(card);
    run.complete(card);
  }
  const merge = run.latest("integrate");
  run.send({ type: "merge.started", cardId: merge.id });
  return merge.id;
}

describe("merge steps", () => {
  it("checks ownership, then merges, then routes on", () => {
    const { run } = merging();
    for (const card of run.snapshot.cards.filter((card) => card.stepId === "work")) {
      run.dispatched(card);
    }
    const cards = run.snapshot.cards.filter((card) => card.stepId === "work");
    run.complete(cards[0]!);
    run.complete(cards[1]!);
    expect(run.complete(cards[2]!).effects).toEqual([
      { type: "check_ownership", cardId: "integrate:1" },
    ]);
    expect(run.send({ type: "merge.started", cardId: "integrate:1" }).effects).toEqual([
      { type: "merge_branch", cardId: "integrate:1" },
    ]);
    // A merge is the crew's own work, so it uses none of the card budget.
    expect(run.snapshot.budget.cards).toBe(3);
    run.send({ type: "merge.resolved", cardId: "integrate:1" });
    expect(run.snapshot.status).toBe("completed");
  });

  it("hands a conflict to the step's resolver role and resumes the merge after its turn", () => {
    const { run } = merging({ onConflict: { role: "fixer" } });
    const mergeId = startMerge(run);
    const conflict = run.send({ type: "merge.conflict", cardId: mergeId, paths: ["README.md"] });
    const resolver = run.snapshot.cards.at(-1)!;
    expect(resolver).toMatchObject({
      type: "task",
      stepId: "integrate",
      roleId: "fixer",
      isolation: "shared",
      sourceCardId: mergeId,
      item: { paths: ["README.md"] },
      state: "dispatching",
    });
    // The merge gave up the shared checkout, or the resolver could not have been dispatched.
    expect(run.latest("integrate")).toBe(resolver);
    expect(run.snapshot.cards.find((card) => card.id === mergeId)?.state).toBe("blocked");
    expect(conflict.effects).toEqual([{ type: "launch_card", cardId: resolver.id, attempt: 1 }]);
    expect(run.snapshot.budget.cards).toBe(4);

    run.dispatched(resolver);
    const resumed = run.send({
      type: "card.turn_finished",
      cardId: resolver.id,
      attempt: 1,
      status: "completed",
    });
    // No report is fine: the merge checks the files itself. Nothing is routed from the resolver.
    expect(resumed.effects).toEqual([{ type: "merge_branch", cardId: mergeId }]);
    expect(run.snapshot.cards.find((card) => card.id === resolver.id)?.state).toBe("done");
    expect(run.snapshot.cards.find((card) => card.id === mergeId)?.state).toBe("working");
    expect(run.snapshot.visits.done).toBeUndefined();

    run.send({ type: "merge.resolved", cardId: mergeId });
    expect(run.snapshot.status).toBe("completed");
  });

  it("asks the user about a conflict when the step names no resolver", () => {
    const { run } = merging({ onConflict: "gate" });
    const mergeId = startMerge(run);
    run.send({ type: "merge.conflict", cardId: mergeId, paths: ["a.ts"] });
    expect(run.snapshot.cards.find((card) => card.id === mergeId)?.state).toBe("needs_you");
    expect(run.snapshot.cards.some((card) => card.sourceCardId === mergeId)).toBe(false);
  });

  it("opens a gate on the merge card when a branch is held back, and carries on when answered", () => {
    const { run } = merging({ checkOwnership: "block" });
    const mergeId = startMerge(run);
    const blocked = run.send({
      type: "merge.blocked",
      cardId: mergeId,
      reason: "Not merged: crew/x/work-1-1 changed paths it does not own (other.txt).",
    });
    expect(blocked.events).toContainEqual({
      type: "gate.opened",
      cardId: mergeId,
      by: "user",
      prompt: "Not merged: crew/x/work-1-1 changed paths it does not own (other.txt).",
      outcomes: ["done"],
    });
    expect(run.snapshot.cards.find((card) => card.id === mergeId)?.state).toBe("needs_you");
    expect(run.snapshot.status).toBe("waiting");
    run.send({ type: "gate.resolved", cardId: mergeId, outcome: "done", note: "", by: "user" });
    expect(run.snapshot.status).toBe("completed");
  });

  it("retries a held-back merge from the start, stopping a resolver still at work", () => {
    const { run } = merging({ onConflict: { role: "fixer" } });
    const mergeId = startMerge(run);
    run.send({ type: "merge.conflict", cardId: mergeId, paths: ["a.ts"] });
    const resolver = run.snapshot.cards.at(-1)!;
    run.dispatched(resolver);
    const retried = run.send({ type: "user.card_action", cardId: mergeId, action: "retry" });
    expect(retried.effects).toContainEqual({
      type: "stop_thread",
      cardId: resolver.id,
      attempt: 1,
      threadId: `thread:${resolver.id}`,
    });
    // The resolver still holds the shared checkout until its thread has stopped.
    expect(run.snapshot.cards.find((card) => card.id === mergeId)).toMatchObject({
      state: "queued",
      attempt: 2,
    });
    // A resolver is not a card of the flow, so the user cannot skip or force it.
    run.send({ type: "user.card_action", cardId: resolver.id, action: "skip" });
    expect(run.snapshot.cards.find((card) => card.id === resolver.id)?.state).toBe("stopping");
  });

  it("keeps why a card failed as its note", () => {
    const { run } = merging();
    const card = run.snapshot.cards[0]!;
    run.send({ type: "card.failed", cardId: card.id, attempt: 1, reason: "git said no" });
    expect(run.snapshot.cards[0]).toMatchObject({ state: "blocked", note: "git said no" });
  });
});

describe("card worktrees at run end", () => {
  it("removes each card worktree once when the run completes or is cancelled", () => {
    const { run } = merging();
    const mergeId = startMerge(run);
    const completed = run.send({ type: "merge.resolved", cardId: mergeId });
    expect(completed.effects.filter((effect) => effect.type === "remove_worktree")).toEqual([
      { type: "remove_worktree", cardId: "work:1:0" },
      { type: "remove_worktree", cardId: "work:1:1" },
      { type: "remove_worktree", cardId: "work:1:2" },
    ]);

    const cancelled = merging().run;
    cancelled.dispatched(cancelled.snapshot.cards[0]!);
    // Only a card that got a thread has a worktree to remove.
    expect(
      cancelled
        .send({ type: "run.cancel_requested" })
        .effects.filter((effect) => effect.type === "remove_worktree"),
    ).toEqual([{ type: "remove_worktree", cardId: "work:1:0" }]);
  });

  it("keeps them when the run fails", () => {
    const { run } = merging();
    run.dispatched(run.snapshot.cards[0]!);
    const failed = run.send({ type: "run.failed", reason: "boom" });
    expect(failed.effects.some((effect) => effect.type === "remove_worktree")).toBe(false);
  });
});

describe("role pools", () => {
  it("spreads a role's fan-out cards over its pool in turn", () => {
    const { run } = merging({}, { rolePools: { worker: ["codex-a", "codex-b"] } });
    expect(run.snapshot.cards.map((card) => card.instanceId)).toEqual([
      "codex-a",
      "codex-b",
      "codex-a",
    ]);
  });

  it("counts each pooled card against its own instance's cap", () => {
    const { run } = merging(
      {},
      { rolePools: { worker: ["codex-a", "codex-b"] }, providerCaps: { "codex-a": 1 } },
    );
    expect(run.snapshot.cards.map((card) => card.state)).toEqual([
      "dispatching",
      "dispatching",
      "queued",
    ]);
  });

  it("gives way to a model the user picks for the role mid-run", () => {
    const { run } = merging(
      {},
      { rolePools: { worker: ["codex-a", "codex-b"] }, providerCaps: { "codex-a": 1 } },
    );
    // The third card waits on its pooled instance's cap until the pick moves it elsewhere.
    run.send({
      type: "user.role_model_changed",
      roleId: "worker",
      selection: { instanceId: "claude", model: "opus" } as never,
    });
    expect(run.snapshot.cards[2]?.state).toBe("dispatching");
    expect(run.snapshot.cards.map((card) => card.instanceId)).toEqual([
      "codex-a",
      "codex-b",
      "claude",
    ]);
  });
});
