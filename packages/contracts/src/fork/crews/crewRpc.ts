import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  CrewFile,
  CrewMcpFile,
  CrewsToolboxFile,
  CrewToolsFile,
} from "../../../../shared/src/fork/crews/crewFileSchema.ts";
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "../../auth.ts";
import { ProjectId } from "../../baseSchemas.ts";
import { ModelSelection } from "../../modelSelection.ts";
import { RuntimeMode } from "../../providerPolicy.ts";
import { CrewDiagnostic, CrewSummary, ResolvedRoleToolbox } from "./crewFile.ts";
import { CrewRoleOverride, ResolvedRoleModel, ResolvedRoleRuntimeMode } from "./crewModel.ts";
import { ToolboxMode } from "./crewToolbox.ts";

export const FORK_CREWS_WS_METHODS = {
  list: "forkCrews.list",
  get: "forkCrews.get",
  subscribe: "forkCrews.subscribe",
  validate: "forkCrews.validate",
  toolboxGet: "forkCrews.toolbox.get",
  toolboxSetMode: "forkCrews.toolbox.setMode",
  roleOverridesList: "forkCrews.roleOverrides.list",
  roleOverridesSet: "forkCrews.roleOverrides.set",
  roleOverridesReset: "forkCrews.roleOverrides.reset",
} as const;

/** Stream RPCs the client keeps subscribed. A new crews stream is added here, not in upstream. */
export type ForkCrewsSubscriptionRpcTag = typeof FORK_CREWS_WS_METHODS.subscribe;

export class ForkCrewsError extends Schema.TaggedError<ForkCrewsError>()("ForkCrewsError", {
  reason: Schema.Literals(["project_not_found", "crew_not_found", "unavailable"]),
  projectId: Schema.optionalKey(ProjectId),
  crewId: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "project_not_found":
        return `Project ${this.projectId ?? ""} was not found.`;
      case "crew_not_found":
        return `Crew ${this.crewId ?? ""} is not installed.`;
      case "unavailable":
        return "Crews could not be read.";
    }
  }
}

/** A project's `.t3/` toolbox: the definitions found, its grants, and how collisions resolve. */
export const ProjectToolbox = Schema.Struct({
  mode: ToolboxMode,
  skills: Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String })),
  mcp: CrewMcpFile,
  tools: CrewToolsFile,
  // Null when `.t3/crews.yaml` is missing or malformed; its grants are then ignored.
  grants: Schema.NullOr(CrewsToolboxFile),
  diagnostics: Schema.Array(CrewDiagnostic),
});
export type ProjectToolbox = typeof ProjectToolbox.Type;

export const CrewDetail = Schema.Struct({
  summary: CrewSummary,
  // Null when `crew.yaml` does not decode.
  definition: Schema.NullOr(CrewFile),
  diagnostics: Schema.Array(CrewDiagnostic),
  roles: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      model: ResolvedRoleModel,
      runtimeMode: ResolvedRoleRuntimeMode,
      toolbox: ResolvedRoleToolbox,
    }),
  ),
});
export type CrewDetail = typeof CrewDetail.Type;

/** Without `projectId`, results use T3 home only: no repo toolbox and no project overrides. */
const ProjectTarget = Schema.Struct({ projectId: Schema.optionalKey(ProjectId) });

export const CrewGetInput = Schema.Struct({ ...ProjectTarget.fields, crewId: Schema.String });
export type CrewGetInput = typeof CrewGetInput.Type;

export const CrewValidateInput = Schema.Struct({
  ...ProjectTarget.fields,
  text: Schema.String,
  kind: Schema.Literals(["crew", "toolbox"]),
  // Checks file references against this installed crew's folder.
  crewId: Schema.optionalKey(Schema.String),
});
export type CrewValidateInput = typeof CrewValidateInput.Type;

export const CrewToolboxSetModeInput = Schema.Struct({ projectId: ProjectId, mode: ToolboxMode });
export type CrewToolboxSetModeInput = typeof CrewToolboxSetModeInput.Type;

const EnvironmentScope = { scope: Schema.Literal("environment") };
const ProjectScope = { scope: Schema.Literal("project"), projectId: ProjectId };

export const CrewRoleOverrideScope = Schema.Union([
  Schema.Struct(EnvironmentScope),
  Schema.Struct(ProjectScope),
]);
export type CrewRoleOverrideScope = typeof CrewRoleOverrideScope.Type;

const OverrideSetFields = {
  crewId: Schema.String,
  roleId: Schema.String,
  // Omitted keeps the stored value; null clears it.
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  runtimeMode: Schema.optionalKey(Schema.NullOr(RuntimeMode)),
};
export const CrewRoleOverrideSetInput = Schema.Union([
  Schema.Struct({ ...EnvironmentScope, ...OverrideSetFields }),
  Schema.Struct({ ...ProjectScope, ...OverrideSetFields }),
]);
export type CrewRoleOverrideSetInput = typeof CrewRoleOverrideSetInput.Type;

// Without `roleId`, every role of the crew in that scope is reset.
const OverrideResetFields = { crewId: Schema.String, roleId: Schema.optionalKey(Schema.String) };
export const CrewRoleOverrideResetInput = Schema.Union([
  Schema.Struct({ ...EnvironmentScope, ...OverrideResetFields }),
  Schema.Struct({ ...ProjectScope, ...OverrideResetFields }),
]);
export type CrewRoleOverrideResetInput = typeof CrewRoleOverrideResetInput.Type;

const error = Schema.Union([ForkCrewsError, EnvironmentAuthorizationError]);

/** Spread into `WsRpcGroup`, which adds scope authorization. */
export const ForkCrewsRpcs = [
  Rpc.make(FORK_CREWS_WS_METHODS.list, {
    payload: ProjectTarget,
    success: Schema.Array(CrewSummary),
    error,
  }),
  Rpc.make(FORK_CREWS_WS_METHODS.get, { payload: CrewGetInput, success: CrewDetail, error }),
  /** One snapshot on subscribe, then a fresh list after every change. Re-read crew details on each. */
  Rpc.make(FORK_CREWS_WS_METHODS.subscribe, {
    payload: ProjectTarget,
    success: Schema.Array(CrewSummary),
    error,
    stream: true,
  }),
  Rpc.make(FORK_CREWS_WS_METHODS.validate, {
    payload: CrewValidateInput,
    success: Schema.Array(CrewDiagnostic),
    error,
  }),
  Rpc.make(FORK_CREWS_WS_METHODS.toolboxGet, {
    payload: Schema.Struct({ projectId: ProjectId }),
    success: ProjectToolbox,
    error,
  }),
  Rpc.make(FORK_CREWS_WS_METHODS.toolboxSetMode, { payload: CrewToolboxSetModeInput, error }),
  Rpc.make(FORK_CREWS_WS_METHODS.roleOverridesList, {
    payload: CrewRoleOverrideScope,
    success: Schema.Array(CrewRoleOverride),
    error,
  }),
  Rpc.make(FORK_CREWS_WS_METHODS.roleOverridesSet, {
    payload: CrewRoleOverrideSetInput,
    success: CrewRoleOverride,
    error,
  }),
  Rpc.make(FORK_CREWS_WS_METHODS.roleOverridesReset, {
    payload: CrewRoleOverrideResetInput,
    error,
  }),
] as const;

/** Writes the client checks before sending; spread into `CLIENT_GUARDED_RPC_SCOPES`. */
export const FORK_CREWS_GUARDED_RPC_SCOPES = {
  [FORK_CREWS_WS_METHODS.toolboxSetMode]: AuthSettingsWriteScope,
  [FORK_CREWS_WS_METHODS.roleOverridesSet]: AuthSettingsWriteScope,
  [FORK_CREWS_WS_METHODS.roleOverridesReset]: AuthSettingsWriteScope,
} as const;

export const FORK_CREWS_READ_RPC_SCOPES = {
  [FORK_CREWS_WS_METHODS.list]: AuthOrchestrationReadScope,
  [FORK_CREWS_WS_METHODS.get]: AuthOrchestrationReadScope,
  [FORK_CREWS_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [FORK_CREWS_WS_METHODS.validate]: AuthOrchestrationReadScope,
  [FORK_CREWS_WS_METHODS.toolboxGet]: AuthOrchestrationReadScope,
  [FORK_CREWS_WS_METHODS.roleOverridesList]: AuthOrchestrationReadScope,
} as const;

/** The `rpc.aggregate` span label of each crews RPC; spread into `RPC_AGGREGATES`. */
export const FORK_CREWS_RPC_AGGREGATES = {
  [FORK_CREWS_WS_METHODS.list]: "forkCrews",
  [FORK_CREWS_WS_METHODS.get]: "forkCrews",
  [FORK_CREWS_WS_METHODS.subscribe]: "forkCrews",
  [FORK_CREWS_WS_METHODS.validate]: "forkCrews",
  [FORK_CREWS_WS_METHODS.toolboxGet]: "forkCrews",
  [FORK_CREWS_WS_METHODS.toolboxSetMode]: "forkCrews",
  [FORK_CREWS_WS_METHODS.roleOverridesList]: "forkCrews",
  [FORK_CREWS_WS_METHODS.roleOverridesSet]: "forkCrews",
  [FORK_CREWS_WS_METHODS.roleOverridesReset]: "forkCrews",
} as const;
