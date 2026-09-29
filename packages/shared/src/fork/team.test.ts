import { describe, expect, it } from "vite-plus/test";

import {
  BUILT_IN_TEAM_WORKFLOW,
  BUILT_IN_TEAM_WORKFLOWS,
  RESEARCH_PLAN_TEAM_WORKFLOW,
  resolveTeamWorkflows,
} from "./team.ts";

describe("built-in team workflows", () => {
  it("adds missing presets by ID without changing saved overrides or order", () => {
    const customized = { ...BUILT_IN_TEAM_WORKFLOW, maxParallelWorkers: 9 };
    const custom = { ...BUILT_IN_TEAM_WORKFLOW, id: "my-workflow", builtIn: false };

    expect(resolveTeamWorkflows([])).toEqual(BUILT_IN_TEAM_WORKFLOWS);
    expect(resolveTeamWorkflows([customized])).toEqual([customized, RESEARCH_PLAN_TEAM_WORKFLOW]);
    expect(resolveTeamWorkflows([custom, customized, RESEARCH_PLAN_TEAM_WORKFLOW])).toEqual([
      custom,
      customized,
      RESEARCH_PLAN_TEAM_WORKFLOW,
    ]);
  });

  it("upgrades saved planning presets without changing worker choices or the old snapshot", () => {
    const saved = {
      ...RESEARCH_PLAN_TEAM_WORKFLOW,
      skillVersion: "1.0.0",
      maxReviewRounds: 4,
      roles: RESEARCH_PLAN_TEAM_WORKFLOW.roles.map((role) =>
        role.id === "planner"
          ? {
              ...role,
              enabled: false,
              instructions: "Ask about acceptance criteria",
              runtimeMode: "full-access" as const,
            }
          : role,
      ),
    };
    const upgraded = resolveTeamWorkflows([saved])[0]!;
    expect(upgraded.skillVersion).toBe("1.1.0");
    expect(upgraded.maxReviewRounds).toBe(4);
    expect(upgraded.roles[0]).toMatchObject({
      enabled: true,
      instructions: "Ask about acceptance criteria",
      modelSelection: null,
      runtimeMode: null,
    });
    expect(upgraded.roles.slice(1)).toEqual(saved.roles.slice(1));
    expect(saved.skillVersion).toBe("1.0.0");
    expect(saved.roles[0]!.enabled).toBe(false);
  });
});
