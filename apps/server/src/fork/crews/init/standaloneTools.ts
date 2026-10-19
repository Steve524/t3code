/**
 * The `t3_*` tools outside a running server: the real catalog and handlers over a T3 home and
 * project folders, with settings in memory and every provider model the fixture crews hint at.
 * The crew-init tool tests and the eval MCP server use it; the server itself never does.
 *
 * @module standaloneTools
 */
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpCapabilitiesResult,
  type Project,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as OrchestratorMcpService from "../../../mcp/OrchestratorMcpService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { runForkMigrations } from "../../persistence/ForkMigrations.ts";
import * as CrewCatalog from "../CrewCatalog.ts";
import * as CrewSettingsStore from "../CrewSettingsStore.ts";
import * as CrewMcp from "../mcp/handlers.ts";

const usable = (instanceId: string, driver: string, models: ReadonlyArray<string>) => ({
  providerInstanceId: ProviderInstanceId.make(instanceId),
  driverKind: ProviderDriverKind.make(driver),
  displayName: null,
  models: models.map((id) => ({ id, label: null })),
  canRunChildTask: true,
  canRunCrossProviderChildTask: true,
  constraints: [],
});

const capabilities: OrchestratorMcpCapabilitiesResult = {
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  runtimeMode: "approval-required",
  interactionMode: "default",
  providers: [
    usable("codex", "codex", ["gpt-5.6-terra", "gpt-5.6-luna"]),
    usable("claude", "claudeAgent", ["claude-opus-5-5"]),
  ],
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 20,
  },
};

export const CREW_INIT_TOOL_NAMES = [
  "t3_skill_get",
  "t3_crews_list",
  "t3_crews_get",
  "t3_crews_toolbox",
  "t3_crews_validate",
] as const;
export type CrewInitToolName = (typeof CREW_INIT_TOOL_NAMES)[number];

export interface StandaloneCrewInitTools {
  /** Calls a tool as an agent in `threadId`. A refusal is a result with `isFailure`. */
  readonly call: (
    threadId: ThreadId,
    name: CrewInitToolName,
    params?: unknown,
  ) => Effect.Effect<{ readonly isFailure: boolean; readonly result: unknown }>;
  /** `tools/list` entries for an MCP client. */
  readonly list: ReadonlyArray<{
    name: string;
    description: string;
    inputSchema: unknown;
    annotations: Readonly<Record<string, string | boolean>>;
  }>;
}

export const makeStandaloneCrewInitTools = Effect.fn("makeStandaloneCrewInitTools")(
  function* (options: {
    readonly home: string;
    readonly projects: Readonly<Record<ProjectId, string>>;
    /** Each thread's project; a project missing from `projects` counts as removed. */
    readonly threads: ReadonlyMap<ThreadId, ProjectId>;
    readonly scratchRoot?: string;
  }) {
    const projects = Layer.mock(ProjectService.ProjectService)({
      getById: (projectId) =>
        Effect.succeed(
          Option.fromNullishOr(options.projects[projectId]).pipe(
            Option.map((workspaceRoot) => ({ workspaceRoot }) as Project),
          ),
        ),
    });
    const catalog = CrewCatalog.layer.pipe(
      Layer.provide(CrewSettingsStore.layer),
      Layer.provide(Layer.effectDiscard(runForkMigrations())),
      Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
      Layer.provide(projects),
      Layer.provide(
        Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
          capabilities: () => Effect.succeed(capabilities),
        }),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), options.home)),
    );
    const services = Layer.mergeAll(
      projects,
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/unused",
        scratchRoot: Effect.succeed(Option.fromNullishOr(options.scratchRoot)),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) => {
          const projectId = options.threads.get(threadId);
          return Effect.succeed(
            projectId === undefined
              ? null
              : ({ id: threadId, projectId } as OrchestrationV2ThreadShell),
          );
        },
      }),
      catalog,
    );
    const context = yield* Layer.build(services);
    const toolkit = yield* CrewMcp.CrewToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(CrewMcp.layer)),
      Effect.provideContext(context),
    );
    // Callers name tools at runtime, so the per-tool parameter types do not apply here.
    const handle = toolkit.handle as unknown as (
      name: string,
      params: unknown,
    ) => Effect.Effect<
      Stream.Stream<{ readonly isFailure: boolean; readonly result: unknown }, Error>,
      Error,
      McpInvocationContext.McpInvocationContext
    >;
    const call: StandaloneCrewInitTools["call"] = (threadId, name, params = {}) =>
      handle(name, params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1) ?? { isFailure: true, result: "No result." }),
        // Parameters that do not decode come back as a failed result, as an MCP client expects.
        Effect.catchCause((cause) =>
          Effect.succeed({ isFailure: true, result: Cause.pretty(cause) }),
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("standalone"),
          requestNamespace: "standalone",
          thread: {
            threadId,
            providerSessionId: "standalone",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
        Effect.provideContext(context),
      );
    // Annotated as T3's MCP server does: clients approve read-only tools by these hints.
    const list = CREW_INIT_TOOL_NAMES.map((name) => {
      const tool = CrewMcp.CrewToolkit.tools[name];
      return {
        name,
        description: Tool.getDescription(tool) ?? "",
        inputSchema: Tool.getJsonSchema(tool),
        annotations: {
          title: Option.getOrElse(Context.getOption(tool.annotations, Tool.Title), () => name),
          readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
          destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
          openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
        },
      };
    });
    return { call, list } satisfies StandaloneCrewInitTools;
  },
);
