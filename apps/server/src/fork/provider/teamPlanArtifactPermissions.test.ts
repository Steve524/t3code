import { TeamRoleId } from "@t3tools/contracts";
import { BUILT_IN_RESEARCH_PLAN_WORKFLOW, BUILT_IN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { describe, expect, it } from "vite-plus/test";

import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";
import { teamPlanArtifactPermissions } from "./teamPlanArtifactPermissions.ts";

const planner = {
  capabilities: new Set(["team"]),
  team: { role: "orchestrator", workflow: BUILT_IN_RESEARCH_PLAN_WORKFLOW },
} satisfies Pick<McpProviderSessionConfig, "capabilities" | "team">;

describe("Claude plan artifact permissions", () => {
  it("auto-approves only the bounded artifact tool for an authorized plan orchestrator", () => {
    expect(teamPlanArtifactPermissions(planner)).toEqual({
      allowedTools: ["mcp__t3-code__team_write_plan_artifact"],
    });
  });

  it("grants nothing without the team capability or planner context", () => {
    expect(teamPlanArtifactPermissions(undefined)).toEqual({});
    expect(teamPlanArtifactPermissions({ capabilities: new Set(["team"]) })).toEqual({});
    expect(teamPlanArtifactPermissions({ ...planner, capabilities: new Set(["preview"]) })).toEqual(
      {},
    );
  });

  it("grants nothing to build orchestrators or workers, including read-only roles", () => {
    expect(
      teamPlanArtifactPermissions({
        ...planner,
        team: { role: "orchestrator", workflow: BUILT_IN_TEAM_WORKFLOW },
      }),
    ).toEqual({});
    for (const roleKind of ["researcher", "plan-reviewer", "implementer", "reviewer"] as const) {
      expect(
        teamPlanArtifactPermissions({
          ...planner,
          team: {
            role: "worker",
            roleId: TeamRoleId.make(roleKind),
            roleKind,
            roleLabel: roleKind,
            roleInstructions: "",
            orchestratorTitle: "Plan the version flag",
            branch: "main",
          },
        }),
      ).toEqual({});
    }
  });
});
