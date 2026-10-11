import * as Schema from "effect/Schema";

import { ProjectId } from "../../baseSchemas.ts";
import { ModelSelection } from "../../modelSelection.ts";
import { RuntimeMode } from "../../providerPolicy.ts";

/** A per-role setting stored on this environment, for every project or for one. */
export const CrewRoleOverride = Schema.Struct({
  scope: Schema.Literals(["environment", "project"]),
  projectId: Schema.NullOr(ProjectId),
  crewId: Schema.String,
  roleId: Schema.String,
  modelSelection: Schema.NullOr(ModelSelection),
  // Null inherits.
  runtimeMode: Schema.NullOr(RuntimeMode),
  updatedAt: Schema.String,
});
export type CrewRoleOverride = typeof CrewRoleOverride.Type;

export const ResolvedRoleModel = Schema.Struct({
  // Null when nothing above the composer applies and no composer selection was given.
  selection: Schema.NullOr(ModelSelection),
  source: Schema.Literals(["run", "project", "environment", "crew-hint", "composer"]),
  warnings: Schema.Array(Schema.String),
});
export type ResolvedRoleModel = typeof ResolvedRoleModel.Type;

export const ResolvedRoleRuntimeMode = Schema.Struct({
  // "inherit" only when the run's starting mode was not given.
  runtimeMode: Schema.Union([RuntimeMode, Schema.Literal("inherit")]),
  source: Schema.Literals(["run", "project", "environment", "crew-hint", "inherit"]),
  clamped: Schema.Boolean,
});
export type ResolvedRoleRuntimeMode = typeof ResolvedRoleRuntimeMode.Type;
