import * as Schema from "effect/Schema";

import {
  CrewMcpFile,
  CrewsToolboxFile,
  CrewToolsFile,
} from "../../../../shared/src/fork/crews/crewFileSchema.ts";
import { CrewDiagnostic, CrewSummary, ResolvedRoleToolbox } from "./crewFile.ts";
import { ToolboxMode } from "./crewToolbox.ts";

// The `t3_*` tools `/crew-init` uses from an ordinary thread. None of them returns a secret value.

const Names = Schema.Array(Schema.String);

/** Skill, MCP server and tool names, one list per kind. */
export const CrewToolboxNames = Schema.Struct({ skills: Names, mcp: Names, tools: Names });
export type CrewToolboxNames = typeof CrewToolboxNames.Type;

export const CrewInitSkillInput = Schema.Struct({
  name: Schema.String,
  file: Schema.optionalKey(Schema.String),
});

export const CrewInitSkill = Schema.Struct({
  name: Schema.String,
  file: Schema.String,
  content: Schema.String,
});
export type CrewInitSkill = typeof CrewInitSkill.Type;

/** One crew in the calling thread's project: what it names and what this project leaves unresolved. */
export const CrewInitCrew = Schema.Struct({
  summary: CrewSummary,
  roles: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      // What the role lists itself, plus the crew-wide lists every role gets.
      references: CrewToolboxNames,
      toolbox: ResolvedRoleToolbox.fields.items,
    }),
  ),
  // `task` is the step's prompt or the path of its prompt file in the crew folder.
  steps: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      type: Schema.String,
      role: Schema.optionalKey(Schema.String),
      task: Schema.optionalKey(Schema.String),
      tool: Schema.optionalKey(Schema.String),
    }),
  ),
  references: CrewToolboxNames,
  unresolved: CrewToolboxNames,
  diagnostics: Schema.Array(CrewDiagnostic),
});
export type CrewInitCrew = typeof CrewInitCrew.Type;

const CrewMcpServer = Schema.Struct({
  command: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

/**
 * An MCP server found in a provider config of the repo, converted to `mcp.yaml` form. Secret
 * values are already `${secret:NAME}`; `unsupported` says why a server cannot be imported.
 */
export const CrewMcpImport = Schema.Struct({
  source: Schema.String,
  name: Schema.String,
  server: Schema.optionalKey(CrewMcpServer),
  unsupported: Schema.optionalKey(Schema.String),
  // Secrets the user must add in Settings, Crews before the server can start.
  secrets: Names,
});
export type CrewMcpImport = typeof CrewMcpImport.Type;

/** The project's `.t3/` toolbox. MCP `env` values show as `${secret:NAME}` or `<redacted>`. */
export const CrewInitToolbox = Schema.Struct({
  directory: Schema.String,
  // Paths relative to `.t3/` that exist: crews.yaml, mcp.yaml, tools.yaml, skills/<name>/SKILL.md.
  files: Names,
  mode: ToolboxMode,
  grants: Schema.NullOr(CrewsToolboxFile),
  skills: Names,
  mcp: CrewMcpFile,
  tools: CrewToolsFile,
  mcpImports: Schema.Array(CrewMcpImport),
  diagnostics: Schema.Array(CrewDiagnostic),
});
export type CrewInitToolbox = typeof CrewInitToolbox.Type;

export const CrewInitValidateInput = Schema.Struct({
  // Toolbox path to its proposed full text: crews.yaml, mcp.yaml, tools.yaml, skills/<name>/SKILL.md.
  files: Schema.Record(Schema.String, Schema.String),
});
export type CrewInitValidateInput = typeof CrewInitValidateInput.Type;

/** The project and every installed crew as if the proposed files were on disk. */
export const CrewInitDryRun = Schema.Struct({
  diagnostics: Schema.Array(CrewDiagnostic),
  crews: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: CrewSummary.fields.status,
      unresolved: CrewToolboxNames,
      diagnostics: Schema.Array(CrewDiagnostic),
    }),
  ),
});
export type CrewInitDryRun = typeof CrewInitDryRun.Type;
