/**
 * Runs crews against the real V2 orchestrator, thread launch, SQL and git, with
 * only the provider faked: each turn is answered by a script the test supplies,
 * which can call crew tools as that turn's agent before it ends the turn.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestratorMcpCapabilitiesResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { McpSchema, type McpServer } from "effect/ai";
import type * as SqlClient from "effect/sql/SqlClient";

import type { CrewRunView } from "../../../../../packages/contracts/src/fork/crews/crewRun.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import { ClaudeProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { runForkMigrations } from "../persistence/ForkMigrations.ts";
import * as CrewCatalog from "./CrewCatalog.ts";
import * as CrewRunService from "./CrewRunService.ts";
import * as CrewSettingsStore from "./CrewSettingsStore.ts";
import * as CrewMcpGateway from "./mcp/CrewMcpGateway.ts";
import * as CrewNativeMcp from "./mcp/CrewNativeMcp.ts";
import * as CrewMcp from "./mcp/handlers.ts";

export const projectId = ProjectId.make("project:crew-runs");
export const codex = ProviderInstanceId.make("codex");
/** A second Codex account, for roles that spread their cards over a pool. */
export const codexB = ProviderInstanceId.make("codex-b");
export const claude = ProviderInstanceId.make("claudeAgent");

export interface AgentTurn {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  /** The user message the turn answers: a card's prompt or a reminder. */
  readonly text: string;
}

/**
 * The agent's final message for a turn. Null leaves the turn running until the test ends it
 * with `finish` or the run stops it.
 */
export type AgentScript = (turn: AgentTurn) => Effect.Effect<string | null>;
/** Ends a turn a script left running. */
type EndTurn = (response: string) => Effect.Effect<void>;

function makeScriptedAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly turns: Ref.Ref<ReadonlyArray<AgentTurn>>;
  readonly script: () => AgentScript;
  /** Filled with how to end the thread's turn, once a script leaves that turn running. */
  readonly open: (threadId: ThreadId) => Deferred.Deferred<EndTurn>;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  const unsupported = (detail: string) =>
    Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver: input.driver, detail }));
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const publish = (providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
          Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
            discard: true,
          });
        const turnInputs = new Map<ProviderTurnId, ProviderAdapter.ProviderAdapterV2TurnInput>();
        const providerTurn = (
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
          id: ProviderTurnId,
          status: "running" | "completed" | "interrupted",
          at: DateTime.Utc,
        ): ProviderAdapter.ProviderAdapterV2Event => ({
          type: "provider_turn.updated",
          driver: input.driver,
          providerTurn: {
            id,
            providerThreadId: turnInput.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: {
              driver: input.driver,
              nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
              strength: "strong",
            },
            ordinal: turnInput.providerTurnOrdinal,
            status,
            startedAt: at,
            completedAt: status === "running" ? null : at,
          },
        });

        return {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              const turn: AgentTurn = {
                instanceId: input.instanceId,
                threadId: turnInput.threadId,
                text: turnInput.message.text,
              };
              yield* Ref.update(input.turns, (turns) => [...turns, turn]);
              const startedAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              turnInputs.set(providerTurnId, turnInput);
              yield* publish([providerTurn(turnInput, providerTurnId, "running", startedAt)]);
              const complete = (response: string) =>
                Effect.gen(function* () {
                  const completedAt = yield* DateTime.now;
                  const ordinal = `${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`;
                  yield* publish(completion(response, completedAt, ordinal));
                });
              const completion = (
                response: string,
                completedAt: DateTime.Utc,
                ordinal: string,
              ): ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> => [
                providerTurn(turnInput, providerTurnId, "completed", completedAt),
                {
                  type: "turn_item.updated",
                  driver: input.driver,
                  turnItem: {
                    id: TurnItemId.make(`turn-item:${ordinal}:assistant`),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: completedAt,
                    completedAt,
                    updatedAt: completedAt,
                    type: "assistant_message",
                    messageId: MessageId.make(`message:${ordinal}:assistant`),
                    text: response,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ];
              const response = yield* input.script()(turn);
              if (response === null)
                yield* Deferred.succeed(input.open(turnInput.threadId), complete);
              else yield* complete(response);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: ({ providerThread, providerTurnId }) =>
            Effect.gen(function* () {
              const turnInput = turnInputs.get(providerTurnId);
              const at = yield* DateTime.now;
              yield* publish([
                ...(turnInput === undefined
                  ? []
                  : [providerTurn(turnInput, providerTurnId, "interrupted", at)]),
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput?.runOrdinal ?? 1,
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unsupported("readThreadSnapshot is unused in crew tests"),
          rollbackThread: () => unsupported("rollbackThread is unused in crew tests"),
          forkThread: () => unsupported("forkThread is unused in crew tests"),
        };
      }),
  };
}

const provider = (instanceId: ProviderInstanceId, driver: string, ...models: Array<string>) => ({
  providerInstanceId: instanceId,
  driverKind: ProviderDriverKind.make(driver),
  displayName: null,
  models: models.map((id) => ({ id, label: null })),
  canRunChildTask: true,
  canRunCrossProviderChildTask: true,
  constraints: [],
});

// The models the fixture crews hint at, each on one fake instance.
const capabilities: OrchestratorMcpCapabilitiesResult = {
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  runtimeMode: "approval-required",
  interactionMode: "default",
  providers: [
    provider(codex, "codex", "gpt-5.6-terra", "gpt-5.6-luna"),
    provider(codexB, "codex", "gpt-5.6-terra", "gpt-5.6-luna"),
    provider(claude, "claudeAgent", "claude-opus-5-5"),
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

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "crew-run-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "crew-run-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

export interface CrewRunHarness {
  /** T3 home, seeded with the fixture crews, skill library and `mcp.yaml`. */
  readonly home: string;
  /** The project's checkout, a git repository on `main` with the fixture `.t3` toolbox committed. */
  readonly workspace: string;
  /** Runs git in a checkout and returns what it printed. */
  readonly git: (cwd: string, ...args: ReadonlyArray<string>) => Effect.Effect<string>;
  /**
   * Ends a turn its script left running, with the agent's final message. A card is `working`
   * before its thread's turn starts, so this waits for that turn.
   */
  readonly finish: (threadId: ThreadId, text: string) => Effect.Effect<void>;
  /** Set this before starting a run: it answers every turn from then on. */
  readonly agent: { script: AgentScript };
  /** Every turn a fake provider was asked to run, in order. */
  readonly turns: Ref.Ref<ReadonlyArray<AgentTurn>>;
  /**
   * Calls a `t3-code` MCP tool as the agent of a turn. A success is its structured
   * content; a refusal is the tool's declared failure.
   */
  readonly tool: (
    turn: Pick<AgentTurn, "threadId" | "instanceId">,
    name: string,
    args?: Record<string, unknown>,
  ) => Effect.Effect<{ readonly ok: boolean; readonly value: unknown }>;
  /** The board once it satisfies `predicate`: now, or after the change that makes it so. */
  readonly until: (
    runId: string,
    predicate: (view: CrewRunView) => boolean,
  ) => Effect.Effect<CrewRunView>;
  /**
   * Kills the crew services the way a server shutdown does: their workers stop where they
   * are. The database, the orchestrator and the fake providers keep running.
   */
  readonly stop: Effect.Effect<void>;
  /**
   * Starts the crew services again on the same database, which runs their startup recovery,
   * and runs `after` with them. `until` and `tool` use them from then on.
   */
  readonly restart: <A, E, R>(after: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export type CrewRunTestServices =
  | CrewRunService.CrewRunService
  | CrewCatalog.CrewCatalog
  | ThreadManagementService.ThreadManagementService
  | ServerSecretStore.ServerSecretStore
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope;

/** Runs `body` with a crew run service whose roles are scripted fake agents. */
export const withCrewRuns = <A, E>(
  // Passed in because only a test file may import Effect's McpServer.
  mcpServer: typeof McpServer.McpServer,
  body: (harness: CrewRunHarness) => Effect.Effect<A, E, CrewRunTestServices>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtures = path.join(import.meta.dirname, "__fixtures__");
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-crews-" });
    yield* fileSystem.copy(path.join(fixtures, "home"), home);
    const workspace = yield* checkpointWorkspace("crew-runs");
    // Committed as `project-toolbox` because the repo ignores every `.t3` directory.
    yield* fileSystem.copy(path.join(fixtures, "project-toolbox"), path.join(workspace, ".t3"));

    const turns = yield* Ref.make<ReadonlyArray<AgentTurn>>([]);
    const running = new Map<ThreadId, Deferred.Deferred<EndTurn>>();
    const open = (threadId: ThreadId) => {
      const slot = running.get(threadId) ?? Deferred.makeUnsafe<EndTurn>();
      running.set(threadId, slot);
      return slot;
    };
    const agent: CrewRunHarness["agent"] = { script: () => Effect.succeed("Done.") };
    const adapter = (
      instanceId: ProviderInstanceId,
      driver: string,
      providerCapabilities: OrchestrationV2ProviderCapabilities,
    ) =>
      makeScriptedAdapter({
        instanceId,
        driver: ProviderDriverKind.make(driver),
        capabilities: providerCapabilities,
        turns,
        script: () => agent.script,
        open,
      });

    const project = {
      id: projectId,
      title: "Crew runs",
      workspaceRoot: workspace,
      repositoryIdentity: null,
      faviconPath: null,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      scripts: [],
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T00:00:00.000Z",
      deletedAt: null,
    };
    const layerDatabase = SqlitePersistence.layerMemory;
    const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
      {
        name: "crew-runs",
        runtimePolicyOverride: {
          cwd: workspace,
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      },
      ProviderAdapterRegistry.layerFromAdapters([
        adapter(codex, "codex", CodexProviderCapabilitiesV2),
        adapter(codexB, "codex", CodexProviderCapabilitiesV2),
        adapter(claude, "claudeAgent", ClaudeProviderCapabilitiesV2),
      ]),
      { databaseLayer: layerDatabase },
    );
    const layerThreads = ThreadManagementService.layer.pipe(
      Layer.provide(layerOrchestrator),
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
    );
    const layerConfig = ServerConfig.layerTest(process.cwd(), home);
    const layerGit = GitVcsDriver.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(layerConfig),
    );
    const layerExternal = Layer.mergeAll(
      WorktreeSetupTracker.layer,
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
      Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(id === projectId ? Option.some(project as never) : Option.none()),
      }),
      // Real worktrees, under the temporary T3 home.
      Layer.unwrap(
        Effect.gen(function* () {
          const git = yield* GitVcsDriver.GitVcsDriver;
          return Layer.mock(GitWorkflow.GitWorkflowService)({
            createWorktree: (input, options) => git.createWorktree(input, options),
            removeWorktree: (input) => git.removeWorktree(input),
            remoteExists: () => Effect.succeed(false),
            hasCommit: () => Effect.succeed(false),
          });
        }),
      ).pipe(Layer.provide(layerGit)),
      Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
      }),
      Layer.mock(TextGeneration.TextGeneration)({}),
      ServerSettings.layerTest({
        providerInstances: { [codexB]: { driver: "codex", enabled: true } },
      }),
      ProviderRegistryMock.layer(),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        folderForThread: () => Effect.succeed(Option.none()),
      }),
    );
    const layerLaunch = ThreadLaunchService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerThreads,
          CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase)),
          IdAllocator.layer,
        ),
      ),
      Layer.provide(layerExternal),
    );
    // What a restart keeps: the database, the orchestrator and its providers, git, secrets.
    const layerBase = Layer.mergeAll(
      layerLaunch,
      layerThreads,
      ProcessRunner.layer,
      ServerSecretStore.layer,
    ).pipe(
      Layer.provideMerge(layerExternal),
      Layer.provideMerge(layerGit),
      Layer.provideMerge(layerConfig),
      Layer.provideMerge(layerDatabase),
    );
    // What a restart builds again.
    const layerCrew = McpHttpServer.toolkitRegistration(CrewMcp.CrewToolkit, CrewMcp.layer).pipe(
      Layer.provideMerge(mcpServer.layer),
      Layer.provideMerge(Layer.mergeAll(CrewRunService.layer, CrewNativeMcp.layer)),
      Layer.provideMerge(CrewCatalog.layer),
      Layer.provide(CrewSettingsStore.layer),
      Layer.provide(CrewMcpGateway.layer),
      Layer.provide(Layer.effectDiscard(runForkMigrations())),
      Layer.provide(
        Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
          capabilities: () => Effect.succeed(capabilities),
        }),
      ),
    );

    const base = yield* Layer.build(layerBase);
    const startCrew = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(layerCrew, scope).pipe(
        Effect.provide(base),
        Effect.orDie,
      );
      return {
        scope,
        context,
        runs: Context.get(context, CrewRunService.CrewRunService),
        server: Context.get(context, mcpServer),
      };
    });
    let crew = yield* startCrew;
    // Closed before the database and orchestrator it runs on.
    yield* Effect.addFinalizer(() => Scope.close(crew.scope, Exit.void));

    return yield* Effect.gen(function* () {
      const vcs = yield* GitVcsDriver.GitVcsDriver;
      const git: CrewRunHarness["git"] = (cwd, ...args) =>
        vcs.execute({ operation: "CrewRunHarness.git", cwd, args }).pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.orDie,
        );
      // Runs branch from `main`, and the toolbox is part of the checkout they branch from.
      yield* git(workspace, "branch", "-M", "main");
      yield* git(workspace, "add", "-A");
      yield* git(workspace, "commit", "-m", "toolbox");
      const finish: CrewRunHarness["finish"] = (threadId, text) =>
        Effect.suspend(() => Deferred.await(open(threadId))).pipe(
          Effect.tap(() => Effect.sync(() => running.delete(threadId))),
          Effect.flatMap((complete) => complete(text)),
        );
      const tool: CrewRunHarness["tool"] = (turn, name, args = {}) =>
        Effect.suspend(() => crew.server.callTool({ name, arguments: args })).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("environment:crew-runs"),
            requestNamespace: `session:${turn.threadId}`,
            thread: {
              threadId: turn.threadId,
              providerSessionId: `session:${turn.threadId}`,
              providerInstanceId: turn.instanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration" as const]),
            issuedAt: 1,
          }),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
          // Effect returns a declared tool failure as `isError` with its payload as JSON text.
          Effect.map((result) => {
            if (result.isError !== true) return { ok: true, value: result.structuredContent };
            const text = result.content[0];
            const failure: unknown = text?.type === "text" ? JSON.parse(text.text) : undefined;
            return { ok: false, value: failure };
          }),
          Effect.orDie,
        );
      const until: CrewRunHarness["until"] = (runId, predicate) =>
        Stream.suspend(() => crew.runs.subscribe(runId)).pipe(
          Stream.filter(predicate),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.orDie,
        );
      const stop = Effect.suspend(() => Scope.close(crew.scope, Exit.void));
      const restart: CrewRunHarness["restart"] = (after) =>
        Effect.gen(function* () {
          crew = yield* startCrew.pipe(Effect.provide(NodeServices.layer));
          return yield* after.pipe(Effect.provideContext(crew.context));
        });
      return yield* body({
        home,
        workspace,
        agent,
        turns,
        tool,
        until,
        git,
        finish,
        stop,
        restart,
      });
    }).pipe(Effect.provide(Context.merge(base, crew.context)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
