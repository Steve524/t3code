import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  deriveTeamStatus,
  selectTeamWorkers,
  teamWorkerDiffStats,
  teamWorkerEffort,
  teamWorkerStatus,
  type TeamWorkerStatus,
} from "@t3tools/client-runtime/state/team";
import { formatSubagentModelLabel } from "@t3tools/client-runtime/state/subagentRuntime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ExternalLink, MessageSquare, Square, Users } from "lucide-react";
import { useMemo, useState } from "react";

import { useThreadDetail, useThreadShells } from "~/state/entities";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

const STATUS_VISUALS: Record<TeamWorkerStatus, { label: string; dotClass: string }> = {
  idle: { label: "Idle", dotClass: "bg-muted-foreground/50" },
  working: { label: "Working", dotClass: "bg-info" },
  approval: { label: "Approval needed", dotClass: "bg-amber-500" },
  input: { label: "Input needed", dotClass: "bg-indigo-500" },
  completed: { label: "Completed", dotClass: "bg-success" },
  failed: { label: "Failed", dotClass: "bg-destructive" },
  stopped: { label: "Stopped", dotClass: "bg-muted-foreground/60" },
};

export function teamWorkerActionAvailability(status: TeamWorkerStatus) {
  const busy = status === "working" || status === "approval" || status === "input";
  return { canStop: busy, canMessage: !busy };
}

function WorkerDiffStats({ worker }: { worker: EnvironmentThreadShell }) {
  const detail = useThreadDetail(scopeThreadRef(worker.environmentId, worker.id));
  const stats = teamWorkerDiffStats(detail);
  if (!stats) return <span>—</span>;
  return (
    <span className="inline-flex gap-1.5">
      <span>{stats.files} files</span>
      <span className="text-diff-addition-foreground">+{stats.additions}</span>
      <span className="text-diff-deletion-foreground">−{stats.deletions}</span>
    </span>
  );
}

export function TeamWorkerRow(props: {
  worker: EnvironmentThreadShell;
  onOpen: () => void;
  onStop: () => void;
  onMessage: () => void;
}) {
  const { worker } = props;
  const status = teamWorkerStatus(worker);
  const visual = STATUS_VISUALS[status];
  const actions = teamWorkerActionAvailability(status);
  const model =
    formatSubagentModelLabel(worker.modelSelection.model, teamWorkerEffort(worker)) ??
    worker.modelSelection.model;
  const team = worker.team?.role === "worker" ? worker.team : null;

  return (
    <div
      data-team-worker-row
      className="grid h-[6.5rem] grid-cols-[0.5rem_minmax(0,1fr)_auto] grid-rows-[1.5rem_1.25rem_1.25rem_1.25rem] items-center gap-x-2 border-b border-border/50 px-3 py-1.5"
    >
      <span aria-hidden className={cn("size-2 rounded-full", visual.dotClass)} />
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 rounded-sm border border-border/60 px-1.5 font-mono text-[.65rem] text-muted-foreground">
          {team?.roleLabel ?? "Worker"}
        </span>
        <span className="min-w-0 truncate text-sm font-medium">
          {team?.taskTitle ?? worker.title}
        </span>
      </div>
      <div className="row-span-4 flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                onClick={props.onOpen}
                aria-label="Open worker"
              />
            }
          >
            <ExternalLink aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>Open worker</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                onClick={props.onMessage}
                disabled={!actions.canMessage}
                aria-label="Message worker"
              />
            }
          >
            <MessageSquare aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>
            {actions.canMessage ? "Message worker" : "Wait for the worker to become idle"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                onClick={props.onStop}
                disabled={!actions.canStop}
                aria-label="Stop worker"
              />
            }
          >
            <Square aria-hidden className="size-3" />
          </TooltipTrigger>
          <TooltipPopup>{actions.canStop ? "Stop worker" : "Worker is not running"}</TooltipPopup>
        </Tooltip>
      </div>
      <span className="col-start-2 truncate text-xs text-muted-foreground">{model}</span>
      <span className="col-start-2 truncate font-mono text-[.7rem] text-muted-foreground/80">
        {worker.branch ?? "default branch"}
      </span>
      <span className="col-start-2 flex min-w-0 items-center gap-2 font-mono text-[.7rem] text-muted-foreground/80">
        <span>{visual.label}</span>
        {status === "working" ? <span>—</span> : <WorkerDiffStats worker={worker} />}
      </span>
    </div>
  );
}

export function TeamPanel(props: {
  orchestratorRef: ScopedThreadRef;
  onOpenWorker: (worker: EnvironmentThreadShell) => void;
  onStopWorker: (worker: EnvironmentThreadShell) => void | Promise<void>;
  onMessageWorker: (worker: EnvironmentThreadShell, message: string) => Promise<boolean>;
}) {
  const threads = useThreadShells();
  const workers = useMemo(
    () => selectTeamWorkers(threads, props.orchestratorRef),
    [props.orchestratorRef, threads],
  );
  const status = deriveTeamStatus(workers);
  const [messageWorker, setMessageWorker] = useState<EnvironmentThreadShell | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const liveWorkers = workers.filter(
    (worker) => teamWorkerActionAvailability(teamWorkerStatus(worker)).canStop,
  );

  const submitMessage = async () => {
    const text = message.trim();
    if (!messageWorker || !text || sending) return;
    setSending(true);
    const sent = await props.onMessageWorker(messageWorker, text);
    setSending(false);
    if (!sent) return;
    setMessage("");
    setMessageWorker(null);
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <Users aria-hidden className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Team</span>
          <span className="text-xs text-muted-foreground">
            {status.completed}/{status.total} completed
          </span>
          {liveWorkers.length > 0 ? (
            <Button
              size="xs"
              variant="ghost-muted"
              className="ml-auto"
              onClick={() => liveWorkers.forEach((worker) => void props.onStopWorker(worker))}
            >
              Stop all workers
            </Button>
          ) : null}
        </header>
        <ScrollArea className="min-h-0 flex-1">
          {workers.length === 0 ? (
            <div className="flex h-40 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              Workers appear here after the orchestrator delegates work.
            </div>
          ) : (
            workers.map((worker) => (
              <TeamWorkerRow
                key={worker.id}
                worker={worker}
                onOpen={() => props.onOpenWorker(worker)}
                onStop={() => void props.onStopWorker(worker)}
                onMessage={() => setMessageWorker(worker)}
              />
            ))
          )}
        </ScrollArea>
      </div>
      <Dialog
        open={messageWorker !== null}
        onOpenChange={(open) => {
          if (!open && !sending) {
            setMessageWorker(null);
            setMessage("");
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              Message{" "}
              {messageWorker?.team?.role === "worker" ? messageWorker.team.roleLabel : "worker"}
            </DialogTitle>
            <DialogDescription>Start a new turn in this worker thread.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Textarea
              autoFocus
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Describe the revision or follow-up."
              rows={5}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={sending} onClick={() => setMessageWorker(null)}>
              Cancel
            </Button>
            <Button
              disabled={sending || message.trim().length === 0}
              onClick={() => void submitMessage()}
            >
              {sending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
