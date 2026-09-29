import type { ThreadTeamInfo } from "@t3tools/contracts";

export function TeamWorkerRoleBadge({ team }: { team: ThreadTeamInfo | null | undefined }) {
  const label =
    team?.role === "worker"
      ? team.roleLabel
      : team?.role === "orchestrator" &&
          team.workflow.protocolId === "t3-plan-loop" &&
          team.workflow.skillVersion === "1.1.0"
        ? "Planner"
        : null;
  if (label === null) return null;
  return (
    <span className="max-w-24 shrink-0 truncate rounded-sm border border-sidebar-border/70 px-1 font-mono text-[.625rem] text-sidebar-muted-foreground">
      {label}
    </span>
  );
}
