/**
 * CrewPromptComposer - the user message a card's thread receives: the step's
 * task, then who the role is, what it has to work with, and how to report.
 *
 * Pure: everything comes from the run's frozen snapshot.
 *
 * @module CrewPromptComposer
 */
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

import type {
  CrewFile,
  CrewRoute,
} from "../../../../../packages/contracts/src/fork/crews/crewFile.ts";
import { normalizedPath } from "../../../../../packages/shared/src/fork/crews/validateCrew.ts";

/** A step's routed outcomes, plus `done` when it has a plain `next` or routes nothing. */
function crewStepOutcomes(crew: CrewFile, stepId: string): ReadonlyArray<string> {
  const step = Object.hasOwn(crew.flow.steps, stepId) ? crew.flow.steps[stepId] : undefined;
  if (step === undefined || step.type === "end") return [];
  const outcomes = Object.keys(step.outcomes ?? {});
  return step.next !== undefined || outcomes.length === 0 ? [...outcomes, "done"] : outcomes;
}

/** The artifacts a step must hand over. Only steps a role runs produce any. */
function crewStepProduces(crew: CrewFile, stepId: string): ReadonlyArray<string> {
  const step = Object.hasOwn(crew.flow.steps, stepId) ? crew.flow.steps[stepId] : undefined;
  return step !== undefined && "produces" in step ? (step.produces ?? []) : [];
}

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
  readonly toolbox: {
    readonly skills: ReadonlyArray<{ readonly name: string; readonly description: string }>;
    readonly mcp: ReadonlyArray<{ readonly name: string }>;
    readonly tools: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
  };
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

function roleSection(input: Pick<CrewPromptInput, "crew" | "files" | "driver">, roleId: string) {
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
  const gateway = input.toolbox.mcp;

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
      "Tools",
      [
        ...(input.toolbox.tools.length === 0
          ? []
          : [
              input.toolbox.tools
                .map(
                  (tool) =>
                    `- ${tool.name}${tool.description === undefined ? "" : `: ${tool.description}`}`,
                )
                .join("\n"),
              "Run one with `crew_tool_run`. It runs in your checkout and returns its exit code and the end of its output.",
            ]),
        ...(gateway.length === 0
          ? []
          : [
              `MCP servers you reach through \`crew_mcp_list_tools\` and \`crew_mcp_call\`: ${gateway.map((server) => server.name).join(", ")}.`,
            ]),
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

/** The prompt for the role a merge step names to resolve a conflict left in the shared checkout. */
export function composeCrewConflictPrompt(
  input: Pick<CrewPromptInput, "crew" | "files" | "driver" | "branch"> & {
    readonly roleId: string;
    readonly paths: ReadonlyArray<string>;
  },
): string {
  const sections = [
    [
      "Task",
      [
        `Merging the crew's work${input.branch === null ? "" : ` into \`${input.branch}\``} stopped on conflicts in:`,
        input.paths.map((file) => `- ${file}`).join("\n"),
        "Resolve every conflict in these files so that both sides' intent is kept, and remove the conflict markers.",
      ].join("\n\n"),
    ],
    ["Your role", roleSection(input, input.roleId)],
    [
      "Workspace rules",
      "Edit the files in place. Do not commit, abort the merge, switch branches or push. The crew checks the files and commits the merge when your turn ends.",
    ],
    [
      "Protocol",
      "Call `crew_report` once with outcome `done` and a summary of how you resolved each file before you end your turn.",
    ],
  ];
  return sections
    .map(([title, body]) => `## ${title}\n\n${body}`)
    .join("\n\n")
    .slice(0, PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
}

/** Sent once to a role that ended its turn without reporting. */
export function crewReminderPrompt(crew: CrewFile, stepId: string): string {
  return [
    "You ended your turn without `crew_report`.",
    `Report now with one of: ${[...crewStepOutcomes(crew, stepId), "failed"].join(", ")}.`,
    "If you have no tools, reply with a fenced `crew-report` block holding outcome, summary and artifacts.",
  ].join(" ");
}

const sectioned = (sections: ReadonlyArray<readonly [title: string, body: string]>) =>
  sections
    .filter(([, body]) => body.length > 0)
    .map(([title, body]) => `## ${title}\n\n${body}`)
    .join("\n\n")
    .slice(0, PROVIDER_SEND_TURN_MAX_INPUT_CHARS);

/** The flow as the lead reads it: a line per step, saying who does it and where it goes next. */
function flowLines(crew: CrewFile, leadRoleId: string) {
  const who = (roleId: string) =>
    roleId === leadRoleId ? "you work" : `${crew.roles[roleId]?.name ?? roleId} works`;
  const route = (target: CrewRoute) =>
    typeof target === "string"
      ? `\`${target}\``
      : `\`${target.to}\` (at most ${target.max} times, then \`${target.else}\`)`;
  return Object.entries(crew.flow.steps).map(([id, step]) => {
    const what =
      step.type === "end"
        ? `the run ends${step.status === "failed" ? " as failed" : ""}`
        : step.type === "parallel"
          ? `runs ${step.branches.map((branch) => `\`${branch}\``).join(" and ")} at the same time`
          : step.type === "fanout"
            ? `${who(step.role)} on one card per item of \`${step.over}\``
            : step.type === "merge"
              ? "merges the finished branches into the shared checkout"
              : step.type === "script"
                ? "runs a script"
                : step.type === "gate"
                  ? `${step.by === "lead" ? "you decide" : "the user decides"}: ${step.prompt}`
                  : `${who(step.role)} on it`;
    const routes = [
      ...Object.entries(step.outcomes ?? {}).map(
        ([outcome, target]) => `\`${outcome}\` goes to ${route(target)}`,
      ),
      ...(step.next === undefined ? [] : [`then ${route(step.next)}`]),
    ];
    return `- \`${id}\`: ${what}${routes.length === 0 ? "" : `; ${routes.join(", ")}`}.`;
  });
}

/** The lead's first message: the brief, who is on the crew, how the flow runs and how to decide. */
export function composeCrewLeadKickoff(
  input: Pick<CrewPromptInput, "crew" | "files" | "driver" | "inputs"> & {
    readonly roleId: string;
    /** Each role's resolved model, as `<instance>/<model>`. */
    readonly models: Readonly<Record<string, string>>;
    readonly canEdit: boolean;
    readonly updates: "milestones" | "decisions";
  },
): string {
  const { crew } = input;
  return sectioned([
    [
      "Brief",
      Object.entries(input.inputs)
        .map(([name, value]) => `${name}: ${String(value)}`)
        .join("\n"),
    ],
    ["Your role", roleSection(input, input.roleId)],
    [
      "The crew",
      Object.entries(crew.roles)
        .map(
          ([id, role]) =>
            `- ${role.name} (\`${id}\`)${role.description === undefined ? "" : `: ${role.description}`}${input.models[id] === undefined ? "" : `, on ${input.models[id]}`}${id === input.roleId ? " (you)" : ""}`,
        )
        .join("\n"),
    ],
    [
      "The flow",
      [
        `The crew's flow decides what runs. It starts at \`${crew.flow.start}\` when this turn of yours ends.`,
        flowLines(crew, input.roleId).join("\n"),
      ].join("\n\n"),
    ],
    [
      "Protocol",
      [
        "This is the kickoff. Read the brief, and leave a note for a role with `crew_note` if it should know something before it starts; it reads the note in its first prompt.",
        input.updates === "milestones"
          ? "As the crew works you get updates in this thread: a step finished, a group joined, a merge, a limit reached. Several arrive as one message when they happened while you were busy. They need no answer."
          : "You are only messaged when a decision is yours. Read the whole board at any time with `crew_context`.",
        "When a decision is yours you get a request with a decision id and the outcomes to choose from. Answer it with `crew_decide`, or with the outcome `escalate` to hand it to the user. Without tools, end your reply with a fenced `crew-decision` block holding decisionId, outcome and note.",
        "`crew_context` returns the whole board: every card, open decisions, route counters and budget usage.",
        input.canEdit
          ? "You may edit the shared checkout. Do not push, switch branches or open pull requests."
          : "You read the checkout but do not change it: changes go through the roles.",
      ].join("\n\n"),
    ],
  ]);
}

/** The milestones the lead missed, as one message. */
export function crewLeadUpdatePrompt(milestones: ReadonlyArray<string>): string {
  return sectioned([
    [
      milestones.length === 1 ? "Crew update" : "While you were working",
      [...milestones.map((milestone) => `- ${milestone}`), "", "No answer is needed."].join("\n"),
    ],
  ]);
}

/** Asks the lead to decide, or reminds it once when its turn ended without an answer. */
export function crewDecisionPrompt(input: {
  readonly decisionId: string;
  readonly prompt: string;
  readonly outcomes: ReadonlyArray<string>;
  /** What the decision is about: how the steps before it ended. */
  readonly context: ReadonlyArray<string>;
  readonly reminder: boolean;
}): string {
  return sectioned([
    [
      "Decision needed",
      [
        ...(input.reminder ? ["You ended your turn without deciding. Decide now."] : []),
        input.prompt,
        ...input.context.map((line) => `- ${line}`),
      ].join("\n\n"),
    ],
    [
      "Protocol",
      [
        `Decision id: \`${input.decisionId}\``,
        `Allowed outcomes: ${input.outcomes.join(", ")}, or \`escalate\` to hand the decision to the user.`,
        "Answer with `crew_decide` before you end your turn. If you have no tools, end your reply with this block instead:",
        [
          "```crew-decision",
          `{ "decisionId": "${input.decisionId}", "outcome": "<outcome>", "note": "<why>" }`,
          "```",
        ].join("\n"),
      ].join("\n\n"),
    ],
  ]);
}
