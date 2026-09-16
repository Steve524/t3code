import { describe, expect, it } from "vite-plus/test";
import { BUILT_IN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });

  it("adds orchestrator rules, the enabled roster, and workflow instructions", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Claude Code",
      team: {
        role: "orchestrator",
        workflow: {
          ...BUILT_IN_TEAM_WORKFLOW,
          orchestratorInstructions: "Keep updates concise.",
        },
      },
    });

    expect(instructions).toContain("<team_orchestrator>");
    expect(instructions).toContain("- Frontend (frontend, implementer): UI, components");
    expect(instructions).toContain("4 parallel workers, 2 review rounds, 30 automatic updates");
    expect(instructions).toContain(
      'Do not wait, poll, monitor, or call worker status tools. "Team update" messages can only arrive after this thread becomes idle.',
    );
    expect(instructions).toContain("<team_orchestrator_instructions>\nKeep updates concise.");
  });

  it("adds worker context and falls back to the built-in role instructions", () => {
    const frontend = BUILT_IN_TEAM_WORKFLOW.roles[0]!;
    const instructions = buildRuntimeInstructions({
      harness: "Codex",
      team: {
        role: "worker",
        roleId: frontend.id,
        roleLabel: frontend.label,
        roleInstructions: "",
        orchestratorTitle: "Ship saved searches",
        branch: "team/123/frontend",
      },
    });

    expect(instructions).toContain(
      'You are the Frontend worker on a T3 Code team led by the orchestrator thread "Ship saved searches".',
    );
    expect(instructions).toContain("own worktree on branch team/123/frontend");
    expect(instructions).toContain("Build UI in the project's existing component library");
  });

  it("leaves plain-thread instructions free of team prompts", () => {
    expect(buildRuntimeInstructions({ harness: "OpenCode" })).not.toContain("<team_");
  });
});
