import { TeamRoleId, type TeamWorkflow } from "@t3tools/contracts";

export const BUILT_IN_TEAM_WORKFLOW: TeamWorkflow = {
  id: "full-stack-team",
  name: "Full-stack team",
  builtIn: true,
  type: "build",
  roles: [
    {
      id: TeamRoleId.make("frontend"),
      label: "Frontend",
      kind: "implementer",
      enabled: true,
      summary: "UI, components",
      modelSelection: null,
      runtimeMode: null,
      instructions: "",
    },
    {
      id: TeamRoleId.make("backend"),
      label: "Backend",
      kind: "implementer",
      enabled: true,
      summary: "APIs, logic",
      modelSelection: null,
      runtimeMode: null,
      instructions: "",
    },
    {
      id: TeamRoleId.make("database"),
      label: "Database",
      kind: "implementer",
      enabled: true,
      summary: "Schema, migrations",
      modelSelection: null,
      runtimeMode: null,
      instructions: "",
    },
    {
      id: TeamRoleId.make("devops"),
      label: "DevOps",
      kind: "implementer",
      enabled: true,
      summary: "CI/CD, infra",
      modelSelection: null,
      runtimeMode: null,
      instructions: "",
    },
    {
      id: TeamRoleId.make("qa"),
      label: "QA and review",
      kind: "reviewer",
      enabled: true,
      summary: "Tests, code review",
      modelSelection: null,
      runtimeMode: null,
      instructions: "",
    },
  ],
  maxParallelWorkers: 4,
  maxReviewRounds: 2,
  maxAutoReports: 30,
  orchestratorInstructions: "",
};

export const BUILT_IN_RESEARCH_PLAN_WORKFLOW: TeamWorkflow = {
  id: "research-plan-team",
  name: "Research & plan team",
  builtIn: true,
  type: "plan",
  roles: [
    {
      id: TeamRoleId.make("researcher"),
      label: "Researcher",
      kind: "researcher",
      enabled: true,
      summary: "Web and deep research briefs",
      modelSelection: null,
      // ponytail: approval-required is the interim read-only guard; Phase 2 maps each provider to an enforced mode.
      runtimeMode: "approval-required",
      instructions: "",
    },
    {
      id: TeamRoleId.make("plan-reviewer"),
      label: "Plan reviewer",
      kind: "plan-reviewer",
      enabled: true,
      summary: "Adversarial plan review",
      modelSelection: null,
      runtimeMode: "approval-required",
      instructions: "",
    },
  ],
  maxParallelWorkers: 2,
  maxReviewRounds: 5,
  maxAutoReports: 30,
  orchestratorInstructions: "",
};

export const BUILT_IN_TEAM_WORKFLOWS: ReadonlyArray<TeamWorkflow> = [
  BUILT_IN_TEAM_WORKFLOW,
  BUILT_IN_RESEARCH_PLAN_WORKFLOW,
];

/** Saved workflows replace the defaults, but a built-in missing from the list is still offered. */
export function resolveTeamWorkflows(
  workflows: ReadonlyArray<TeamWorkflow>,
): ReadonlyArray<TeamWorkflow> {
  const missing = BUILT_IN_TEAM_WORKFLOWS.filter(
    (builtIn) => !workflows.some(({ id }) => id === builtIn.id),
  );
  return missing.length === 0 ? workflows : [...workflows, ...missing];
}
