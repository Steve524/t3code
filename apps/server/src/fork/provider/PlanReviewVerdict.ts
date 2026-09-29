import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { toJsonSchemaObject } from "../../textGeneration/TextGenerationUtils.ts";
import { PLAN_LOOP_PROTOCOL } from "./PlanLoopSkill.ts";
import type { RuntimeInstructionTeam } from "./TeamRuntimeInstructions.ts";

export const ReviewVerdict = Schema.Struct({
  verdict: Schema.Literals(["APPROVED", "REVISE", "BLOCKED"]),
  planHash: TrimmedNonEmptyString,
  baseline: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  findings: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      severity: Schema.Literals(["critical", "major", "minor"]),
      evidence: TrimmedNonEmptyString,
      proposedFix: TrimmedNonEmptyString,
    }),
  ),
  coverage: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  limitations: Schema.Array(TrimmedNonEmptyString),
});

const outputSchema = toJsonSchemaObject(ReviewVerdict);

export const codexPlanReviewOutput = (team?: RuntimeInstructionTeam) =>
  team?.role === "worker" &&
  team.roleId === "reviewer" &&
  team.workflow?.protocolId === PLAN_LOOP_PROTOCOL
    ? { outputSchema }
    : {};
