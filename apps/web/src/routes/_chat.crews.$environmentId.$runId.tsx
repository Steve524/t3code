// FORK: full-page crew board.
import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { CrewBoard } from "../fork/crews/board/CrewBoard";
export const Route = createFileRoute("/_chat/crews/$environmentId/$runId")({
  component: BoardRoute,
});
function BoardRoute() {
  const { environmentId, runId } = Route.useParams();
  return (
    <CrewBoard
      key={`${environmentId}:${runId}`}
      environmentId={EnvironmentId.make(environmentId)}
      runId={runId}
    />
  );
}
