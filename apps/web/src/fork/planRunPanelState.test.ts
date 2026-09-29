import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planningPanelState } from "./planRunPanelState";

const activity = (kind: string, payload: unknown) =>
  ({ kind, payload, createdAt: "2026-09-25T00:00:00.000Z" }) as OrchestrationThreadActivity;

describe("planning panel state", () => {
  it("keeps a submitted research notes choice after the panel reloads", () => {
    const result = planningPanelState([
      activity("user-input.resolved", {
        requestId: "notes-choice",
        answers: {
          "Where should the research brief be saved when it's exported?": "Temporary directory",
        },
      }),
    ]);
    expect(result.notesChoice).toEqual({ kind: "temporary", label: "Temporary directory" });
  });

  it("recovers a choice sent from the panel and lets a later answer replace it", () => {
    const messages = [
      {
        role: "user",
        text: "For this Research and plan run, save the research brief in temporary notes outside the repository. Confirm the resolved destination before export.",
        createdAt: "2026-09-25T00:00:00.000Z",
      },
    ] as OrchestrationMessage[];
    const result = planningPanelState(
      [
        {
          ...activity("user-input.resolved", {
            answers: { "Where should the research brief be saved?": "Project directory" },
          }),
          createdAt: "2026-09-25T00:01:00.000Z",
        },
      ],
      messages,
    );
    expect(result.notesChoice).toEqual({ kind: "project", label: "Project directory" });
    expect(planningPanelState([], messages).notesChoice).toEqual({
      kind: "temporary",
      label: "Temporary directory",
    });
  });

  it("uses the latest valid run, counts reserved attempts, and keeps artifact links", () => {
    const run = {
      phase: "blocked",
      workflow: { maxReviewRounds: 2 },
      plan: { version: 2, hash: "current" },
      reservations: [
        { requestId: "review-1", purpose: "reviewer", status: "completed", error: null },
        { requestId: "review-2", purpose: "reviewer", status: "failed", error: "Launch failed" },
      ],
      reviews: [{ requestId: "review-2", verdict: null, error: "Invalid verdict" }],
    };
    const result = planningPanelState([
      activity("team.plan-run.updated", { ...run, phase: "review" }),
      activity("team.plan-run.updated", { invalid: true }),
      activity("team.plan-run.updated", run),
      activity("team.artifact.exported", {
        artifactId: "one",
        kind: "plan",
        path: "/tmp/PLAN.md",
        temporary: true,
        attachment: { attachmentId: "one", fileName: "PLAN.md" },
        createdAt: "2026-09-25T00:00:00.000Z",
      }),
    ]);
    expect(result.run?.phase).toBe("blocked");
    expect(result.attempts).toBe(2);
    expect(result.reviewAttempts[1]?.error).toBe("Launch failed");
    expect(result.exhausted).toBe(true);
    expect(result.artifacts[0]?.attachment.fileName).toBe("PLAN.md");
  });
});
