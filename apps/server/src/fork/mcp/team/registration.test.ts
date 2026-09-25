import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ServerConfig from "../../../config.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "../../../provider/Services/ProviderInstanceRegistry.ts";
import { TeamBranchIntegration } from "../../git/TeamBranchIntegration.ts";
import { ThreadBootstrap } from "../../orchestration/Services/ThreadBootstrap.ts";

const TestLayer = McpHttpServer.TeamToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery)({ getThreadShellById: () => Effect.succeedNone }),
      Layer.mock(OrchestrationEngineService)({}),
      Layer.mock(ThreadBootstrap)({}),
      Layer.mock(ProviderInstanceRegistry)({}),
      Layer.mock(GitWorkflowService.GitWorkflowService)({}),
      Layer.mock(TeamBranchIntegration)({}),
      ServerConfig.layerTest("/workspace/project", { prefix: "team-registration-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      NodeServices.layer,
    ),
  ),
);

const invocation = {
  environmentId: EnvironmentId.make("environment-mcp-test"),
  threadId: ThreadId.make("thread-mcp-test"),
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

it.effect("registers Team Workflow tools and requires the team capability", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name)).toEqual(
      expect.arrayContaining([
        "team_roster",
        "team_spawn_worker",
        "team_get_worker",
        "team_get_worker_result",
        "team_export_worker_result",
        "team_list_artifacts",
        "team_message_worker",
        "team_stop_worker",
        "team_integrate",
      ]),
    );
    const denied = yield* server
      .callTool({ name: "team_roster", arguments: {} })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual([
      { type: "text", text: "MCP credential does not grant the team capability." },
    ]);
  }).pipe(Effect.provide(TestLayer)),
);
