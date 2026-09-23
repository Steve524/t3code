import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "../../state/models.ts";
import {
  deriveTeamStatus,
  selectTeamReport,
  selectTeamWorkers,
  teamWorkerDiffStats,
  teamWorkerStatus,
} from "./team.ts";

const orchestratorId = ThreadId.make("orchestrator");
const environmentId = EnvironmentId.make("environment");

function worker(
  id: string,
  createdAt: string,
  patch: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make("project"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: `team/${id}`,
    worktreePath: `/tmp/${id}`,
    team: {
      role: "worker",
      orchestratorThreadId: orchestratorId,
      roleId: "frontend" as never,
      roleLabel: "Frontend",
      taskTitle: id,
    },
    pullRequests: [],
    latestTurn: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...patch,
  };
}

describe("team selectors", () => {
  it("keeps spawn order while worker state changes", () => {
    const first = worker("worker-a", "2026-09-17T00:00:00.000Z");
    const second = worker("worker-b", "2026-09-17T00:00:01.000Z");
    const ref = { environmentId, threadId: orchestratorId };
    expect(selectTeamWorkers([second, first], ref).map(({ id }) => id)).toEqual([
      "worker-a",
      "worker-b",
    ]);
    expect(
      selectTeamWorkers(
        [
          second,
          {
            ...first,
            latestTurn: {
              turnId: TurnId.make("turn-running"),
              state: "running",
              requestedAt: "2026-09-17T00:00:02.000Z",
              startedAt: "2026-09-17T00:00:02.000Z",
              completedAt: null,
              assistantMessageId: null,
            },
          },
        ],
        ref,
      ).map(({ id }) => id),
    ).toEqual(["worker-a", "worker-b"]);
  });

  it("derives attention, live, terminal, and aggregate states", () => {
    const running = worker("running", "2026-09-17T00:00:00.000Z", {
      session: {
        threadId: ThreadId.make("running"),
        status: "running",
        providerName: "Codex",
        runtimeMode: "full-access",
        activeTurnId: TurnId.make("turn"),
        lastError: null,
        updatedAt: "2026-09-17T00:00:00.000Z",
      },
    });
    const approval = worker("approval", "2026-09-17T00:00:01.000Z", {
      hasPendingApprovals: true,
    });
    expect(teamWorkerStatus(running)).toBe("working");
    expect(teamWorkerStatus(approval)).toBe("approval");
    expect(deriveTeamStatus([running, approval])).toMatchObject({
      state: "attention",
      working: 1,
      attention: 1,
    });
  });

  it("totals the latest checkpoint only", () => {
    const checkpoints = [
      {
        turnId: TurnId.make("turn"),
        checkpointTurnCount: 1,
        checkpointRef: "checkpoint" as never,
        status: "ready" as const,
        files: [
          { path: "a.ts", kind: "modified", additions: 4, deletions: 1 },
          { path: "b.ts", kind: "added", additions: 3, deletions: 0 },
        ],
        assistantMessageId: null,
        completedAt: "2026-09-17T00:00:00.000Z",
      },
    ];
    expect(
      teamWorkerDiffStats({ checkpoints } as Pick<OrchestrationThread, "checkpoints">),
    ).toEqual({ files: 2, additions: 7, deletions: 1 });
  });

  it("reads structured team reports and rejects malformed payloads", () => {
    const context = {
      version: 1 as const,
      records: [
        {
          version: 1 as const,
          contextId: "report" as never,
          label: "Team update",
          kind: "team-report",
          payload: {
            reports: [
              {
                workerThreadId: "worker-a",
                roleLabel: "Frontend",
                title: "Build the panel",
                state: "completed",
                branch: "team/worker-a",
                diffStats: { files: 2, additions: 7, deletions: 1 },
                lastAssistantMessage: "Done.",
              },
            ],
          },
        },
      ],
    };
    expect(selectTeamReport({ context })?.[0]).toMatchObject({ roleLabel: "Frontend" });
    expect(
      selectTeamReport({
        context: {
          ...context,
          records: [{ ...context.records[0]!, payload: { reports: [{ broken: true }] } }],
        },
      }),
    ).toBeNull();
  });
});
