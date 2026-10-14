import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewRunView } from "@t3tools/contracts/fork/crews/crewRun";
import { useRightPanelStore } from "../../../rightPanelStore";

/** Open on the home thread even when the action came from a role thread. */
export function openCrewBoard(
  environmentId: EnvironmentId,
  run: Pick<CrewRunView, "runId" | "homeThreadId">,
) {
  if (!run.homeThreadId)
    return {
      to: "/crews/$environmentId/$runId" as const,
      params: { environmentId, runId: run.runId },
    };
  const ref = scopeThreadRef(environmentId, run.homeThreadId);
  const panels = useRightPanelStore.getState();
  panels.open(ref, "crew-board");
  panels.setMaximized(ref, false);
  return {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId, threadId: run.homeThreadId },
  };
}
