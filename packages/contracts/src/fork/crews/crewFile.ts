import * as Schema from "effect/Schema";

import type * as FileSchema from "../../../../shared/src/fork/crews/crewFileSchema.ts";

// Type-only imports keep the authoring schemas authoritative without loading YAML in clients.
export type CrewFile = typeof FileSchema.CrewFile.Type;
export type CrewRole = typeof FileSchema.CrewRole.Type;
export type CrewStep = typeof FileSchema.CrewStep.Type;
export type CrewRoute = typeof FileSchema.CrewRoute.Type;
export type CrewModelHint = typeof FileSchema.CrewModelHint.Type;
export type CrewRoleFrontmatter = typeof FileSchema.CrewRoleFrontmatter.Type;
export type CrewMcpFile = typeof FileSchema.CrewMcpFile.Type;
export type CrewToolsFile = typeof FileSchema.CrewToolsFile.Type;
export type CrewArtifact = typeof FileSchema.CrewArtifact.Type;
export type { CrewArtifactShape } from "../../../../shared/src/fork/crews/crewFileSchema.ts";

const DiagnosticPath = Schema.Array(Schema.Union([Schema.String, Schema.Number]));

export const CrewDiagnostic = Schema.Struct({
  severity: Schema.Literals(["error", "warning", "info"]),
  message: Schema.String,
  file: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  path: DiagnosticPath,
});
export type CrewDiagnostic = typeof CrewDiagnostic.Type;

export const CrewSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  path: Schema.String,
  roles: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      description: Schema.optionalKey(Schema.String),
      tags: Schema.Array(Schema.String),
    }),
  ),
  // Null when the crew file cannot say who runs in the home thread.
  home: Schema.NullOr(
    Schema.Struct({
      mode: Schema.Literals(["first-step", "lead"]),
      roleId: Schema.String,
      source: Schema.Literals(["explicit", "auto"]),
    }),
  ),
  status: Schema.Literals(["ok", "warnings", "invalid"]),
  diagnosticCounts: Schema.Struct({
    errors: Schema.Number,
    warnings: Schema.Number,
    info: Schema.Number,
  }),
});
export type CrewSummary = typeof CrewSummary.Type;

export const ResolvedRoleToolbox = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["skill", "mcp", "tool"]),
      name: Schema.String,
      path: Schema.String,
      source: Schema.Literals(["role", "crew", "home", "repo"]),
      grantedBy: Schema.Array(Schema.Struct({ file: Schema.String, path: DiagnosticPath })),
    }),
  ),
  diagnostics: Schema.Array(CrewDiagnostic),
});
export type ResolvedRoleToolbox = typeof ResolvedRoleToolbox.Type;
