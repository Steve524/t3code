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

export function resolveTeamWorkflows(
  workflows: ReadonlyArray<TeamWorkflow>,
): ReadonlyArray<TeamWorkflow> {
  return workflows.length === 0 ? [BUILT_IN_TEAM_WORKFLOW] : workflows;
}
