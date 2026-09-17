import type { ServerConfig } from "@t3tools/contracts";
import { BUILT_IN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { describe, expect, it } from "vite-plus/test";

import {
  availableTeamWorkflows,
  firstTeamWorkflow,
  resolveComposerTeamWorkflow,
} from "./teamWorkflows";

function config(capability: boolean): ServerConfig {
  return {
    environment: { capabilities: { teamWorkflows: capability } },
    settings: { teamWorkflows: [BUILT_IN_TEAM_WORKFLOW] },
  } as unknown as ServerConfig;
}

describe("team workflow availability", () => {
  it("returns the first configured workflow only when the server advertises support", () => {
    expect(firstTeamWorkflow(config(true))).toBe(BUILT_IN_TEAM_WORKFLOW);
    expect(firstTeamWorkflow(config(false))).toBeNull();
    expect(availableTeamWorkflows(null)).toEqual([]);
  });

  it("makes persisted orchestrator workflows read-only and hides controls on other threads", () => {
    expect(
      resolveComposerTeamWorkflow({
        config: config(false),
        draftWorkflowId: null,
        isDraft: false,
        threadTeam: { role: "orchestrator", workflow: BUILT_IN_TEAM_WORKFLOW },
      }),
    ).toEqual({
      workflows: [BUILT_IN_TEAM_WORKFLOW],
      workflow: BUILT_IN_TEAM_WORKFLOW,
      readOnly: true,
    });
    expect(
      resolveComposerTeamWorkflow({
        config: config(true),
        draftWorkflowId: null,
        isDraft: false,
        threadTeam: null,
      }),
    ).toEqual({ workflows: [], workflow: null, readOnly: false });
  });

  it("resolves draft selections only in capable environments", () => {
    expect(
      resolveComposerTeamWorkflow({
        config: config(true),
        draftWorkflowId: BUILT_IN_TEAM_WORKFLOW.id,
        isDraft: true,
        threadTeam: null,
      }).workflow,
    ).toBe(BUILT_IN_TEAM_WORKFLOW);
    expect(
      resolveComposerTeamWorkflow({
        config: config(false),
        draftWorkflowId: BUILT_IN_TEAM_WORKFLOW.id,
        isDraft: true,
        threadTeam: null,
      }).workflow,
    ).toBeNull();
  });
});
