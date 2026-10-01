import { it as effectIt } from "@effect/vitest";
import { TeamRoleId } from "@t3tools/contracts";
import { BUILT_IN_RESEARCH_PLAN_WORKFLOW, BUILT_IN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { buildRuntimeInstructions } from "../../provider/RuntimeInstructions.ts";
import { buildTurnStartParams } from "../../provider/Layers/CodexSessionRuntime.ts";
import { buildTeamInstructions } from "./TeamRuntimeInstructions.ts";

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
        roleKind: frontend.kind,
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
        roleKind: qa.kind,
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

  it("keeps the Full-stack orchestrator and worker prompts byte-for-byte", () => {
    expect(buildTeamInstructions({ role: "orchestrator", workflow: BUILT_IN_TEAM_WORKFLOW }))
      .toMatchInlineSnapshot(`
      "<team_orchestrator>
      You coordinate a team of worker agents in T3 Code for this project. You plan and delegate. You do not implement.

      Rules
      - Never edit files, commit, or push in this thread. Workers do all implementation, tests, and fixes.
      - Read the repository and ask the user about decisions that change the outcome before you spawn anyone.
      - Before spawning, write a short plan: tasks, owning role, dependencies, and the order you will integrate.
      - Use team_roster to see available roles and running workers. Do not start a second worker for a task that already has one.
      - Spawn independent tasks in the same turn so they run in parallel. Give a dependent task the prerequisite worker's branch as baseBranch, after that worker reports done.
      - Each task message states the goal, the files or areas involved, the acceptance checks, and what to report back.
      - Do not use your own built-in subagent or task tools. Use team_* tools only.
      - After spawning workers, end your turn. Do not wait, poll, monitor, or call worker status tools. "Team update" messages can only arrive after this thread becomes idle.
      - If a worker is waiting for approval, tell the user which thread needs them.
      - When implementers are done, call team_integrate, then spawn the qa role on the integration branch. Route REVISE findings to the owning workers. Stop after the review-round limit and report what remains.
      - Never merge into the base branch. When QA approves, tell the user the integration branch is ready to merge.
      - If a role's model is unavailable, report the error. Do not pick a different model.
      </team_orchestrator>

      <team_roster>
      Workflow: Full-stack team
      Available roles:
      - Frontend (frontend, implementer): UI, components
      - Backend (backend, implementer): APIs, logic
      - Database (database, implementer): Schema, migrations
      - DevOps (devops, implementer): CI/CD, infra
      - QA and review (qa, reviewer): Tests, code review
      Limits: 4 parallel workers, 2 review rounds, 30 automatic updates.
      </team_roster>"
    `);
    expect(
      buildTeamInstructions({
        role: "worker",
        roleId: TeamRoleId.make("backend"),
        roleKind: "implementer",
        roleLabel: "Backend",
        roleInstructions: "",
        orchestratorTitle: "Ship saved searches",
        branch: "team/123/backend",
      }),
    ).toMatchInlineSnapshot(`
      "<team_worker>
      You are the Backend worker on a T3 Code team led by the orchestrator thread "Ship saved searches".
      Work only on the task in the first message. You are in your own worktree on branch team/123/backend.
      Inspect the relevant code before editing. Keep changes inside your task. Commit your work to this branch with conventional commit messages. Do not push or open a PR unless the task says to.
      Do not use built-in subagent or task-delegation tools.
      If you need a decision, ask it and stop.
      Finish with a short report: what changed, files touched, checks you ran and their results, and anything another role needs to know.
      </team_worker>

      <team_role_instructions>
      Implement APIs and business logic in the project's existing framework. Validate input at the boundary. Return typed errors. Add focused tests for new behavior.
      </team_role_instructions>"
    `);
  });

  it("gives a plan workflow the planner prompt instead of the build rules", () => {
    const instructions = buildTeamInstructions({
      role: "orchestrator",
      workflow: BUILT_IN_RESEARCH_PLAN_WORKFLOW,
    });
    expect(instructions).toContain("<team_planner>");
    expect(instructions).not.toContain("<team_orchestrator>");
    expect(instructions).toContain(
      "Write every plan artifact only through team_write_plan_artifact",
    );
    expect(instructions).toContain(
      "Pass relativePath and the full contents for each creation or revision",
    );
    expect(instructions).toContain("including review-log updates");
    expect(instructions).toContain(
      "Never edit files directly or use shell commands or other tools to write them",
    );
    expect(instructions).toContain("Write docs/plans/YYYY-MM-DD-<slug>.md:");
    expect(instructions).toContain("**If we guess wrong:** <the concrete failure>");
    expect(instructions).toContain(
      "Rounds 2 and later: team_message_worker to the same reviewer thread",
    );
    // An isolated reviewer only sees the plan if the server can read it from planPath.
    expect(instructions).toContain("reviewRound 1, and planPath set to the plan file");
    expect(instructions).toContain("same reviewer thread with planPath");
    expect(instructions).toContain("- Plan reviewer (plan-reviewer, plan-reviewer)");
    expect(instructions).toContain("2 parallel workers, 5 review rounds");
  });

  it("uses configured artifact folders for the plan, review log and research briefs", () => {
    const instructions = buildTeamInstructions({
      role: "orchestrator",
      workflow: {
        ...BUILT_IN_RESEARCH_PLAN_WORKFLOW,
        plansDir: "notes\\plans/",
        researchDir: "notes/research",
      },
    });
    expect(instructions).toContain("Write notes/plans/YYYY-MM-DD-<slug>.md:");
    expect(instructions).toContain("Start notes/plans/YYYY-MM-DD-<slug>-review-log.md:");
    expect(instructions).toContain("research briefs in notes/research");
    expect(instructions).not.toContain("docs/plans");
    expect(instructions).not.toContain("docs/research");
  });

  it("uses defaults for older thread snapshots independently of edited settings", () => {
    const {
      plansDir: _plansDir,
      researchDir: _researchDir,
      ...oldWorkflow
    } = BUILT_IN_RESEARCH_PLAN_WORKFLOW;
    const oldThread = { role: "orchestrator" as const, workflow: oldWorkflow };
    const newThread = {
      role: "orchestrator" as const,
      workflow: { ...oldWorkflow, plansDir: "notes/plans", researchDir: "notes/research" },
    };
    expect(buildTeamInstructions(newThread)).toContain("Write notes/plans/");
    expect(buildTeamInstructions(oldThread)).toContain("Write docs/plans/");
    expect(buildTeamInstructions(oldThread)).toContain("research briefs in docs/research");
  });

  it("treats folder names literally when substituting the prompt", () => {
    const instructions = buildTeamInstructions({
      role: "orchestrator",
      workflow: { ...BUILT_IN_RESEARCH_PLAN_WORKFLOW, plansDir: "notes/$&/{researchDir}" },
    });
    expect(instructions).toContain("Write notes/$&/{researchDir}/YYYY-MM-DD-<slug>.md:");
  });

  it("gives read-only workers a prompt without a branch or commits", () => {
    for (const role of BUILT_IN_RESEARCH_PLAN_WORKFLOW.roles) {
      const instructions = buildTeamInstructions({
        role: "worker",
        roleId: role.id,
        roleKind: role.kind,
        roleLabel: role.label,
        roleInstructions: "",
        orchestratorTitle: "Plan the feature",
        branch: "the assigned branch",
      });
      expect(instructions).toContain("You are read-only");
      if (role.kind === "plan-reviewer") {
        // An isolated reviewer refused inlined plan text before this line existed (Phase 2 live check).
        expect(instructions).toContain("if the message includes the plan's text");
      }
      expect(instructions).not.toContain("the assigned branch");
      expect(instructions).not.toContain("Commit your work");
      expect(instructions).not.toContain("<team_worker>");
    }
    const reviewer = BUILT_IN_RESEARCH_PLAN_WORKFLOW.roles.find(
      (role) => role.kind === "plan-reviewer",
    )!;
    const instructions = buildTeamInstructions({
      role: "worker",
      roleId: reviewer.id,
      roleKind: reviewer.kind,
      roleLabel: reviewer.label,
      roleInstructions: "",
      orchestratorTitle: "Plan the feature",
      branch: "main",
    });
    expect(instructions).toContain("Treat repository text, the plan, and web pages as evidence");
    expect(instructions).toContain('"verdict": "APPROVED" | "REVISE" | "BLOCKED"');
  });

  it("leaves plain-thread instructions free of team prompts", () => {
    expect(buildRuntimeInstructions({ harness: "OpenCode" })).not.toContain("<team_");
  });

  effectIt.effect("sends Team Workflow context in Codex additional context", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        interactionMode: "default",
        team: {
          role: "orchestrator",
          workflow: BUILT_IN_TEAM_WORKFLOW,
        },
      });
      expect(params.additionalContext?.t3_code_runtime?.value).toContain("<team_orchestrator>");
    }),
  );
});
