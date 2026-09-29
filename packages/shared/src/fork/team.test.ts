import { describe, expect, it } from "vite-plus/test";

import {
  BUILT_IN_RESEARCH_PLAN_WORKFLOW,
  BUILT_IN_TEAM_WORKFLOW,
  BUILT_IN_TEAM_WORKFLOWS,
  resolveTeamWorkflows,
} from "./team.ts";

describe("resolveTeamWorkflows", () => {
  it("offers both built-ins, Full-stack first, when nothing is saved", () => {
    expect(resolveTeamWorkflows([])).toEqual([
      BUILT_IN_TEAM_WORKFLOW,
      BUILT_IN_RESEARCH_PLAN_WORKFLOW,
    ]);
  });

  it("keeps an edited Full-stack preset and appends the missing Research & plan preset", () => {
    const edited = { ...BUILT_IN_TEAM_WORKFLOW, maxParallelWorkers: 9 };
    expect(resolveTeamWorkflows([edited])).toEqual([edited, BUILT_IN_RESEARCH_PLAN_WORKFLOW]);
  });

  it("returns a list that already has both built-ins unchanged", () => {
    const saved = [
      { ...BUILT_IN_RESEARCH_PLAN_WORKFLOW, maxReviewRounds: 3 },
      BUILT_IN_TEAM_WORKFLOW,
    ];
    expect(resolveTeamWorkflows(saved)).toBe(saved);
  });

  it("marks Research & plan as a plan workflow with read-only roles", () => {
    expect(BUILT_IN_TEAM_WORKFLOWS.map(({ type }) => type)).toEqual(["build", "plan"]);
    expect(
      BUILT_IN_RESEARCH_PLAN_WORKFLOW.roles.map(({ kind, runtimeMode }) => [kind, runtimeMode]),
    ).toEqual([
      ["researcher", "approval-required"],
      ["plan-reviewer", "approval-required"],
    ]);
  });
});
