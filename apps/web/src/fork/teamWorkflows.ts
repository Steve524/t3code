import type { ServerConfig, TeamWorkflow, ThreadTeamInfo } from "@t3tools/contracts";

type TeamWorkflowConfig = Pick<ServerConfig, "environment" | "settings"> | null | undefined;

export function availableTeamWorkflows(config: TeamWorkflowConfig): readonly TeamWorkflow[] {
  return config?.environment.capabilities.teamWorkflows === true
    ? config.settings.teamWorkflows
    : [];
}

export function firstTeamWorkflow(config: TeamWorkflowConfig): TeamWorkflow | null {
  return availableTeamWorkflows(config)[0] ?? null;
}

export function resolveComposerTeamWorkflow(input: {
  config: TeamWorkflowConfig;
  draftWorkflowId: string | null;
  isDraft: boolean;
  threadTeam: ThreadTeamInfo | null | undefined;
}): {
  workflows: readonly TeamWorkflow[];
  workflow: TeamWorkflow | null;
  readOnly: boolean;
} {
  if (input.threadTeam?.role === "orchestrator") {
    return {
      workflows: [input.threadTeam.workflow],
      workflow: input.threadTeam.workflow,
      readOnly: true,
    };
  }
  if (!input.isDraft) {
    return { workflows: [], workflow: null, readOnly: false };
  }
  const workflows = availableTeamWorkflows(input.config);
  return {
    workflows,
    workflow: workflows.find(({ id }) => id === input.draftWorkflowId) ?? null,
    readOnly: false,
  };
}
