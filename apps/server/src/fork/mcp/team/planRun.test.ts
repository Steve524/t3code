import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { RESEARCH_PLAN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { describe, expect, it } from "vite-plus/test";
import { hashPlan, recordPlan, recordReview, reservePlanWork, type PlanRun } from "./planRun.ts";

const source = {
  workerThreadId: ThreadId.make("planner"),
  turnId: TurnId.make("plan-turn"),
  messageId: MessageId.make("plan-message"),
};
const initial = (): PlanRun => ({
  resumedThroughSequence: 0,
  workflow: { ...RESEARCH_PLAN_TEAM_WORKFLOW, researchDepth: "deep", maxReviewRounds: 2 },
  baseline: "a".repeat(40),
  phase: "planning",
  plan: null,
  reservations: [],
  reviews: [],
});
const request = (requestId: string, purpose: "reviewer" | "research-worker" = "reviewer") => ({
  requestId,
  purpose,
  task: "Inspect",
  title: "Review",
});
const completedReview = (run: PlanRun, id: string) => {
  const reserved = reservePlanWork(run, request(id));
  const result = {
    ...source,
    workerThreadId: reserved.reservation.workerThreadId,
    turnId: TurnId.make(id),
  };
  return {
    ...reserved.run,
    reservations: reserved.run.reservations.map((item) =>
      item.requestId === id ? { ...item, status: "completed" as const, result } : item,
    ),
  };
};
const review = (run: PlanRun, id: string, overrides: Record<string, unknown> = {}) =>
  recordReview(
    run,
    id,
    run.reservations.find((item) => item.requestId === id)!.result!,
    JSON.stringify({
      verdict: "APPROVED",
      planHash: run.plan!.hash,
      baseline: run.baseline,
      summary: "Verified",
      findings: [],
      coverage: ["Project"],
      limitations: [],
      ...overrides,
    }),
  );

describe("planning run guards", () => {
  it("deduplicates identical requests, retains failed attempts and reuses the reviewer", () => {
    let run = recordPlan(initial(), source, "plan");
    const first = reservePlanWork(run, request("one"));
    expect(reservePlanWork(first.run, request("one")).duplicate).toBe(true);
    expect(() => reservePlanWork(first.run, { ...request("one"), task: "Different" })).toThrow(
      "different task",
    );
    expect(() => reservePlanWork(first.run, request("two"))).toThrow("previous review");
    run = {
      ...first.run,
      reservations: [{ ...first.reservation, status: "failed", error: "Provider failed" }],
    };
    const second = reservePlanWork(run, request("two"));
    expect(second.reservation.workerThreadId).toBe(first.reservation.workerThreadId);
    run = {
      ...second.run,
      reservations: second.run.reservations.map((item) => ({ ...item, status: "failed" })),
    };
    expect(() => reservePlanWork(run, request("three"))).toThrow("budget exhausted");
  });

  it("caps total research workers even when every attempt fails", () => {
    let run = initial();
    for (let index = 0; index < 3; index++) {
      run = reservePlanWork(run, request(String(index), "research-worker")).run;
      run = {
        ...run,
        reservations: run.reservations.map((item) => ({ ...item, status: "failed" })),
      };
    }
    expect(() => reservePlanWork(run, request("four", "research-worker"))).toThrow(
      "budget exhausted",
    );
    expect(() =>
      reservePlanWork({ ...initial(), phase: "cancelled" }, request("one", "research-worker")),
    ).toThrow("cancelled");
  });

  it("rejects invalid, material, stale and wrong-turn reviews; invalidates approval on changes", () => {
    const run = completedReview(recordPlan(initial(), source, "plan 🧪"), "review");
    const result = run.reservations[0]!.result!;
    expect(recordReview(run, "review", result, "APPROVED").phase).toBe("blocked");
    expect(review(run, "review", { planHash: hashPlan("older") }).reviews[0]!.error).toContain(
      "stale",
    );
    expect(review(run, "review", { baseline: "different" }).phase).toBe("blocked");
    expect(
      review(run, "review", {
        findings: [{ id: "F1", severity: "major", evidence: "Missing test", proposedFix: "Test" }],
      }).phase,
    ).toBe("blocked");
    expect(() =>
      recordReview(run, "review", { ...result, turnId: TurnId.make("old-turn") }, "{}"),
    ).toThrow("reserved reviewer turn");
    const approved = review(run, "review");
    expect(approved.phase).toBe("approved");
    const changed = recordPlan(approved, source, "changed plan");
    expect(changed.phase).toBe("planning");
    expect(changed.plan!.version).toBe(2);
    expect(recordReview(changed, "review", result, "{}").phase).toBe("planning");
  });

  it("records evidenced dispositions before a revised plan can be reviewed", () => {
    let run: PlanRun = completedReview(recordPlan(initial(), source, "plan"), "one");
    run = review(run, "one", {
      verdict: "REVISE",
      findings: [
        { id: "F1", severity: "major", evidence: "Missing check", proposedFix: "Add check" },
      ],
    });
    expect(() => recordPlan(run, source, "revision")).toThrow("disposition");
    run = recordPlan(run, source, "revision", [
      { id: "F1", decision: "accepted", evidence: "Added check" },
    ]);
    run = review(completedReview(run, "two"), "two");
    expect(run.phase).toBe("approved");
    expect(run.reviews).toHaveLength(2);
  });
});
