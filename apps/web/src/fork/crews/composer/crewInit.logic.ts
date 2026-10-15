import type { ProviderDriverKind } from "@t3tools/contracts";
import type { CrewSummary } from "@t3tools/contracts/fork/crews/crewFile";

/** The composer command that runs the bundled `crew-init` skill. */
export const CREW_INIT_COMMAND = "crew-init";

export const CREW_INIT_UNREACHABLE = "This provider can't reach T3 tools";

const SKILL_INSTRUCTION = 'Run the T3 skill "crew-init"';

// Drivers whose sessions receive the `t3-code` MCP endpoint (crews spec 2 §10).
// shortcut: decided per driver, not per instance; OpenCode 2 sessions and Muse hosts without
// session MCP miss the endpoint. Read a provider capability once the server reports one.
const T3_TOOL_DRIVERS = new Set([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "acpRegistry",
  "opencode",
  "pi",
  "antigravity",
  "muse",
]);

export interface CrewInitContext {
  readonly driver: ProviderDriverKind;
  /** False for Scratch ("No project") and while no project is chosen. */
  readonly hasProject: boolean;
  /** A crew's home or card thread, or a draft with a crew selected. */
  readonly crewThread: boolean;
}

/** Hidden, offered, or offered with the reason it cannot run. */
export function crewInitAvailability(context: CrewInitContext) {
  if (!context.hasProject || context.crewThread) return { visible: false, disabledReason: null };
  return {
    visible: true,
    disabledReason: T3_TOOL_DRIVERS.has(context.driver) ? null : CREW_INIT_UNREACHABLE,
  };
}

/**
 * Slash menu entries: the bare command, then one per installed crew so its id completes. Each
 * inserts its name after the slash. An entry that cannot run carries the reason as its text.
 */
export function crewInitSlashCommands(
  context: CrewInitContext,
  crews: ReadonlyArray<Pick<CrewSummary, "id" | "name" | "status">>,
) {
  const { visible, disabledReason } = crewInitAvailability(context);
  if (!visible) return [];
  const command = (name: string, description: string) => ({
    name,
    description: disabledReason ?? description,
  });
  return [
    command(CREW_INIT_COMMAND, "Set up this repo's .t3 toolbox for crews"),
    ...(disabledReason === null
      ? crews.map((crew) =>
          command(
            `${CREW_INIT_COMMAND} ${crew.id}`,
            `Set up ${crew.name}${crew.status === "ok" ? "" : ` (${crew.status} here)`}`,
          ),
        )
      : []),
  ];
}

/** The crew ids and any further lines of a message that starts with `/crew-init`, or null. */
export function parseCrewInitCommand(text: string) {
  const [first = "", ...rest] = text.trimStart().split("\n");
  const note = rest.join("\n").trim();
  const match = /^\/crew-init(?:\s+(.*))?$/u.exec(first.trimEnd());
  // Already expanded: a send that stopped early keeps the expanded text.
  if (!match || note.includes(SKILL_INSTRUCTION)) return null;
  return { crewIds: (match[1] ?? "").split(/\s+/u).filter(Boolean), note };
}

/** The short message sent instead: the skill's instructions arrive through `t3_skill_get`. */
export function expandCrewInitCommand(command: { crewIds: readonly string[]; note: string }) {
  const typed = [`/${CREW_INIT_COMMAND}`, ...command.crewIds].join(" ");
  return [
    typed,
    "",
    `${SKILL_INSTRUCTION}. Load its instructions with the t3_skill_get tool`,
    `(name: "crew-init") and follow them. Arguments: ${command.crewIds.join(" ") || "none"}`,
    ...(command.note ? ["", command.note] : []),
  ].join("\n");
}

/** Why a typed `/crew-init` cannot be sent here, or null. */
export function crewInitBlockReason(context: Omit<CrewInitContext, "crewThread">) {
  if (!context.hasProject) return "Open a thread in a project to run /crew-init.";
  return T3_TOOL_DRIVERS.has(context.driver) ? null : `${CREW_INIT_UNREACHABLE}.`;
}

/** What the "Set up with /crew-init" actions put in a new draft. */
export const crewInitDraftPrompt = (crewId: string | null) =>
  crewId ? `/${CREW_INIT_COMMAND} ${crewId}` : `/${CREW_INIT_COMMAND}`;
