import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "../environment.ts";
import { KeybindingRule } from "../keybindings.ts";
import { ThreadCreatedPayload, ThreadTurnStartCommand } from "../orchestration.ts";
import { ServerSettings, ServerSettingsPatch } from "../settings.ts";
import { TeamRoleId, TeamWorkflow } from "./team.ts";

const workflow = {
  id: "full-stack-team",
  name: "Full-stack team",
  builtIn: true,
  roles: [
    {
      id: "backend",
      label: "Backend",
      kind: "implementer",
      enabled: true,
      summary: "APIs, logic",
      modelSelection: null,
      runtimeMode: null,
      instructions: "",
    },
  ],
  maxParallelWorkers: 4,
  maxReviewRounds: 2,
  maxAutoReports: 30,
  orchestratorInstructions: "",
} as const;

const decodeTeamWorkflow = Schema.decodeUnknownSync(TeamWorkflow);

const threadCreatedInput = {
  threadId: "thread-team",
  projectId: "project-1",
  title: "Team thread",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  branch: null,
  worktreePath: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

describe("Team Workflow contracts", () => {
  it("advertises capability only when the server supplies it", () => {
    const decode = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
    const descriptor = {
      environmentId: "environment-1",
      label: "Local",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.32",
      capabilities: { repositoryIdentity: true },
    } as const;
    expect(decode(descriptor).capabilities.teamWorkflows).toBeUndefined();
    expect(
      decode({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, teamWorkflows: true },
      }).capabilities.teamWorkflows,
    ).toBe(true);
  });

  it("accepts the orchestrator keybinding", () => {
    const parsed = Schema.decodeUnknownSync(KeybindingRule)({
      key: "mod+alt+n",
      command: "chat.newOrchestrator",
    });
    expect(parsed.command).toBe("chat.newOrchestrator");
  });

  it("defaults old settings and accepts a workflow replacement patch", () => {
    expect(Schema.decodeUnknownSync(ServerSettings)({}).teamWorkflows).toEqual([]);
    expect(
      Schema.decodeUnknownSync(ServerSettingsPatch)({
        teamWorkflows: [workflow],
      }).teamWorkflows,
    ).toEqual([workflow]);
  });

  it("keeps old workflow snapshots unchanged and decodes planning options", () => {
    expect(decodeTeamWorkflow(workflow)).toEqual(workflow);

    const planning = decodeTeamWorkflow({
      ...workflow,
      id: "research-and-plan",
      protocolId: "t3-plan-loop",
      skillVersion: "1.0.0",
      researchDepth: "deep",
      deepResearchWorkers: 3,
      roles: ["planner", "reviewer", "researcher"].map((kind) => ({
        ...workflow.roles[0],
        id: kind,
        label: kind,
        kind,
      })),
    });
    expect(planning.roles.map(({ kind }) => kind)).toEqual(["planner", "reviewer", "researcher"]);
    expect(planning.researchDepth).toBe("deep");
    expect(planning.deepResearchWorkers).toBe(3);
    expect(() => decodeTeamWorkflow({ ...planning, deepResearchWorkers: 6 })).toThrow();
  });

  it("decodes historical and Team Workflow thread events", () => {
    const decode = Schema.decodeUnknownSync(ThreadCreatedPayload);
    expect(decode(threadCreatedInput).team).toBeUndefined();
    const orchestrator = decode({
      ...threadCreatedInput,
      team: { role: "orchestrator", workflow },
    });
    const worker = decode({
      ...threadCreatedInput,
      threadId: "thread-worker",
      team: {
        role: "worker",
        orchestratorThreadId: "thread-team",
        roleId: "backend",
        roleLabel: "Backend",
        taskTitle: "Add the API",
        reviewRound: 0,
      },
    });
    if (orchestrator.team?.role !== "orchestrator") throw new Error("Expected orchestrator");
    if (worker.team?.role !== "worker") throw new Error("Expected worker");
    expect(orchestrator.team.workflow.roles[0]?.id).toBe(TeamRoleId.make("backend"));
    expect(worker.team.orchestratorThreadId).toBe("thread-team");
  });

  it("decodes team metadata in bootstrap thread creation", () => {
    const parsed = Schema.decodeUnknownSync(ThreadTurnStartCommand)({
      type: "thread.turn.start",
      commandId: "cmd-team-bootstrap",
      threadId: "thread-team",
      message: {
        messageId: "msg-team-bootstrap",
        role: "user",
        text: "Build the feature",
        attachments: [],
      },
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "Team thread",
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          team: { role: "orchestrator", workflow },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.bootstrap?.createThread?.team?.role).toBe("orchestrator");
  });
});
