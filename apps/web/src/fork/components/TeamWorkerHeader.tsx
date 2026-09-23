import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadTeamInfo } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../../components/WorkspaceBreadcrumb";
import { buildThreadRouteParams } from "../../threadRoutes";

type WorkerTeam = Extract<ThreadTeamInfo, { role: "worker" }>;

export function TeamWorkerBackLink({
  environmentId,
  team,
}: {
  environmentId: EnvironmentId;
  team: WorkerTeam;
}) {
  const navigate = useNavigate();
  return (
    <>
      <WorkspaceBreadcrumbItem className="shrink-0">
        <button
          type="button"
          onClick={() => {
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(environmentId, team.orchestratorThreadId),
              ),
            });
          }}
          className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeftIcon aria-hidden className="size-3" />
          Back to orchestrator
        </button>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator />
    </>
  );
}

export function TeamWorkerRoleBadge({ team }: { team: WorkerTeam }) {
  return (
    <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1.5 font-mono text-[.65rem] text-muted-foreground">
      {team.roleLabel}
    </span>
  );
}
