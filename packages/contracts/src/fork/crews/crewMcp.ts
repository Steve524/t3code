import * as Schema from "effect/Schema";

/** How a `crew_*` tool refuses a call. The message says what would be accepted. */
export class CrewMcpFailure extends Schema.TaggedError<CrewMcpFailure>()("CrewMcpFailure", {
  code: Schema.Literals([
    "not_a_crew_card",
    "not_allowed",
    "invalid_report",
    "not_found",
    "unavailable",
    // A `t3_*` tool called from a thread without a project.
    "no_project",
  ]),
  message: Schema.String,
}) {}

/** The tools an MCP server in the role's toolbox offers, as its `tools/list` named them. */
export const CrewMcpToolList = Schema.Struct({
  server: Schema.String,
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optionalKey(Schema.String),
      inputSchema: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});
export type CrewMcpToolList = typeof CrewMcpToolList.Type;

export const CrewMcpCallInput = Schema.Struct({
  server: Schema.String,
  tool: Schema.String,
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type CrewMcpCallInput = typeof CrewMcpCallInput.Type;

/** An MCP `tools/call` result, passed through. `isError` is the tool's own failure. */
export const CrewMcpCallResult = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(Schema.Unknown),
});
export type CrewMcpCallResult = typeof CrewMcpCallResult.Type;
