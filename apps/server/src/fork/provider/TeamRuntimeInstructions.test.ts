import { BUILT_IN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { describe, expect, it } from "vite-plus/test";

import { buildRuntimeInstructions } from "../../provider/RuntimeInstructions.ts";

describe("Team Workflow runtime instructions", () => {
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
    expect(instructions).toContain("Route REVISE findings to the owning workers");
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

  it("requires the QA worker to end with one exact verdict", () => {
    const qa = BUILT_IN_TEAM_WORKFLOW.roles.find((role) => role.id === "qa")!;
    const instructions = buildRuntimeInstructions({
      harness: "Codex",
      team: {
        role: "worker",
        roleId: qa.id,
        roleLabel: qa.label,
        roleInstructions: "",
        orchestratorTitle: "Ship saved searches",
        branch: "team/123/integration",
      },
    });

    expect(instructions).toContain(
      "End with exactly one line: `VERDICT: APPROVED`, `VERDICT: REVISE`, or `VERDICT: BLOCKED`.",
    );
  });

  it("leaves plain-thread instructions free of team prompts", () => {
    expect(buildRuntimeInstructions({ harness: "OpenCode" })).not.toContain("<team_");
  });
});
