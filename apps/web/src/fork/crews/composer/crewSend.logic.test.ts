import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import type { CrewDetail } from "@t3tools/contracts/fork/crews/crewRpc";
import { describe, expect, it } from "vite-plus/test";

import type { DraftId } from "../../../composerDraftStore";
import { EMPTY_CREW_SELECTION } from "./crewComposerSelectionStore";
import { crewInputError, crewSelectionError, mapCrewSendInput } from "./crewSend.logic";

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
const model = {
  instanceId: ProviderInstanceId.make("codex-b"),
  model: "model",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const options: Parameters<typeof mapCrewSendInput>[0] = {
  target: {
    environmentId: EnvironmentId.make("remote"),
    projectId: ProjectId.make("project"),
    draftId: "draft" as DraftId,
  },
  selection: {
    ...EMPTY_CREW_SELECTION,
    crewId: "trio",
    inputs: { review: false, ticket: "T3-1", brief: "must not replace prompt" },
    roleModelOverrides: { worker: model },
  },
  detail,
  prompt: "add a /health route",
  attachments: [
    { type: "image", id: "uploaded", name: "route.png", mimeType: "image/png", sizeBytes: 42 },
  ],
  envMode: "local",
  baseRef: null,
  startFromOrigin: false,
  runtimeMode: "approval-required",
  modelSelection: model,
};

describe("crew send mapping", () => {
  it("maps the prompt, uploaded attachments, runtime ceiling, fallback account and run-only options", () => {
    const before = structuredClone(options);
    expect(mapCrewSendInput(options)).toEqual({
      projectId: "project",
      crewId: "trio",
      inputs: { brief: "add a /health route", language: "TS", review: false, ticket: "T3-1" },
      attachments: options.attachments,
      roleModelOverrides: { worker: model },
      modelSelection: model,
      workspace: { mode: "current-checkout" },
      runtimeMode: "approval-required",
      clientRequestId: "crew:draft",
    });
    expect(options).toEqual(before);
  });

  it("maps a selected base branch to a new worktree and rejects a missing base", () => {
    expect(
      mapCrewSendInput({ ...options, envMode: "worktree", baseRef: "origin/main" }).workspace,
    ).toEqual({ mode: "new-worktree", baseRef: "origin/main" });
    expect(
      mapCrewSendInput({ ...options, envMode: "worktree", baseRef: "main", startFromOrigin: true })
        .workspace,
    ).toEqual({ mode: "new-worktree", baseRef: "origin/main" });
    expect(
      mapCrewSendInput({
        ...options,
        envMode: "worktree",
        baseRef: "origin/main",
        startFromOrigin: true,
      }).workspace,
    ).toEqual({ mode: "new-worktree", baseRef: "origin/main" });
    expect(
      mapCrewSendInput({ ...options, envMode: "worktree", baseRef: "local-branch" }).workspace,
    ).toEqual({ mode: "new-worktree", baseRef: "local-branch" });
    expect(() => mapCrewSendInput({ ...options, envMode: "worktree" })).toThrow(
      "Select a base branch",
    );
  });

  it("uses a stable request id for retries and a different id for a different draft", () => {
    expect(mapCrewSendInput(options).clientRequestId).toBe(
      mapCrewSendInput({ ...options, prompt: "retry" }).clientRequestId,
    );
    expect(
      mapCrewSendInput({ ...options, target: { ...options.target, draftId: "next" as DraftId } })
        .clientRequestId,
    ).not.toBe(mapCrewSendInput(options).clientRequestId);
  });

  it("validates required values without rejecting boolean false or a default", () => {
    expect(crewInputError(detail, options.selection.inputs)).toBeNull();
    expect(crewInputError(detail, { ticket: "T3-1" })).toContain("review");
    expect(crewInputError(detail, { review: false, ticket: "  " })).toContain("ticket");
    expect(crewInputError(detail, { ...options.selection.inputs, language: "Rust" })).toContain(
      "language",
    );
    expect(crewInputError(detail, { ...options.selection.inputs, review: "false" })).toContain(
      "review",
    );
  });

  it("blocks stale or invalid crews, while No crew leaves normal sends alone", () => {
    expect(crewSelectionError(EMPTY_CREW_SELECTION, null)).toBeNull();
    expect(crewSelectionError(options.selection, null)).toContain("Waiting");
    expect(
      crewSelectionError(options.selection, {
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
    expect(() => mapCrewSendInput({ ...options, detail: invalid })).toThrow("No worker model");
  });
});
