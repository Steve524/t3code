import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { liveThreadsLayer } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as CrewCatalog from "../CrewCatalog.ts";
import * as CrewMcp from "./handlers.ts";

it.effect("refuses gateway access even for a live provider until role grants are implemented", () =>
  Effect.gen(function* () {
    const toolkit = yield* CrewMcp.CrewToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(CrewMcp.layer)),
    );
    const listed = yield* toolkit.handle("crew_mcp_list_tools", { server: "forbidden" });
    const called = yield* toolkit.handle("crew_mcp_call", { server: "forbidden", tool: "write" });
    const results = [...(yield* Stream.runCollect(listed)), ...(yield* Stream.runCollect(called))];
    expect(results).toMatchObject([
      { isFailure: true, result: { code: "unavailable" } },
      { isFailure: true, result: { code: "unavailable" } },
    ]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        liveThreadsLayer,
        Layer.mock(CrewCatalog.CrewCatalog)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
      ),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("test"),
      requestNamespace: "test",
      thread: {
        threadId: ThreadId.make("caller"),
        providerSessionId: "test",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 0,
    }),
  ),
);
