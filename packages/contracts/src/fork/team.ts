import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ModelSelection, RuntimeMode } from "../orchestration.ts";

export const TeamRoleId = TrimmedNonEmptyString.pipe(Schema.brand("TeamRoleId"));
export type TeamRoleId = typeof TeamRoleId.Type;

export const TeamRoleKind = Schema.Literals([
  "implementer",
  "reviewer",
  "researcher",
  "plan-reviewer",
]);
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

/** `build` workflows implement and integrate; `plan` workflows stop at an approved plan. */
export const TeamWorkflowType = Schema.Literals(["build", "plan"]);
export type TeamWorkflowType = typeof TeamWorkflowType.Type;

const ArtifactDirectory = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (path) =>
      (!/^[\\/]/.test(path) && !/[:\p{Cc}]/u.test(path) && !path.split(/[\\/]/).includes("..")) ||
      "Use a relative folder without '..', drive letters, or control characters.",
  ),
);

/** Validate folder edits without rejecting previously saved workflows and thread snapshots. */
export const EditableArtifactDirectory = ArtifactDirectory.check(
  Schema.makeFilter((path) => {
    const segments = path.split(/[\\/]/);
    return (
      (segments.some((segment) => segment !== "" && segment !== ".") &&
        !segments.some((segment) => segment !== "." && /[. ]$/.test(segment))) ||
      "Use a folder below the checkout root without names ending in a dot or space."
    );
  }),
);

export const TeamWorkflow = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  builtIn: Schema.Boolean,
  type: TeamWorkflowType.pipe(Schema.withDecodingDefault(Effect.succeed("build" as const))),
  plansDir: Schema.optional(ArtifactDirectory),
  researchDir: Schema.optional(ArtifactDirectory),
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
