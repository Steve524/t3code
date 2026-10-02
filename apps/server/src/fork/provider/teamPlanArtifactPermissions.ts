import type { Options } from "@anthropic-ai/claude-agent-sdk";

import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";

/** Claude may auto-approve this bounded writer; its handler still authorizes every write. */
export const teamPlanArtifactPermissions = (
  session: Pick<McpProviderSessionConfig, "capabilities" | "team"> | undefined,
): Pick<Options, "allowedTools"> =>
  session?.capabilities.has("team") &&
  session.team?.role === "orchestrator" &&
  session.team.workflow.type === "plan"
    ? { allowedTools: ["mcp__t3-code__team_write_plan_artifact"] }
    : {};
