import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { McpServer } from "effect/ai";

import type {
  CrewRunCard,
  CrewRunView,
} from "../../../../../packages/contracts/src/fork/crews/crewRun.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as CrewCatalog from "./CrewCatalog.ts";
import * as CrewRunService from "./CrewRunService.ts";
import { codex, projectId, withCrewRuns, type CrewRunHarness } from "./CrewRunService.testkit.ts";
import * as CrewMcpGateway from "./mcp/CrewMcpGateway.ts";
import * as CrewNativeMcp from "./mcp/CrewNativeMcp.ts";

// The builder lists `figma`, which only T3 home defines, and is granted `storybook`, which only
// the repo defines, through its `worker` tag alone. The checker has no MCP server.
const DUO = `version: 1
id: toolbox-duo
name: Toolbox duo
inputs:
  brief: { type: text, required: true }
roles:
  builder:
    name: Builder
    tags: [worker]
    instructions: You build.
    model: { driver: codex, model: gpt-5.6-terra }
    mcp: [figma]
  checker:
    name: Checker
    instructions: You check.
    model: { driver: claudeAgent, model: claude-opus-5-5 }
flow:
  start: build
  steps:
    build:
      role: builder
      task: "Build this: {{inputs.brief}}"
      next: check
    check:
      role: checker
      task: Check the build.
      next: done
    done:
      type: end
`;

const SECRET = "figma-token-value";
const echoServer = (name: string, env: Record<string, string> = {}) =>
  JSON.stringify({
    command: process.execPath,
    args: [`${import.meta.dirname}/__fixtures__/mcp-echo/server.mjs`, name],
    env,
  });

const install = Effect.fn("install")(function* (harness: CrewRunHarness) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crew = path.join(harness.home, "crews", "toolbox-duo");
  yield* fileSystem.makeDirectory(crew, { recursive: true });
  yield* fileSystem.writeFileString(path.join(crew, "crew.yaml"), DUO);
  yield* fileSystem.writeFileString(
    path.join(harness.home, "mcp.yaml"),
    `servers:\n  figma: ${echoServer("figma", { FIGMA_AUTH: "${secret:FIGMA_TOKEN}" })}\n`,
  );
  const toolbox = path.join(harness.workspace, ".t3");
  yield* fileSystem.writeFileString(
    path.join(toolbox, "mcp.yaml"),
    `servers:\n  storybook: ${echoServer("storybook")}\n`,
  );
  yield* fileSystem.writeFileString(
    path.join(toolbox, "crews.yaml"),
    "version: 1\ntags:\n  worker: { mcp: [storybook] }\n",
  );
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* secrets.set(
    CrewMcpGateway.crewSecretName("FIGMA_TOKEN"),
    new TextEncoder().encode(SECRET),
  );
  const detail = yield* (yield* CrewCatalog.CrewCatalog).get({ projectId, crewId: "toolbox-duo" });
  expect(detail.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
});

const card = (view: CrewRunView, stepId: string) =>
  view.cards.findLast((candidate) => candidate.stepId === stepId);
const agentOf = (target: CrewRunCard) => ({
  threadId: target.threadId ?? ThreadId.make("missing"),
  instanceId: target.modelSelection?.instanceId ?? codex,
});
const firstText = (value: unknown) => {
  const content =
    typeof value === "object" && value !== null && "content" in value ? value.content : [];
  const [first] = Array.isArray(content) ? content : [];
  return typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
};

describe("crew MCP servers", () => {
  it.live("reaches a role's home and repo servers, natively and through the gateway", () =>
    withCrewRuns(McpServer.McpServer, (harness) =>
      Effect.gen(function* () {
        yield* install(harness);
        const runs = yield* CrewRunService.CrewRunService;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        harness.agent.script = () => Effect.succeed(null);
        const run = yield* runs.start({
          projectId,
          crewId: "toolbox-duo",
          inputs: { brief: "add a /health route" },
          attachments: [],
          workspace: { mode: "current-checkout" },
          runtimeMode: "full-access",
          clientRequestId: "toolbox-duo",
        });
        const building = yield* harness.until(
          run.runId,
          (view) => card(view, "build")?.state === "working",
        );
        const builder = agentOf(card(building, "build")!);

        // Codex starts both servers itself, so the prompt lists them once, as its own tools.
        // The card's prompt is its thread's first message, there before the turn starts.
        const { messages } = yield* threads.getThreadRecords(builder.threadId, ["messages"], {
          messageRoles: ["user"],
        });
        const prompt = messages[0];
        expect(prompt?.text).toMatch(
          /MCP servers whose tools you have directly: (figma, storybook|storybook, figma)\./u,
        );
        expect(prompt?.text).not.toContain("crew_mcp_call");
        const native = yield* CrewNativeMcp.forThread(builder.threadId);
        expect(native.extraMcpServers?.map((server) => server.name).toSorted()).toEqual([
          "figma",
          "storybook",
        ]);
        expect(native.extraMcpServers?.find((server) => server.name === "figma")?.env).toEqual([
          { name: "FIGMA_AUTH", value: SECRET, secret: true },
        ]);

        // The gateway reaches the same servers for any provider.
        const context = yield* harness.tool(builder, "crew_context");
        expect(context).toMatchObject({
          ok: true,
          value: {
            mcpServers: expect.arrayContaining([
              expect.objectContaining({ name: "figma", source: "home" }),
              expect.objectContaining({ name: "storybook", source: "repo" }),
            ]),
          },
        });
        const listed = yield* harness.tool(builder, "crew_mcp_list_tools", { server: "storybook" });
        expect(listed).toMatchObject({ ok: true, value: { server: "storybook" } });
        expect(listed.value).toMatchObject({
          tools: expect.arrayContaining([expect.objectContaining({ name: "echo" })]),
        });
        const env = yield* harness.tool(builder, "crew_mcp_call", {
          server: "figma",
          tool: "env",
          arguments: { name: "FIGMA_AUTH" },
        });
        expect(env.ok).toBe(true);
        expect(firstText(env.value)).toBe(SECRET);
        const argv = yield* harness.tool(builder, "crew_mcp_call", {
          server: "figma",
          tool: "argv",
        });
        expect(firstText(argv.value)).not.toContain(SECRET);

        expect(
          yield* harness.tool(builder, "crew_report", { outcome: "done", summary: "Built." }),
        ).toMatchObject({ ok: true });
        yield* harness.finish(builder.threadId, "Done.");

        // A role without the server is refused, and gets none natively.
        const checking = yield* harness.until(
          run.runId,
          (view) => card(view, "check")?.state === "working",
        );
        const checker = agentOf(card(checking, "check")!);
        expect(
          yield* harness.tool(checker, "crew_mcp_list_tools", { server: "storybook" }),
        ).toMatchObject({ ok: false, value: { code: "not_allowed" } });
        expect(yield* CrewNativeMcp.forThread(checker.threadId)).toEqual({});
        expect(
          yield* harness.tool(checker, "crew_report", { outcome: "done", summary: "Fine." }),
        ).toMatchObject({ ok: true });
        yield* harness.finish(checker.threadId, "Done.");
        yield* harness.until(run.runId, (view) => view.status === "completed");
        yield* runs.drain;
      }),
    ),
  );
});
