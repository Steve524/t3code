import type { CrewDetail } from "@t3tools/contracts/fork/crews/crewRpc";
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_CREW_SELECTION } from "./crewComposerSelectionStore";
import { crewInputError, crewSelectionError, CREW_START_DISABLED_REASON } from "./crewSend.logic";

const detail: CrewDetail = {
  summary: {
    id: "trio",
    name: "Trio",
    path: "/crews/trio",
    roles: [],
    home: null,
    status: "ok",
    diagnosticCounts: { errors: 0, warnings: 0, info: 0 },
  },
  definition: {
    version: 1,
    id: "trio",
    name: "Trio",
    roles: { worker: { name: "Worker" } },
    inputs: {
      brief: { type: "text", required: true },
      language: { type: "enum", values: ["TS", "JS"], default: "TS" },
      review: { type: "boolean", required: true },
      ticket: { type: "string", required: true },
    },
    flow: { start: "done", steps: { done: { type: "end" } } },
  },
  roles: [],
  diagnostics: [],
};
const selection = {
  ...EMPTY_CREW_SELECTION,
  crewId: "trio",
  inputs: { review: false, ticket: "T3-1", brief: "must not replace prompt" },
};

describe("crew send validation", () => {
  it("blocks even valid selected crews until Crews v2 starts are implemented", () => {
    expect(crewSelectionError(selection, detail)).toBe(CREW_START_DISABLED_REASON);
  });

  it("validates required values without rejecting boolean false or a default", () => {
    expect(crewInputError(detail, selection.inputs)).toBeNull();
    expect(crewInputError(detail, { ticket: "T3-1" })).toContain("review");
    expect(crewInputError(detail, { review: false, ticket: "  " })).toContain("ticket");
    expect(crewInputError(detail, { ...selection.inputs, language: "Rust" })).toContain("language");
    expect(crewInputError(detail, { ...selection.inputs, review: "false" })).toContain("review");
  });

  it("blocks stale or invalid crews, while No crew leaves normal sends alone", () => {
    expect(crewSelectionError(EMPTY_CREW_SELECTION, null)).toBeNull();
    expect(crewSelectionError(selection, null)).toContain("Waiting");
    expect(
      crewSelectionError(selection, {
        ...detail,
        summary: { ...detail.summary, id: "other" },
      }),
    ).toContain("Waiting");
    const invalid = {
      ...detail,
      summary: { ...detail.summary, status: "invalid" as const },
      diagnostics: [
        {
          severity: "error" as const,
          message: "No worker model",
          file: "crew.yaml",
          line: 1,
          column: 1,
          path: [],
        },
      ],
    };
    expect(crewSelectionError(selection, invalid)).toBe("No worker model");
  });
});
