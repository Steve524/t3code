import type { ThreadTeamInfo } from "@t3tools/contracts";

export function TeamWorkerRoleBadge({ team }: { team: ThreadTeamInfo | null | undefined }) {
  if (team?.role !== "worker") return null;
  return (
    <span className="max-w-24 shrink-0 truncate rounded-sm border border-sidebar-border/70 px-1 font-mono text-[.625rem] text-sidebar-muted-foreground">
      {team.roleLabel}
    </span>
  );
}
