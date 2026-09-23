import type { ServerSettings } from "@t3tools/contracts";
import { BUILT_IN_TEAM_WORKFLOW, resolveTeamWorkflows } from "@t3tools/shared/team";

export const DEFAULT_TEAM_WORKFLOWS = [BUILT_IN_TEAM_WORKFLOW];

export const resolveTeamWorkflowSettings = (settings: ServerSettings): ServerSettings => ({
  ...settings,
  teamWorkflows: [...resolveTeamWorkflows(settings.teamWorkflows)],
});
