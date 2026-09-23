import type { TeamReportWorker } from "@t3tools/client-runtime/state/team";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "~/lib/utils";

function teamReportDotClass(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized.includes("error") || normalized.includes("failed")) return "bg-destructive";
  if (normalized.includes("approval") || normalized.includes("input")) return "bg-amber-500";
  if (normalized.includes("running") || normalized.includes("starting")) return "bg-info";
  if (normalized.includes("completed")) return "bg-success";
  return "bg-muted-foreground/60";
}

export function TeamReportTimelineRow({ reports }: { reports: ReadonlyArray<TeamReportWorker> }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-1" data-team-report-card>
      <details className="group rounded-lg border border-border/60 bg-card/40">
        <summary className="flex h-10 cursor-pointer list-none items-center gap-2 px-3 text-sm marker:hidden">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
          />
          <span className="font-medium">Team update</span>
          <span className="text-xs text-muted-foreground">
            {reports.length} {reports.length === 1 ? "worker" : "workers"}
          </span>
        </summary>
        <div className="border-t border-border/50 px-3 py-1">
          {reports.map((report) => (
            <div
              key={report.workerThreadId}
              className="grid min-h-16 grid-cols-[0.5rem_minmax(0,1fr)] items-center gap-x-2 border-b border-border/40 py-2 last:border-b-0"
            >
              <span
                aria-hidden
                className={cn("size-2 rounded-full", teamReportDotClass(report.state))}
              />
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 rounded-sm border border-border/60 px-1 font-mono text-[.65rem] text-muted-foreground">
                    {report.roleLabel}
                  </span>
                  <span className="truncate text-sm font-medium">{report.title}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-2 font-mono text-[.7rem] text-muted-foreground">
                  <span>{report.state}</span>
                  <span>{report.branch ?? "default branch"}</span>
                  <span>{report.diffStats.files} files</span>
                  <span className="text-diff-addition-foreground">
                    +{report.diffStats.additions}
                  </span>
                  <span className="text-diff-deletion-foreground">
                    −{report.diffStats.deletions}
                  </span>
                </div>
                {report.lastAssistantMessage ? (
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                    {report.lastAssistantMessage}
                  </p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
