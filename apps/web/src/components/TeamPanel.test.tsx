import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TeamWorkerRow, teamWorkerActionAvailability } from "./TeamPanel";

const worker: EnvironmentThreadShell = {
  id: ThreadId.make("worker"),
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  title: "Worker",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "team/worker",
  worktreePath: "/tmp/worker",
  team: {
    role: "worker",
    orchestratorThreadId: ThreadId.make("orchestrator"),
    roleId: "frontend" as never,
    roleLabel: "Frontend",
    taskTitle: "Build the panel",
  },
  pullRequests: [],
  latestTurn: {
    turnId: TurnId.make("turn"),
    state: "running",
    requestedAt: "2026-09-17T00:00:00.000Z",
    startedAt: "2026-09-17T00:00:00.000Z",
    completedAt: null,
    assistantMessageId: null,
  },
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

describe("TeamWorkerRow", () => {
  it("keeps a fixed row height and exposes open, stop, and message actions", () => {
    const markup = renderToStaticMarkup(
      <TeamWorkerRow worker={worker} onOpen={() => {}} onStop={() => {}} onMessage={() => {}} />,
    );
    expect(markup).toContain("h-[6.5rem]");
    expect(markup).toContain('aria-label="Open worker"');
    expect(markup).toContain('aria-label="Stop worker"');
    expect(markup).toContain('aria-label="Message worker"');
    expect(markup).toMatch(/disabled=""[^>]*aria-label="Message worker"/);
  });

  it("allows messages only while idle and stop only while busy", () => {
    expect(teamWorkerActionAvailability("working")).toEqual({
      canStop: true,
      canMessage: false,
    });
    expect(teamWorkerActionAvailability("completed")).toEqual({
      canStop: false,
      canMessage: true,
    });
    expect(teamWorkerActionAvailability("stopped")).toEqual({
      canStop: false,
      canMessage: true,
    });
  });
});
