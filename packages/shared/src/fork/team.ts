import { TeamRoleId, type TeamRoleKind, type TeamWorkflow } from "@t3tools/contracts";

export const DEFAULT_PLANS_DIR = "docs/plans";
export const DEFAULT_RESEARCH_DIR = "docs/research";

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
  plansDir: DEFAULT_PLANS_DIR,
  researchDir: DEFAULT_RESEARCH_DIR,
  roles: [
    {
      id: TeamRoleId.make("researcher"),
      label: "Researcher",
      kind: "researcher",
      enabled: true,
      summary: "Web and deep research briefs",
      modelSelection: null,
      // Read-only roles ignore their own runtime mode; see teamReadOnlyLaunch.
      runtimeMode: null,
      instructions: "",
    },
    {
      id: TeamRoleId.make("plan-reviewer"),
      label: "Plan reviewer",
      kind: "plan-reviewer",
      enabled: true,
      summary: "Adversarial plan review",
      modelSelection: null,
      runtimeMode: null,
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

/** Researchers and plan reviewers never write, so they never commit or get a branch to integrate. */
export const isReadOnlyTeamRoleKind = (kind: TeamRoleKind) =>
  kind === "researcher" || kind === "plan-reviewer";

/**
 * How a read-only worker runs on a provider driver. Non-null: in the planner's checkout with these
 * modes, where every write becomes an approval request that the server declines. Null: the provider
 * can't stop writes that way, so the worker gets an isolated worktree. Evidence per provider:
 * docs/fork/research-plan-team-testing.md (Phase 2 matrix).
 */
export const teamReadOnlyLaunch = (driverKind: string) =>
  driverKind === "claudeAgent"
    ? ({ runtimeMode: "approval-required", interactionMode: "default" } as const)
    : null;

/** Saved workflows replace the defaults, but a built-in missing from the list is still offered. */
export function resolveTeamWorkflows(
  workflows: ReadonlyArray<TeamWorkflow>,
): ReadonlyArray<TeamWorkflow> {
  const missing = BUILT_IN_TEAM_WORKFLOWS.filter(
    (builtIn) => !workflows.some(({ id }) => id === builtIn.id),
  );
  return missing.length === 0 ? workflows : [...workflows, ...missing];
}
