import { describe, expect, it } from "vite-plus/test";

import {
  BUILT_IN_RESEARCH_PLAN_WORKFLOW,
  BUILT_IN_TEAM_WORKFLOW,
  BUILT_IN_TEAM_WORKFLOWS,
  resolveTeamWorkflows,
  teamReadOnlyLaunch,
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
      ["researcher", null],
      ["plan-reviewer", null],
    ]);
  });
});

describe("teamReadOnlyLaunch", () => {
  it("keeps Claude read-only workers in the planner checkout, out of plan mode", () => {
    // Plan mode let a Bash write through on Claude (Phase 2 matrix), so it must not be used.
    expect(teamReadOnlyLaunch("claudeAgent")).toEqual({
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
  });

  it("isolates every provider the matrix could not hold to read-only", () => {
    for (const driver of ["codex", "antigravity", "opencode", "cursor", "grok", "unknown"]) {
      expect(teamReadOnlyLaunch(driver)).toBeNull();
    }
  });
});
