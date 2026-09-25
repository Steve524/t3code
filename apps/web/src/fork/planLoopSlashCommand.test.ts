import { ProviderDriverKind } from "@t3tools/contracts";
import { RESEARCH_PLAN_TEAM_WORKFLOW, BUILT_IN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { expect, it } from "vite-plus/test";

import { planLoopSlashCommandItems } from "./planLoopSlashCommand.ts";

it("offers the exact planning command only for its workflow", () => {
  const provider = ProviderDriverKind.make("codex");
  expect(planLoopSlashCommandItems(BUILT_IN_TEAM_WORKFLOW.protocolId, provider)).toEqual([]);
  expect(planLoopSlashCommandItems(RESEARCH_PLAN_TEAM_WORKFLOW.protocolId, provider)).toEqual([
    expect.objectContaining({
      label: "/t3-plan-loop",
      command: expect.objectContaining({ name: "t3-plan-loop" }),
    }),
  ]);
});
