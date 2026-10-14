import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { cursorMcpServers } from "../../../../../../packages/provider-cursor/src/server/adapter.ts";
import { acpExtraMcpServers } from "../../../../../../packages/provider-core/src/server/fork/crewMcpServers.ts";
import {
  CLAUDE_T3_MCP_TOOL_WILDCARD,
  ClaudeAgentSdkQueryRunner,
  claudeMcpQueryOverrides,
  layerQueryRunner,
} from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { codexThreadRuntimeParams } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const SECRET = "figma-secret-value";
const base: McpProviderSessionConfig = {
  environmentId: EnvironmentId.make("environment:native"),
  threadId: ThreadId.make("thread:native"),
  providerSessionId: "session:native",
  providerInstanceId: ProviderInstanceId.make("codex"),
  endpoint: "http://127.0.0.1:1/mcp",
  authorizationHeader: "Bearer t3-token",
  browserToolsAvailable: false,
};
const session: McpProviderSessionConfig = {
  ...base,
  extraMcpServers: [
    { name: "playwright", command: "npx", args: ["@playwright/mcp@latest"], env: [] },
    {
      name: "figma",
      command: "figma-mcp",
      args: ["--stdio"],
      env: [{ name: "FIGMA_TOKEN", value: SECRET, secret: true }],
    },
  ],
};

describe("native crew MCP servers", () => {
  it("adds a crew role's servers to Codex next to t3-code", () => {
    const servers = codexThreadRuntimeParams({ mcpSession: session }).config.mcp_servers;
    expect(servers).toEqual({
      "t3-code": { url: base.endpoint, http_headers: { Authorization: base.authorizationHeader } },
      playwright: { command: "npx", args: ["@playwright/mcp@latest"], env: {} },
      figma: { command: "figma-mcp", args: ["--stdio"], env: { FIGMA_TOKEN: SECRET } },
    });
    expect(
      Object.keys(codexThreadRuntimeParams({ mcpSession: base }).config.mcp_servers ?? {}),
    ).toEqual(["t3-code"]);
  });

  it("gives Cursor and ACP agents the same servers as stdio entries", () => {
    expect(cursorMcpServers(session)).toMatchObject({
      "t3-code": { type: "http" },
      playwright: { type: "stdio", command: "npx", args: ["@playwright/mcp@latest"], env: {} },
      figma: { type: "stdio", env: { FIGMA_TOKEN: SECRET } },
    });
    expect(acpExtraMcpServers(session)).toEqual([
      { name: "playwright", command: "npx", args: ["@playwright/mcp@latest"], env: [] },
      {
        name: "figma",
        command: "figma-mcp",
        args: ["--stdio"],
        env: [{ name: "FIGMA_TOKEN", value: SECRET }],
      },
    ]);
  });

  it("pre-approves a Claude role's servers outside a read-only sandbox", () => {
    const open = claudeMcpQueryOverrides({ mcpSession: session, readOnlySandbox: false });
    expect(open.allowedTools).toEqual([
      CLAUDE_T3_MCP_TOOL_WILDCARD,
      "mcp__playwright__*",
      "mcp__figma__*",
    ]);
    expect(Object.keys(open.mcpServers ?? {})).toEqual(["t3-code", "playwright", "figma"]);
    expect(open.mcpServers?.figma).toEqual({
      type: "stdio",
      command: "figma-mcp",
      args: ["--stdio"],
      env: { FIGMA_TOKEN: SECRET },
    });

    const readOnly = claudeMcpQueryOverrides({ mcpSession: session, readOnlySandbox: true });
    expect(readOnly.allowedTools).toEqual(
      claudeMcpQueryOverrides({ mcpSession: base, readOnlySandbox: true }).allowedTools,
    );
    expect(Object.keys(readOnly.mcpServers ?? {})).toEqual(["t3-code", "playwright", "figma"]);
  });

  it.effect(
    "sends a Claude role's secret to the server's environment, never the CLI's arguments",
    () =>
      Effect.gen(function* () {
        const setMcpServers = vi.fn(async () => ({ added: [], removed: [], errors: {} }));
        const query = vi
          .spyOn(ClaudeSdk, "query")
          .mockReturnValue({ setMcpServers } as unknown as ClaudeSdk.Query);
        yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
        const { mcpServers } = claudeMcpQueryOverrides({
          mcpSession: session,
          readOnlySandbox: false,
        });

        const runner = yield* ClaudeAgentSdkQueryRunner;
        yield* runner.open({
          threadId: ThreadId.make("thread:native"),
          providerSessionId: ProviderSessionId.make("session:native"),
          options: {
            sessionId: "native-session",
            model: "claude-sonnet-5-5",
            tools: [],
            permissionMode: "default",
            ...(mcpServers === undefined ? {} : { mcpServers }),
          },
        });

        // What `query` gets becomes the CLI's command line.
        const options = query.mock.calls[0]?.[0].options;
        expect(options).toBeDefined();
        expect(options).not.toHaveProperty("mcpServers");
        expect(JSON.stringify(options)).not.toContain(SECRET);
        expect(setMcpServers).toHaveBeenCalledWith(
          expect.objectContaining({
            figma: expect.objectContaining({ env: { FIGMA_TOKEN: SECRET } }),
          }),
        );
      }).pipe(
        Effect.provide(
          layerQueryRunner.pipe(
            Layer.provide(
              Layer.succeed(ProviderEventLoggers, {
                native: {
                  filePath: "/tmp/events.log",
                  write: () => Effect.void,
                  close: () => Effect.void,
                },
                canonical: undefined,
              }),
            ),
          ),
        ),
        Effect.provide(NodeServices.layer),
      ),
  );
});
