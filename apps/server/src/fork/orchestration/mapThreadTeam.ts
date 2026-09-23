import type { OrchestrationThread, ThreadTeamInfo } from "@t3tools/contracts";

export function mapThreadTeam(team: ThreadTeamInfo | null): Pick<OrchestrationThread, "team"> {
  return team == null ? {} : { team };
}
