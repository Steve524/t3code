import type {
  OrchestrationMessage,
  OrchestrationThread,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";

export type TeamWorkerStatus =
  | "idle"
  | "working"
  | "approval"
  | "input"
  | "completed"
  | "failed"
  | "stopped";

export interface TeamDiffStats {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface TeamReportWorker {
  readonly workerThreadId: ThreadId;
  readonly roleLabel: string;
  readonly title: string;
  readonly state: string;
  readonly branch: string | null;
  readonly diffStats: TeamDiffStats;
  readonly lastAssistantMessage: string | null;
}

export interface TeamStatus {
  readonly state: "idle" | "working" | "attention" | "complete" | "failed";
  readonly total: number;
  readonly working: number;
  readonly attention: number;
  readonly completed: number;
  readonly failed: number;
}

export function selectTeamWorkers(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  orchestrator: ScopedThreadRef,
): EnvironmentThreadShell[] {
  return threads
    .filter(
      (thread) =>
        thread.environmentId === orchestrator.environmentId &&
        thread.team?.role === "worker" &&
        thread.team.orchestratorThreadId === orchestrator.threadId,
    )
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
}

export function teamWorkerStatus(
  thread: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "latestTurn" | "session"
  >,
): TeamWorkerStatus {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running"
  ) {
    return "working";
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "failed";
  if (
    thread.session?.status === "stopped" ||
    thread.session?.status === "interrupted" ||
    thread.latestTurn?.state === "interrupted"
  ) {
    return "stopped";
  }
  if (thread.latestTurn?.state === "completed") return "completed";
  return "idle";
}

export function deriveTeamStatus(workers: ReadonlyArray<EnvironmentThreadShell>): TeamStatus {
  const statuses = workers.map(teamWorkerStatus);
  const working = statuses.filter((status) => status === "working").length;
  const attention = statuses.filter((status) => status === "approval" || status === "input").length;
  const completed = statuses.filter((status) => status === "completed").length;
  const failed = statuses.filter((status) => status === "failed").length;
  return {
    state:
      attention > 0
        ? "attention"
        : working > 0
          ? "working"
          : failed > 0
            ? "failed"
            : workers.length > 0 && completed === workers.length
              ? "complete"
              : "idle",
    total: workers.length,
    working,
    attention,
    completed,
    failed,
  };
}

export function teamWorkerDiffStats(
  thread: Pick<OrchestrationThread, "checkpoints"> | null,
): TeamDiffStats | null {
  const checkpoint = thread?.checkpoints.at(-1);
  if (!checkpoint) return null;
  return checkpoint.files.reduce(
    (total, file) => ({
      files: total.files + 1,
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

export function teamWorkerEffort(
  thread: Pick<EnvironmentThreadShell, "modelSelection">,
): string | null {
  for (const id of ["reasoningEffort", "effort", "reasoning"]) {
    const value = thread.modelSelection.options?.find((option) => option.id === id)?.value;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseDiffStats(value: unknown): TeamDiffStats | null {
  if (!isRecord(value)) return null;
  const { files, additions, deletions } = value;
  return isNonNegativeSafeInteger(files) &&
    isNonNegativeSafeInteger(additions) &&
    isNonNegativeSafeInteger(deletions)
    ? { files, additions, deletions }
    : null;
}

function parseTeamReportWorker(value: unknown): TeamReportWorker | null {
  if (!isRecord(value)) return null;
  const diffStats = parseDiffStats(value.diffStats);
  if (
    typeof value.workerThreadId !== "string" ||
    typeof value.roleLabel !== "string" ||
    typeof value.title !== "string" ||
    typeof value.state !== "string" ||
    !(typeof value.branch === "string" || value.branch === null) ||
    !(typeof value.lastAssistantMessage === "string" || value.lastAssistantMessage === null) ||
    diffStats === null
  ) {
    return null;
  }
  return {
    workerThreadId: value.workerThreadId as ThreadId,
    roleLabel: value.roleLabel,
    title: value.title,
    state: value.state,
    branch: value.branch,
    diffStats,
    lastAssistantMessage: value.lastAssistantMessage,
  };
}

export function selectTeamReport(message: Pick<OrchestrationMessage, "context">) {
  const record = message.context?.records.find((candidate) => candidate.kind === "team-report");
  if (!record || !("payload" in record) || !isRecord(record.payload)) return null;
  const reports = record.payload.reports;
  if (!Array.isArray(reports)) return null;
  const parsed = reports.map(parseTeamReportWorker);
  return parsed.every((report): report is TeamReportWorker => report !== null) ? parsed : null;
}
