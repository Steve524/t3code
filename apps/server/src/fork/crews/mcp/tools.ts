import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import {
  CrewCardContext,
  CrewDecideInput,
  CrewMcpCallInput,
  CrewMcpCallResult,
  CrewMcpFailure,
  CrewMcpToolList,
  CrewNoteInput,
  CrewReportInput,
  CrewSkillResult,
  CrewToolList,
  CrewToolRunInput,
  CrewToolRunResult,
  CrewValidateResult,
} from "../../../../../../packages/contracts/src/fork/crews/crewRun.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as CrewRunService from "../CrewRunService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  CrewRunService.CrewRunService,
];
// A refusal is either the caller check's or the crew's own.
const failure = Schema.Union([OrchestratorMcpFailure, CrewMcpFailure]);

// A tool that touches crew state only is annotated read-only: that is what lets a role in a
// read-only sandbox report. `crew_tool_run` runs a command, so it is not. Keep `readOnlyTools.ts`
// in step with the read-only ones.

const CrewContextTool = Tool.make("crew_context", {
  description:
    "Needs an agent working for a crew run. Returns your role, step, the run's inputs, the outcomes you may report, the artifacts you must produce and those that exist, your skills, tools and MCP servers with where each comes from, and your teammates' cards and their states. The crew's lead also gets `board`: every card, the decisions waiting on it, route counters and budget usage.",
  success: CrewCardContext,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get this card's crew context")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CrewReportTool = Tool.make("crew_report", {
  description:
    "Needs an agent working for a crew run. Record your result once before you end your turn: an outcome your step allows, a summary of what you did, and the artifacts your step produces. A refused report names what is allowed or which field is wrong, and records nothing; fix it and call again. The last report of a turn wins and takes effect when the turn ends.",
  parameters: CrewReportInput,
  success: Schema.Struct({ recorded: Schema.Literal(true), outcome: Schema.String }),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Report this card's result")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CrewDecideTool = Tool.make("crew_decide", {
  description:
    "Needs the lead of a crew run. Answer a decision you were asked for: `decisionId` from the request, and one of its outcomes. Use `escalate` to hand the decision to the user, with a note saying why. Refused when the decision is no longer open, for example because the user already answered it.",
  parameters: CrewDecideInput,
  success: Schema.Struct({ decided: Schema.Literal(true), outcome: Schema.String }),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Answer a crew decision")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CrewArtifactReadTool = Tool.make("crew_artifact_read", {
  description:
    "Needs an agent working for a crew run. Read any artifact of this run by name. crew_context lists the names.",
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.Struct({ name: Schema.String, value: Schema.Unknown }),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a crew artifact")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CrewArtifactWriteTool = Tool.make("crew_artifact_write", {
  description:
    "Needs an agent working for a crew run. Hand over one artifact your step produces ahead of your report, which then carries it. Only artifacts your step produces are accepted, and the value must match the artifact's shape.",
  parameters: Schema.Struct({ name: Schema.String, value: Schema.Unknown }),
  success: Schema.Struct({ written: Schema.Literal(true) }),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Write a crew artifact")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CrewSkillGetTool = Tool.make("crew_skill_get", {
  description:
    "Needs an agent working for a crew run. Load the instructions of a skill in your role's toolbox, or with `file` another file inside that skill's folder. A skill outside your toolbox is refused.",
  parameters: Schema.Struct({ name: Schema.String, file: Schema.optionalKey(Schema.String) }),
  success: CrewSkillResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Load a crew skill")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CrewNoteTool = Tool.make("crew_note", {
  description:
    "Needs an agent working for a crew run. Leave a note for a role (toRole) or one card (toCard, from crew_context). It is included in the next prompt that role or card receives.",
  parameters: CrewNoteInput,
  success: Schema.Struct({ noteId: Schema.String }),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Leave a note for a teammate")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CrewValidateTool = Tool.make("crew_validate", {
  description:
    "Needs an agent working for a crew run. Check the text of a crew.yaml (kind 'crew', the default) or a .t3/crews.yaml toolbox file (kind 'toolbox') against this project. Returns diagnostics with line and column; nothing is written.",
  parameters: Schema.Struct({
    text: Schema.String,
    kind: Schema.optionalKey(Schema.Literals(["crew", "toolbox"])),
  }),
  success: CrewValidateResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Validate crew YAML")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CrewToolListTool = Tool.make("crew_tool_list", {
  description:
    "Needs an agent working for a crew run. Lists the tools in your role's toolbox: project commands such as its tests or linter, with the command each runs and its timeout.",
  success: CrewToolList,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List this role's crew tools")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CrewToolRunTool = Tool.make("crew_tool_run", {
  description:
    "Needs an agent working for a crew run. Runs a tool from your role's toolbox in your checkout and returns its exit code and the end of its output. `args` are appended to the tool's command and may hold only plain words such as paths, flags and test names. A tool outside your toolbox is refused.",
  parameters: CrewToolRunInput,
  success: CrewToolRunResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Run a crew tool")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

// Both start the server's process, so neither is on the read-only list.
const CrewMcpListToolsTool = Tool.make("crew_mcp_list_tools", {
  description:
    "Needs an agent working for a crew run. Lists the tools of an MCP server in your role's toolbox, with their input schemas. The crew starts the server for you; a server outside your toolbox is refused.",
  parameters: Schema.Struct({ server: Schema.String }),
  success: CrewMcpToolList,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List an MCP server's tools")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CrewMcpCallTool = Tool.make("crew_mcp_call", {
  description:
    "Needs an agent working for a crew run. Calls one tool of an MCP server in your role's toolbox and returns the server's result as is; `isError` is the tool's own failure. Use crew_mcp_list_tools first to see the tools and their arguments.",
  parameters: CrewMcpCallInput,
  success: CrewMcpCallResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Call an MCP server's tool")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const CrewToolkit = Toolkit.make(
  CrewContextTool,
  CrewReportTool,
  CrewDecideTool,
  CrewArtifactReadTool,
  CrewArtifactWriteTool,
  CrewSkillGetTool,
  CrewNoteTool,
  CrewValidateTool,
  CrewToolListTool,
  CrewToolRunTool,
  CrewMcpListToolsTool,
  CrewMcpCallTool,
);
