/**
 * CrewPromptComposer - the user message a card's thread receives: the step's
 * task, then who the role is, what it has to work with, and how to report.
 *
 * Pure: everything comes from the run's frozen snapshot.
 *
 * @module CrewPromptComposer
 */
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

import type { CrewFile } from "../../../../../packages/contracts/src/fork/crews/crewFile.ts";
import type { CrewRunToolbox } from "../../../../../packages/contracts/src/fork/crews/crewRun.ts";
import { normalizedPath } from "../../../../../packages/shared/src/fork/crews/validateCrew.ts";
import { crewStepOutcomes, crewStepProduces } from "./crewReport.ts";

/** Crew files by path relative to the crew folder. */
type CrewFiles = Readonly<Record<string, string>>;

export interface CrewPromptInput {
  readonly crew: CrewFile;
  readonly files: CrewFiles;
  readonly stepId: string;
  readonly inputs: Readonly<Record<string, string | boolean>>;
  readonly artifacts: Readonly<Record<string, unknown>>;
  /** The latest result of every step that has one, for `{{steps.<id>.summary}}`. */
  readonly steps: Readonly<
    Record<string, { readonly summary: string; readonly outcome: string | null }>
  >;
  /** The steps that route straight into this one. */
  readonly previousSteps: ReadonlyArray<string>;
  /** The fan-out item this card works on, for `{{item.*}}`. */
  readonly item: unknown;
  readonly branch: string | null;
  /** Picks the role's model-family overlay. */
  readonly driver: string | null;
  readonly toolbox: CrewRunToolbox;
  /** Notes teammates left for this role or card. */
  readonly notes: ReadonlyArray<string>;
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u;
/** Above this an artifact is named, not pasted; the role reads it with `crew_artifact_read`. */
const INLINE_ARTIFACT_CHARS = 4_000;
const OVERLAY_FAMILY: Readonly<Record<string, string>> = { claudeAgent: "claude", codex: "gpt" };

const fileName = (value: string) =>
  normalizedPath(value.startsWith("file:") ? value.slice(5).trim() : value);

/** A file's text when the value names a crew file, as the validator decides it; else the value. */
function crewText(files: CrewFiles, value: string) {
  const name = fileName(value);
  return Object.hasOwn(files, name) ? (files[name] ?? value) : value;
}

/** The crew files a prompt can read, which is what a run freezes with its definition. */
export function crewPromptFiles(crew: CrewFile, files: CrewFiles): Record<string, string> {
  const names = new Set(Object.keys(files).filter((name) => name.startsWith("overlays/")));
  const add = (value: string | undefined) => {
    if (value !== undefined && Object.hasOwn(files, fileName(value))) names.add(fileName(value));
  };
  for (const [roleId, role] of Object.entries(crew.roles)) {
    add(role.instructions);
    add(`roles/${roleId}/role.md`);
    add(`roles/${roleId}.md`);
    for (const fact of role.persona?.facts ?? []) add(fact);
  }
  for (const step of Object.values(crew.flow.steps)) if ("task" in step) add(step.task);
  return Object.fromEntries([...names].map((name) => [name, files[name] ?? ""]));
}

/** Fills `{{key.path}}` from the context. A missing key renders empty; a non-string as JSON. */
export function renderCrewTemplate(text: string, context: Readonly<Record<string, unknown>>) {
  return text.replace(/\{\{([\s\S]*?)\}\}/gu, (_match, key: string) => {
    let value: unknown = context;
    for (const part of key.trim().split(".")) {
      value =
        typeof value === "object" && value !== null && Object.hasOwn(value, part)
          ? (value as Record<string, unknown>)[part]
          : undefined;
    }
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  });
}

function roleSection(input: CrewPromptInput, roleId: string) {
  const { crew, files } = input;
  const role = crew.roles[roleId];
  if (role === undefined) return "";
  // A role file may carry `.claude/agents` frontmatter, which is not instructions.
  const instructions = (
    role.instructions === undefined
      ? (files[`roles/${roleId}/role.md`] ?? files[`roles/${roleId}.md`] ?? "")
      : crewText(files, role.instructions)
  )
    .replace(FRONTMATTER, "")
    .trim();
  const persona = role.persona;
  const list = (title: string, values: ReadonlyArray<string> | undefined) =>
    values === undefined || values.length === 0
      ? []
      : [`${title}:\n${values.map((value) => `- ${crewText(files, value).trim()}`).join("\n")}`];
  const overlay =
    input.driver === null
      ? undefined
      : files[`overlays/${OVERLAY_FAMILY[input.driver] ?? input.driver}.md`];
  return [
    `You are the ${role.name} of the "${crew.name}" crew.`,
    instructions,
    ...(persona?.identity === undefined ? [] : [`Identity: ${persona.identity}`]),
    ...(persona?.communicationStyle === undefined
      ? []
      : [`Communication style: ${persona.communicationStyle}`]),
    ...list("Principles", persona?.principles),
    ...list("Facts", persona?.facts),
    ...(overlay === undefined ? [] : [overlay.trim()]),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function compose(input: CrewPromptInput, inlineArtifacts: boolean) {
  const { crew } = input;
  const step = crew.flow.steps[input.stepId];
  if (step === undefined || !("task" in step)) return "";
  const context = {
    inputs: input.inputs,
    artifacts: input.artifacts,
    steps: input.steps,
    run: { branch: input.branch ?? "" },
    item: input.item,
  };
  const render = (text: string) => renderCrewTemplate(text, context);

  const artifacts = (step.consumes ?? []).map((name) => {
    const json = JSON.stringify(input.artifacts[name] ?? null, null, 2);
    return inlineArtifacts && json.length <= INLINE_ARTIFACT_CHARS
      ? `Artifact \`${name}\`:\n${json}`
      : `Artifact \`${name}\`: read it with \`crew_artifact_read\`.`;
  });
  const previous = input.previousSteps.flatMap((id) => {
    const result = input.steps[id];
    return result === undefined
      ? []
      : [`Step \`${id}\` finished with \`${result.outcome ?? "done"}\`:\n${result.summary}`];
  });
  const brief = Object.entries(input.inputs).map(([name, value]) => `${name}: ${String(value)}`);
  const owns = step.owns === undefined ? [] : [step.owns].flat().map(render);
  const outcomes = crewStepOutcomes(crew, input.stepId);
  const produces = crewStepProduces(crew, input.stepId);

  const sections: ReadonlyArray<readonly [title: string, body: ReadonlyArray<string>]> = [
    ["Task", [render(crewText(input.files, step.task)).trim()]],
    ["Your role", [roleSection(input, step.role)]],
    [
      "Context",
      [
        ...(brief.length === 0 ? [] : [`Run brief:\n${brief.join("\n")}`]),
        ...artifacts,
        ...previous,
        ...input.notes.map((note) => `Note from a teammate:\n${note}`),
      ],
    ],
    [
      "Workspace rules",
      [
        ...(input.branch === null ? [] : [`You work on branch \`${input.branch}\`.`]),
        "Do not push, switch branches or open pull requests. The crew commits and merges for you.",
        ...(owns.length === 0 ? [] : [`Stay inside the paths you own: ${owns.join(", ")}.`]),
      ],
    ],
    [
      "Skills",
      input.toolbox.skills.length === 0
        ? []
        : [
            input.toolbox.skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n"),
            "Load a skill's instructions with `crew_skill_get` before you rely on it.",
          ],
    ],
    [
      "Protocol",
      [
        `Allowed outcomes: ${outcomes.join(", ")}. Report \`failed\` if you cannot do the work.`,
        ...produces.map(
          (name) =>
            `Required artifact \`${name}\`, shaped as: ${JSON.stringify(crew.artifacts?.[name] ?? null)}`,
        ),
        "Call `crew_report` once with your outcome, a summary and the artifacts before you end your turn.",
        [
          "If you have no tools, end your reply with this block instead:",
          "```crew-report",
          '{ "outcome": "<outcome>", "summary": "<what you did>", "artifacts": {} }',
          "```",
        ].join("\n"),
      ],
    ],
  ];
  return sections
    .filter(([, body]) => body.some((part) => part.length > 0))
    .map(([title, body]) => `## ${title}\n\n${body.filter((part) => part.length > 0).join("\n\n")}`)
    .join("\n\n");
}

/** The prompt for one card. An oversized one names its artifacts before anything is cut. */
export function composeCrewCardPrompt(input: CrewPromptInput): string {
  const prompt = compose(input, true);
  return (
    prompt.length <= PROVIDER_SEND_TURN_MAX_INPUT_CHARS ? prompt : compose(input, false)
  ).slice(0, PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
}

/** Sent once to a role that ended its turn without reporting. */
export function crewReminderPrompt(crew: CrewFile, stepId: string): string {
  return [
    "You ended your turn without `crew_report`.",
    `Report now with one of: ${[...crewStepOutcomes(crew, stepId), "failed"].join(", ")}.`,
    "If you have no tools, reply with a fenced `crew-report` block holding outcome, summary and artifacts.",
  ].join(" ");
}
