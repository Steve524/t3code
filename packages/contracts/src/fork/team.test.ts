import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "../environment.ts";
import { KeybindingRule } from "../keybindings.ts";
import { ThreadCreatedPayload, ThreadTurnStartCommand } from "../orchestration.ts";
import { ServerSettings, ServerSettingsPatch } from "../settings.ts";
import { EditableArtifactDirectory, TeamRoleId, TeamWorkflow, ThreadTeamInfo } from "./team.ts";

const decodeWorkflow = Schema.decodeUnknownSync(TeamWorkflow);
const decodeEditableDirectory = Schema.decodeSync(EditableArtifactDirectory);
const decodeSavedSettings = Schema.decodeSync(ServerSettings);
const decodeSavedTeam = Schema.decodeSync(Schema.fromJsonString(ThreadTeamInfo));

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
    ).toEqual([{ ...workflow, type: "build" }]);
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

  it("decodes saved workflows without a type as build workflows", () => {
    const decode = Schema.decodeUnknownSync(TeamWorkflow);
    expect(decode(workflow).type).toBe("build");
    expect(decode({ ...workflow, type: "plan" }).type).toBe("plan");
    expect(() => decode({ ...workflow, type: "other" })).toThrow();
  });

  it("decodes the research and plan role kinds", () => {
    const decode = Schema.decodeUnknownSync(TeamWorkflow);
    const roles = decode({
      ...workflow,
      roles: (["researcher", "plan-reviewer"] as const).map((kind) => ({
        ...workflow.roles[0],
        id: kind,
        kind,
      })),
    }).roles;
    expect(roles.map((role) => role.kind)).toEqual(["researcher", "plan-reviewer"]);
  });

  it("keeps folders optional for older workflows and accepts relative folders", () => {
    const decode = Schema.decodeUnknownSync(TeamWorkflow);
    expect(decode(workflow).plansDir).toBeUndefined();
    expect(decode(workflow).researchDir).toBeUndefined();
    expect(
      decode({
        ...workflow,
        type: "plan",
        plansDir: " notes/plans ",
        researchDir: "notes\\research",
      }),
    ).toMatchObject({ plansDir: "notes/plans", researchDir: "notes\\research" });
  });

  it.each([
    "",
    "   ",
    "../plans",
    "docs/../plans",
    "docs\\..\\plans",
    "/plans",
    "\\plans",
    "C:\\plans",
    "C:plans",
    "\\\\host\\plans",
    "docs/plan\nignore",
  ])("rejects unsafe artifact folders: %j", (path) => {
    for (const field of ["plansDir", "researchDir"]) {
      expect(() => decodeWorkflow({ ...workflow, [field]: path })).toThrow();
    }
  });

  it.each([
    "notes./plans",
    "my plans /x",
    "notes\\plans.\\",
    "notes/ /plans",
    ".",
    "./",
    ".\\",
    "././",
    ".//",
    ".\\./",
  ])("rejects unusable folder edits: %j", (path) => {
    expect(() => decodeEditableDirectory(path)).toThrow();
  });

  it.each([
    "notes/plans",
    "notes/./plans",
    "notes//research/",
    "notes\\research",
    "my plans/nested",
  ])("accepts writable folder edits: %j", (path) => {
    expect(decodeEditableDirectory(path)).toBe(path);
  });

  it.each([".", "././", "notes./plans", "my plans /x"])(
    "preserves saved settings and thread snapshots with a legacy folder: %j",
    (path) => {
      const saved = { ...workflow, type: "plan" as const, plansDir: path, researchDir: path };
      expect(decodeSavedSettings({ teamWorkflows: [saved] }).teamWorkflows[0]).toMatchObject({
        plansDir: path,
        researchDir: path,
      });
      const team = decodeSavedTeam(JSON.stringify({ role: "orchestrator", workflow: saved }));
      if (team.role !== "orchestrator") throw new Error("Expected orchestrator");
      expect(team.workflow).toMatchObject({ plansDir: path, researchDir: path });
    },
  );

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
