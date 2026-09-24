import {
  OrchestrationThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ThreadTeamInfo,
} from "@t3tools/contracts";
import { BUILT_IN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { createModelSelection } from "@t3tools/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as ProviderAdapterRegistry from "../../provider/Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../../provider/Layers/ProviderService.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import { makeAdapterRegistryMock } from "../../provider/testUtils/providerAdapterRegistryMock.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const codexInstanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project-team-credential");
const decodeShell = Schema.decodeUnknownEffect(OrchestrationThreadShell);

const issueCredentialFor = (threadId: ThreadId, team: ThreadTeamInfo) =>
  Effect.gen(function* () {
    const issued: Array<{ threadId: ThreadId; capabilities: ReadonlyArray<string> }> = [];
    const adapter = {
      provider: CODEX_DRIVER,
      capabilities: { sessionModelSwitch: "in-session" as const },
      startSession: (input: ProviderSessionStartInput) =>
        Effect.succeed({
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          resumeCursor: { opaque: `resume-${input.threadId}` },
          cwd: input.cwd ?? process.cwd(),
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        } satisfies ProviderSession),
      sendTurn: () => Effect.die("unused"),
      interruptTurn: () => Effect.die("unused"),
      respondToRequest: () => Effect.die("unused"),
      respondToUserInput: () => Effect.die("unused"),
      stopSession: () => Effect.void,
      listSessions: () => Effect.succeed([]),
      hasSession: () => Effect.succeed(false),
      readThread: () => Effect.die("unused"),
      rollbackThread: () => Effect.die("unused"),
      stopAll: () => Effect.void,
      streamEvents: Stream.empty,
    };
    const projectionLayer = Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
      getThreadShellById: (requestedThreadId: ThreadId) =>
        Effect.gen(function* () {
          const isWorkerOrchestrator =
            team.role === "worker" && requestedThreadId === team.orchestratorThreadId;
          assert.isTrue(requestedThreadId === threadId || isWorkerOrchestrator);
          return Option.some(
            yield* decodeShell({
              id: requestedThreadId,
              projectId,
              title: isWorkerOrchestrator ? "Team orchestrator" : "Team credential test",
              modelSelection: createModelSelection(codexInstanceId, "gpt-5.4"),
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              team: isWorkerOrchestrator
                ? { role: "orchestrator", workflow: BUILT_IN_TEAM_WORKFLOW }
                : team,
              latestTurn: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              session: null,
              latestUserMessageAt: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: false,
            }),
          );
        }).pipe(Effect.orDie),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]);
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const providerLayer = makeProviderServiceLive({
      issueMcpCredential: (request) =>
        Effect.sync(() => {
          issued.push({
            threadId: request.threadId,
            capabilities: [...request.capabilities].toSorted(),
          });
          return undefined;
        }),
    }).pipe(
      Layer.provide(
        Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistry,
          makeAdapterRegistryMock({ [CODEX_DRIVER]: adapter }),
        ),
      ),
      Layer.provide(ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))),
      Layer.provide(projectionLayer),
      Layer.provide(
        ServerSettings.ServerSettingsService.layerTest({ enableAgentBrowserAccess: false }),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
    }).pipe(Effect.provide(providerLayer));
    return issued;
  });

it.effect("issues team-tool credentials only for orchestrator threads", () =>
  Effect.gen(function* () {
    const orchestratorId = ThreadId.make("team-credential-orchestrator");
    assert.deepEqual(
      yield* issueCredentialFor(orchestratorId, {
        role: "orchestrator",
        workflow: BUILT_IN_TEAM_WORKFLOW,
      }),
      [{ threadId: orchestratorId, capabilities: ["pull-requests", "team"] }],
    );

    const workerId = ThreadId.make("team-credential-worker");
    assert.deepEqual(
      yield* issueCredentialFor(workerId, {
        role: "worker",
        orchestratorThreadId: orchestratorId,
        roleId: BUILT_IN_TEAM_WORKFLOW.roles[0]!.id,
        roleLabel: "Frontend",
        taskTitle: "Build the UI",
      }),
      [{ threadId: workerId, capabilities: ["pull-requests"] }],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
