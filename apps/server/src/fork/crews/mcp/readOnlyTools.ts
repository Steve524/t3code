/** Kept import-free because the Claude adapter loads it without the toolkit. */
export const CREW_STATE_MCP_TOOL_NAMES = [
  "t3_skill_get",
  "t3_crews_list",
  "t3_crews_get",
  "t3_crews_toolbox",
  "t3_crews_validate",
] as const;

/** Spread into `CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS`. */
export const CLAUDE_READ_ONLY_CREW_MCP_ALLOWED_TOOLS: ReadonlyArray<string> =
  CREW_STATE_MCP_TOOL_NAMES.map((name) => `mcp__t3-code__${name}`);
