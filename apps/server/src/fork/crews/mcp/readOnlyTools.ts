/**
 * The crew tools that only read or write crew state. A role in a read-only
 * sandbox still has to report, so Claude pre-approves these there. Tools that
 * run commands or reach other servers never belong on this list.
 *
 * Kept free of imports: the Claude adapter loads it, and the toolkit must not
 * come with it.
 */
export const CREW_STATE_MCP_TOOL_NAMES = [
  "crew_context",
  "crew_report",
  "crew_decide",
  "crew_artifact_read",
  "crew_artifact_write",
  "crew_skill_get",
  "crew_note",
  "crew_validate",
  "crew_tool_list",
] as const;

/** Spread into `CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS`. */
export const CLAUDE_READ_ONLY_CREW_MCP_ALLOWED_TOOLS: ReadonlyArray<string> =
  CREW_STATE_MCP_TOOL_NAMES.map((name) => `mcp__t3-code__${name}`);
