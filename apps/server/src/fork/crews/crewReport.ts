/**
 * What a role may report for a card, and whether a report is acceptable. Shared
 * by `crew_report` and the fenced `crew-report` block a role without tools ends
 * its turn with.
 *
 * @module crewReport
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  CrewArtifact,
  CrewArtifactShape,
  CrewFile,
} from "../../../../../packages/contracts/src/fork/crews/crewFile.ts";
import {
  CrewDecideInput,
  CrewReportInput,
} from "../../../../../packages/contracts/src/fork/crews/crewRun.ts";
import { isCrewListShape } from "../../../../../packages/shared/src/fork/crews/crewTemplates.ts";

export interface CrewReport {
  readonly outcome: string;
  readonly summary: string;
  readonly artifacts: Record<string, unknown>;
}

/** A step's routed outcomes, plus `done` when it has a plain `next` or routes nothing. */
export function crewStepOutcomes(crew: CrewFile, stepId: string): ReadonlyArray<string> {
  const step = Object.hasOwn(crew.flow.steps, stepId) ? crew.flow.steps[stepId] : undefined;
  if (step === undefined || step.type === "end") return [];
  const outcomes = Object.keys(step.outcomes ?? {});
  return step.next !== undefined || outcomes.length === 0 ? [...outcomes, "done"] : outcomes;
}

/** The artifacts a step must hand over. Only steps a role runs produce any. */
export function crewStepProduces(crew: CrewFile, stepId: string): ReadonlyArray<string> {
  const step = Object.hasOwn(crew.flow.steps, stepId) ? crew.flow.steps[stepId] : undefined;
  return step !== undefined && "produces" in step ? (step.produces ?? []) : [];
}

function shapeErrors(shape: CrewArtifactShape, value: unknown, path: string): Array<string> {
  if (shape === "string" || shape === "number" || shape === "boolean") {
    return typeof value === shape ? [] : [`${path} must be a ${shape}.`];
  }
  if (shape === "string[]" || isCrewListShape(shape)) {
    const item = shape === "string[]" ? "string" : shape.item;
    return Array.isArray(value)
      ? value.flatMap((entry, index) => shapeErrors(item, entry, `${path}[${index}]`))
      : [`${path} must be a list.`];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${path} must be an object.`];
  }
  return Object.entries(shape).flatMap(([key, child]) =>
    Object.hasOwn(value, key)
      ? shapeErrors(child, (value as Record<string, unknown>)[key], `${path}.${key}`)
      : [`${path}.${key} is required.`],
  );
}

/** Why `value` is not the artifact `name`; each message names the field at fault. */
export function crewArtifactErrors(artifact: CrewArtifact, value: unknown, name: string) {
  return shapeErrors(
    artifact.type === "object"
      ? artifact.schema
      : artifact.type === "list"
        ? { type: "list", item: artifact.item }
        : "string",
    value,
    name,
  );
}

/** Why a report cannot be recorded, or nothing when it can. */
export function crewReportErrors(
  crew: CrewFile,
  stepId: string,
  report: CrewReport,
): ReadonlyArray<string> {
  const errors: Array<string> = [];
  // `failed` is reserved: a role may always say it could not do the work.
  const outcomes = [...crewStepOutcomes(crew, stepId), "failed"];
  if (!outcomes.includes(report.outcome)) {
    errors.push(`Outcome "${report.outcome}" is not allowed. Use one of: ${outcomes.join(", ")}.`);
  }
  const produces = crewStepProduces(crew, stepId);
  for (const [name, value] of Object.entries(report.artifacts)) {
    const artifact = Object.hasOwn(crew.artifacts ?? {}, name) ? crew.artifacts?.[name] : undefined;
    if (!produces.includes(name) || artifact === undefined) {
      errors.push(
        `Artifact "${name}" is not produced by this step. It produces: ${produces.join(", ") || "nothing"}.`,
      );
    } else errors.push(...crewArtifactErrors(artifact, value, name));
  }
  if (report.outcome !== "failed") {
    for (const name of produces) {
      if (!Object.hasOwn(report.artifacts, name)) {
        errors.push(`Artifact "${name}" is required.`);
      }
    }
  }
  return errors;
}

const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(CrewReportInput));
const decodeDecision = Schema.decodeUnknownOption(Schema.fromJsonString(CrewDecideInput));

/** The body of the last fenced block of that kind in a message. */
const lastBlock = (text: string, kind: "crew-report" | "crew-decision") =>
  [...text.matchAll(new RegExp(`\`\`\`${kind}[^\\n]*\\n([\\s\\S]*?)\`\`\``, "gu"))].at(-1)?.[1];

/** The last fenced `crew-report` block in a role's final message, when it holds a report. */
export function parseCrewReportBlock(text: string): CrewReport | null {
  const body = lastBlock(text, "crew-report");
  if (body === undefined) return null;
  return Option.match(decodeReport(body), {
    onNone: () => null,
    onSome: (report) => ({ ...report, artifacts: report.artifacts ?? {} }),
  });
}

/** The last fenced `crew-decision` block in the lead's final message, when it holds an answer. */
export function parseCrewDecisionBlock(text: string): CrewDecideInput | null {
  const body = lastBlock(text, "crew-decision");
  return body === undefined ? null : Option.getOrNull(decodeDecision(body));
}
