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
  workflow: { ...RESEARCH_PLAN_TEAM_WORKFLOW, researchDepth: "none", maxReviewRounds: 2 },
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
  it("reuses research workers for one counted follow-up without expanding the worker budget", () => {
    let run: PlanRun = {
      ...initial(),
      workflow: { ...initial().workflow, researchDepth: "deep", maxParallelWorkers: 1 },
    };
    for (let index = 0; index < 3; index++) {
      run = reservePlanWork(run, request(`worker-${index}`, "research-worker")).run;
      run = {
        ...run,
        reservations: run.reservations.map((item) => ({ ...item, status: "completed" })),
      };
    }
    const workerThreadId = run.reservations[0]!.workerThreadId;
    const followUp = { ...request("follow-up", "research-worker"), workerThreadId };
    const reserved = reservePlanWork(run, followUp);
    expect(reserved.reservation.workerThreadId).toBe(workerThreadId);
    expect(reservePlanWork(reserved.run, followUp).duplicate).toBe(true);
    expect(() =>
      reservePlanWork(reserved.run, {
        ...followUp,
        workerThreadId: run.reservations[1]!.workerThreadId,
      }),
    ).toThrow("different task");
    expect(() =>
      reservePlanWork(reserved.run, {
        ...followUp,
        requestId: "parallel",
        workerThreadId: run.reservations[1]!.workerThreadId,
      }),
    ).toThrow("Parallel");
    const failed: PlanRun = {
      ...reserved.run,
      reservations: reserved.run.reservations.map((item) => ({ ...item, status: "failed" })),
    };
    expect(() => reservePlanWork(failed, { ...followUp, requestId: "retry" })).toThrow(
      "follow-up budget",
    );
    expect(() => reservePlanWork(failed, request("replacement", "research-worker"))).toThrow(
      "budget exhausted",
    );
    expect(() =>
      reservePlanWork(run, { ...followUp, workerThreadId: ThreadId.make("foreign") }),
    ).toThrow("owned research worker");
    expect(() => reservePlanWork(run, { ...followUp, purpose: "research-lead" })).toThrow(
      "only for research-worker",
    );
    expect(() => reservePlanWork({ ...run, phase: "cancelled" }, followUp)).toThrow("cancelled");
    expect(() => reservePlanWork({ ...run, phase: "approved" }, followUp)).toThrow("revised plan");
  });

  it("keeps planning in the main chat while allowing legacy planner reservations", () => {
    const plannerRequest = { ...request("plan"), purpose: "planner" as const };
    expect(() => reservePlanWork(initial(), plannerRequest)).toThrow("You are the planner");
    const legacy = { ...initial(), workflow: { ...initial().workflow, skillVersion: "1.0.0" } };
    expect(reservePlanWork(legacy, plannerRequest).reservation.purpose).toBe("planner");
  });

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
    let run: PlanRun = { ...initial(), workflow: { ...initial().workflow, researchDepth: "deep" } };
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

  it("requires the previous review to be recorded before revising or requesting another review", () => {
    const planned = recordPlan(initial(), source, "plan");
    const pending = reservePlanWork(planned, request("one")).run;
    const completed = completedReview(planned, "one");
    for (const run of [pending, completed]) {
      expect(() => recordPlan(run, source, "revision")).toThrow("record-review");
      expect(() => reservePlanWork(run, request("two"))).toThrow("record-review");
    }
    const recorded = review(completed, "one", {
      verdict: "REVISE",
      findings: [
        { id: "F1", severity: "major", evidence: "Missing check", proposedFix: "Add check" },
      ],
    });
    expect(() => recordPlan(recorded, source, "revision")).toThrow("disposition");
    const revised = recordPlan(recorded, source, "revision", [
      { id: "F1", decision: "accepted", evidence: "Added check" },
    ]);
    expect(reservePlanWork(revised, request("two")).run.reviews[0]?.verdict?.verdict).toBe(
      "REVISE",
    );
  });

  it("accepts one complete verdict with prose or fences without consuming another attempt", () => {
    const run = completedReview(recordPlan(initial(), source, "plan"), "one");
    const verdict = JSON.stringify(review(run, "one").reviews[0]!.verdict);
    for (const text of [
      `I reviewed the plan.\n${verdict}`,
      `I reviewed the plan.\n\`\`\`json\n${verdict}\n\`\`\``,
    ]) {
      const recorded = recordReview(run, "one", run.reservations[0]!.result!, text);
      expect(recorded.phase).toBe("approved");
      expect(recorded.reservations).toHaveLength(1);
    }
    const conflicting = `${verdict}\n${verdict.replace("APPROVED", "REVISE")}`;
    expect(recordReview(run, "one", run.reservations[0]!.result!, conflicting).phase).toBe(
      "blocked",
    );
  });

  it("blocks revisions after an invalid review even when the run resumes, but permits a counted retry", () => {
    const completed = completedReview(recordPlan(initial(), source, "plan"), "one");
    const invalid = recordReview(
      completed,
      "one",
      completed.reservations[0]!.result!,
      '{"verdict":"revise","findings":[{"issue":"Missing check","suggestion":"Add check"}]}',
    );
    for (const phase of ["blocked", "planning"] as const) {
      expect(() => recordPlan({ ...invalid, phase }, source, "revision")).toThrow("invalid review");
    }
    const retried = completedReview(invalid, "two");
    expect(retried.reservations[1]?.workerThreadId).toBe(completed.reservations[0]?.workerThreadId);
    const valid = review(retried, "two", {
      verdict: "REVISE",
      findings: [
        { id: "F1", severity: "major", evidence: "Missing check", proposedFix: "Add check" },
      ],
    });
    expect(() => recordPlan(valid, source, "revision")).toThrow("disposition");
    const revised = recordPlan(valid, source, "revision", [
      { id: "F1", decision: "accepted", evidence: "Added check" },
    ]);
    expect(revised.reviews[0]?.error).toContain("not a valid complete verdict");
    expect(revised.reviews).toHaveLength(2);
    expect(revised.reservations).toHaveLength(2);
  });

  it("waits for selected research and pending workers before review", () => {
    const run = recordPlan(
      { ...initial(), workflow: { ...initial().workflow, researchDepth: "web" } },
      source,
      "plan",
    );
    expect(() => reservePlanWork(run, request("review"))).toThrow("research");
    const started = reservePlanWork(run, { ...request("research"), purpose: "research-lead" }).run;
    expect(() => reservePlanWork(started, request("review"))).toThrow("research");
    const completed = {
      ...started,
      reservations: started.reservations.map((item) => ({
        ...item,
        status: "completed" as const,
        result: { ...source, workerThreadId: item.workerThreadId },
      })),
    };
    expect(reservePlanWork(completed, request("review")).reservation.purpose).toBe("reviewer");
    const deep = {
      ...completed,
      workflow: { ...completed.workflow, researchDepth: "deep" as const },
    };
    const workerPending = reservePlanWork(deep, request("worker", "research-worker")).run;
    expect(() => reservePlanWork(workerPending, request("review"))).toThrow("research");
    const workerCompleted: PlanRun = {
      ...workerPending,
      reservations: workerPending.reservations.map((item) => ({ ...item, status: "completed" })),
    };
    expect(() => reservePlanWork(workerCompleted, request("review"))).toThrow("research");
    const synthesis = reservePlanWork(workerCompleted, {
      ...request("synthesis"),
      purpose: "research-lead",
    }).run;
    const synthesized: PlanRun = {
      ...synthesis,
      reservations: synthesis.reservations.map((item) => ({ ...item, status: "completed" })),
    };
    expect(reservePlanWork(synthesized, request("review")).reservation.purpose).toBe("reviewer");
    const followUp = reservePlanWork(synthesized, {
      ...request("clarify", "research-worker"),
      workerThreadId: workerPending.reservations.at(-1)!.workerThreadId,
    }).run;
    const clarified: PlanRun = {
      ...followUp,
      reservations: followUp.reservations.map((item) => ({ ...item, status: "completed" })),
    };
    expect(() => reservePlanWork(clarified, request("review"))).toThrow("research");
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
