import type { CrewDetail } from "@t3tools/contracts/fork/crews/crewRpc";

import type { CrewComposerSelection } from "./crewComposerSelectionStore";

export const CREW_START_DISABLED_REASON = "Crew starts are disabled while Crews v2 is being built.";

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
  return crewInputError(detail, selection.inputs) ?? CREW_START_DISABLED_REASON;
}
