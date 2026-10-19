import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import {
  CrewMcpCallInput,
  CrewMcpCallResult,
  CrewMcpFailure,
  CrewMcpToolList,
} from "../../../../../../packages/contracts/src/fork/crews/crewMcp.ts";
import { CrewSummary } from "../../../../../../packages/contracts/src/fork/crews/crewFile.ts";
import {
  CrewInitCrew,
  CrewInitDryRun,
  CrewInitSkill,
  CrewInitSkillInput,
  CrewInitToolbox,
  CrewInitValidateInput,
} from "../../../../../../packages/contracts/src/fork/crews/crewInit.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as CrewCatalog from "../CrewCatalog.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];
// The `t3_*` tools also check that the calling thread's project is not Scratch ("No project").
const projectDependencies = [
  ...dependencies,
  CrewCatalog.CrewCatalog,
  ProjectService.ProjectService,
  ManagedProjectFolders.ManagedProjectFolders,
];
// A refusal is either the caller check's or the crew's own.
const failure = Schema.Union([OrchestratorMcpFailure, CrewMcpFailure]);

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

// `/crew-init` runs in ordinary threads, so these work in any thread with a project. They only
// read, so a Claude thread in plan mode can still inspect and propose; keep them in
// `readOnlyTools.ts`.

const T3SkillGetTool = Tool.make("t3_skill_get", {
  description:
    "Needs a thread with a project. Returns the instructions of a bundled T3 skill (`crew-init`), or with `file` another file in that skill's folder.",
  parameters: CrewInitSkillInput,
  success: CrewInitSkill,
  failure,
  failureMode: "return",
  dependencies: projectDependencies,
})
  .annotate(Tool.Title, "Load a T3 skill")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const T3CrewsListTool = Tool.make("t3_crews_list", {
  description:
    "Needs a thread with a project. Lists the crews installed in T3: id, name, description, roles with their tags, and each crew's status in this thread's project.",
  success: Schema.Struct({ crews: Schema.Array(CrewSummary) }),
  failure,
  failureMode: "return",
  dependencies: projectDependencies,
})
  .annotate(Tool.Title, "List installed crews")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const T3CrewsGetTool = Tool.make("t3_crews_get", {
  description:
    "Needs a thread with a project. One crew in this project: its roles and tags, its steps, every skill, MCP server and tool name it references, each role's resolved toolbox with sources, the names nothing resolves yet (`unresolved`), and its diagnostics. Holds no secret values.",
  parameters: Schema.Struct({ crewId: Schema.String }),
  success: CrewInitCrew,
  failure,
  failureMode: "return",
  dependencies: projectDependencies,
})
  .annotate(Tool.Title, "Get a crew's needs in this project")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const T3CrewsToolboxTool = Tool.make("t3_crews_toolbox", {
  description:
    "Needs a thread with a project. This project's `.t3/` toolbox: which files exist, the parsed crews.yaml grants, the skill, MCP server and tool definitions (MCP env values show as `${secret:NAME}` or `<redacted>`), the toolbox mode, diagnostics, and `mcpImports`: the stdio MCP servers in the repo's .mcp.json, .cursor/mcp.json, .vscode/mcp.json and .codex/config.toml, already converted to mcp.yaml form with secrets as `${secret:NAME}`.",
  success: CrewInitToolbox,
  failure,
  failureMode: "return",
  dependencies: projectDependencies,
})
  .annotate(Tool.Title, "Get this project's crew toolbox")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const T3CrewsValidateTool = Tool.make("t3_crews_validate", {
  description:
    "Needs a thread with a project. Dry run: `files` maps toolbox paths (crews.yaml, mcp.yaml, tools.yaml, skills/<name>/SKILL.md, relative to .t3/) to their proposed full text. Returns the project's toolbox diagnostics with line and column, and each installed crew's status, unresolved names and diagnostics as if those files were on disk. Writes nothing.",
  parameters: CrewInitValidateInput,
  success: CrewInitDryRun,
  failure,
  failureMode: "return",
  dependencies: projectDependencies,
})
  .annotate(Tool.Title, "Dry-run proposed crew toolbox files")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const CrewToolkit = Toolkit.make(
  CrewMcpListToolsTool,
  CrewMcpCallTool,
  T3SkillGetTool,
  T3CrewsListTool,
  T3CrewsGetTool,
  T3CrewsToolboxTool,
  T3CrewsValidateTool,
);
