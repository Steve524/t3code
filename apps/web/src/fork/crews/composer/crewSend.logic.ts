import type { CrewDetail } from "@t3tools/contracts/fork/crews/crewRpc";
import type { CrewRunStartInput } from "@t3tools/contracts/fork/crews/crewRun";

import type { CrewComposerSelection, CrewComposerTarget } from "./crewComposerSelectionStore";

export function crewInputError(detail: CrewDetail, inputs: CrewComposerSelection["inputs"]) {
  for (const [name, field] of Object.entries(detail.definition?.inputs ?? {})) {
    if (name === "brief") continue;
    const value = inputs[name] ?? field.default;
    if (value === undefined || (typeof value === "string" && !value.trim())) {
      if (field.required) return `Fill in ${name} before starting this crew.`;
      continue;
    }
    if (field.type === "boolean" ? typeof value !== "boolean" : typeof value !== "string")
      return `Choose a valid value for ${name}.`;
    if (field.type === "enum" && !field.values.includes(String(value)))
      return `Choose a valid value for ${name}.`;
  }
  return null;
}

export function crewSelectionError(selection: CrewComposerSelection, detail: CrewDetail | null) {
  if (selection.crewId === null) return null;
  if (!detail || detail.summary.id !== selection.crewId) return "Waiting for this crew's details.";
  if (detail.summary.status === "invalid" || !detail.definition)
    return (
      detail.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message ??
      "This crew has errors in this project. Open Crew settings."
    );
  return crewInputError(detail, selection.inputs);
}

export function mapCrewSendInput(options: {
  target: CrewComposerTarget;
  selection: CrewComposerSelection;
  detail: CrewDetail;
  prompt: string;
  attachments: CrewRunStartInput["attachments"];
  envMode: "local" | "worktree";
  baseRef: string | null;
  startFromOrigin: boolean;
  runtimeMode: CrewRunStartInput["runtimeMode"];
  modelSelection: NonNullable<CrewRunStartInput["modelSelection"]>;
}): CrewRunStartInput {
  const error = crewSelectionError(options.selection, options.detail);
  if (error) throw new Error(error);
  if (!options.selection.crewId) throw new Error("Choose a crew before starting a run.");
  if (options.envMode === "worktree" && !options.baseRef?.trim())
    throw new Error("Select a base branch before sending in New worktree mode.");
  const inputs = Object.fromEntries(
    Object.entries(options.detail.definition?.inputs ?? {}).flatMap(([name, field]) => {
      const value = options.selection.inputs[name] ?? field.default;
      return name === "brief" || value === undefined ? [] : [[name, value]];
    }),
  );
  return {
    projectId: options.target.projectId,
    crewId: options.selection.crewId,
    inputs: { ...inputs, brief: options.prompt },
    attachments: options.attachments,
    roleModelOverrides: options.selection.roleModelOverrides,
    modelSelection: options.modelSelection,
    workspace:
      options.envMode === "worktree"
        ? {
            mode: "new-worktree",
            baseRef:
              options.startFromOrigin && !options.baseRef!.startsWith("origin/")
                ? `origin/${options.baseRef}`
                : options.baseRef!,
          }
        : { mode: "current-checkout" },
    runtimeMode: options.runtimeMode,
    clientRequestId: `crew:${options.target.draftId}`,
  };
}
