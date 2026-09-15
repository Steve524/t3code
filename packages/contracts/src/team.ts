import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection, RuntimeMode } from "./orchestration.ts";

export const TeamRoleId = TrimmedNonEmptyString.pipe(Schema.brand("TeamRoleId"));
export type TeamRoleId = typeof TeamRoleId.Type;

export const TeamRoleKind = Schema.Literals(["implementer", "reviewer"]);
export type TeamRoleKind = typeof TeamRoleKind.Type;

export const TeamRole = Schema.Struct({
  id: TeamRoleId,
  label: TrimmedNonEmptyString,
  kind: TeamRoleKind,
  enabled: Schema.Boolean,
  summary: Schema.String,
  modelSelection: Schema.NullOr(Schema.suspend(() => ModelSelection)),
  runtimeMode: Schema.NullOr(Schema.suspend(() => RuntimeMode)),
  instructions: Schema.String,
});
export type TeamRole = typeof TeamRole.Type;

export const TeamWorkflow = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  builtIn: Schema.Boolean,
  roles: Schema.Array(TeamRole),
  maxParallelWorkers: PositiveInt,
  maxReviewRounds: PositiveInt,
  maxAutoReports: PositiveInt,
  orchestratorInstructions: Schema.String,
});
export type TeamWorkflow = typeof TeamWorkflow.Type;

export const ThreadTeamInfo = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("orchestrator"),
    workflow: TeamWorkflow,
  }),
  Schema.Struct({
    role: Schema.Literal("worker"),
    orchestratorThreadId: ThreadId,
    roleId: TeamRoleId,
    roleLabel: TrimmedNonEmptyString,
    taskTitle: TrimmedNonEmptyString,
    reviewRound: Schema.optional(NonNegativeInt),
  }),
]);
export type ThreadTeamInfo = typeof ThreadTeamInfo.Type;
