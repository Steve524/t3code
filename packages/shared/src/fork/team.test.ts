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
});
