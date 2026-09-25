import { TeamRoleId, type TeamWorkflow } from "@t3tools/contracts";

export const BUILT_IN_TEAM_WORKFLOW: TeamWorkflow = {
  id: "full-stack-team",
  name: "Full-stack team",
  builtIn: true,
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

export const RESEARCH_PLAN_TEAM_WORKFLOW: TeamWorkflow = {
  id: "research-and-plan",
  name: "Research and plan",
  builtIn: true,
  protocolId: "t3-plan-loop",
  skillVersion: "1.0.0",
  roles: [
    {
      id: TeamRoleId.make("planner"),
      label: "Planner",
      kind: "planner",
      enabled: true,
      summary: "Requirements and plan drafts",
      modelSelection: null,
      runtimeMode: null,
      instructions: "",
    },
    {
      id: TeamRoleId.make("reviewer"),
      label: "Reviewer",
      kind: "reviewer",
      enabled: true,
      summary: "Independent plan review",
      modelSelection: null,
      runtimeMode: null,
      instructions: "",
    },
    {
      id: TeamRoleId.make("researcher"),
      label: "Researcher",
      kind: "researcher",
      enabled: true,
      summary: "Evidence and research brief",
      modelSelection: null,
      runtimeMode: null,
      instructions: "",
    },
  ],
  maxParallelWorkers: 3,
  maxReviewRounds: 5,
  maxAutoReports: 30,
  deepResearchWorkers: 3,
  orchestratorInstructions: "",
};

export const BUILT_IN_TEAM_WORKFLOWS = [
  BUILT_IN_TEAM_WORKFLOW,
  RESEARCH_PLAN_TEAM_WORKFLOW,
] as const;

export function resolveTeamWorkflows(
  workflows: ReadonlyArray<TeamWorkflow>,
): ReadonlyArray<TeamWorkflow> {
  return [
    ...workflows,
    ...BUILT_IN_TEAM_WORKFLOWS.filter((preset) => !workflows.some(({ id }) => id === preset.id)),
  ];
}
