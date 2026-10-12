// @effect-diagnostics nodeBuiltinImport:off - Effect's Path has no glob matcher.
/**
 * What a crew run writes into git and checks against it: card branch names,
 * commit messages, the paths a card owns. Pure; `CrewRunService` runs the git.
 *
 * @module crewGit
 */
import * as NodePath from "node:path";

import type { CrewFile } from "../../../../../packages/contracts/src/fork/crews/crewFile.ts";
import type { ModelSelection } from "../../../../../packages/contracts/src/modelSelection.ts";
import type { CrewCard } from "./engine/types.ts";

/** The last eight characters of a run id, as branch names and commit trailers show it. */
export const crewShortRunId = (runId: string) => runId.slice(-8);

/** The branch of a card with its own worktree. A later attempt gets its own, as it has its own thread. */
export function crewCardBranch(runId: string, card: CrewCard) {
  const item = card.itemIndex === null ? "" : `-${card.itemIndex}`;
  const attempt = card.attempt === 1 ? "" : `-a${card.attempt}`;
  return `crew/${crewShortRunId(runId)}/${card.stepId}-${card.visit}${item}${attempt}`;
}

/** The subject and trailer block of a commit the crew makes for a card. */
export function crewCommitMessage(input: {
  readonly runId: string;
  readonly card: Pick<CrewCard, "stepId" | "visit" | "itemIndex" | "attempt" | "roleId">;
  readonly model: ModelSelection | null;
  readonly summary: string | null;
}): readonly [subject: string, trailers: string] {
  const { card } = input;
  const firstLine = input.summary?.split("\n").find((line) => line.trim().length > 0);
  const subject = `crew(${card.stepId}): ${firstLine?.trim() ?? "work in progress"}`.slice(0, 72);
  const item = card.itemIndex === null ? "" : `#${card.itemIndex + 1}`;
  return [
    subject,
    [
      `Crew-Run: ${crewShortRunId(input.runId)}`,
      `Crew-Step: ${card.stepId}${item} (visit ${card.visit}, attempt ${card.attempt})`,
      ...(card.roleId === null ? [] : [`Crew-Role: ${card.roleId}`]),
      // The instance tells two accounts on one provider apart.
      ...(input.model === null
        ? []
        : [`Crew-Model: ${input.model.instanceId}/${input.model.model}`]),
    ].join("\n"),
  ];
}

/** The value a `{{key.path}}` template names, when the text is nothing but that template. */
function templateValue(text: string, context: Readonly<Record<string, unknown>>) {
  const key = /^\{\{([^{}]+)\}\}$/u.exec(text.trim())?.[1];
  if (key === undefined) return undefined;
  let value: unknown = context;
  for (const part of key.trim().split(".")) {
    value =
      typeof value === "object" && value !== null && Object.hasOwn(value, part)
        ? (value as Record<string, unknown>)[part]
        : undefined;
  }
  return value;
}

/** The globs a card may change: its step's `owns`, else its role's. Empty means anything. */
export function crewCardOwns(crew: CrewFile, card: Pick<CrewCard, "stepId" | "roleId" | "item">) {
  const step = crew.flow.steps[card.stepId];
  const role = card.roleId === null ? undefined : crew.roles[card.roleId];
  const declared = (step !== undefined && "owns" in step ? step.owns : undefined) ?? role?.owns;
  return [declared ?? []].flat().flatMap((entry): ReadonlyArray<string> => {
    // A fan-out step usually takes its globs from the item, as a list.
    const value = templateValue(entry, { item: card.item });
    if (value === undefined) return [entry];
    return [value].flat().filter((glob): glob is string => typeof glob === "string");
  });
}

/** The changed paths no glob covers. A glob naming a folder covers everything in it. */
export function crewOwnershipViolations(
  changedPaths: ReadonlyArray<string>,
  owns: ReadonlyArray<string>,
) {
  if (owns.length === 0) return [];
  return changedPaths.filter(
    (file) =>
      !owns.some(
        (glob) =>
          NodePath.posix.matchesGlob(file, glob) ||
          file.startsWith(`${glob.replace(/\/+$/u, "")}/`),
      ),
  );
}

/** Words a role may append to a tool's command: paths, flags and names, nothing a shell reads. */
export const isPlainToolArgument = (value: string) => /^[\w./\\:=@,+-]+$/u.test(value);
