import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { BUILT_IN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-projection-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

engineLayer("Team Workflow projection", (it) => {
  it.effect("persists team info in shell and detail projections and restores it on replay", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-09-15T00:00:00.000Z";
      const projectId = ProjectId.make("project-team-projection");
      const threadId = ThreadId.make("thread-team-projection");
      const team = { role: "orchestrator" as const, workflow: BUILT_IN_TEAM_WORKFLOW };

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-team-projection-project"),
        projectId,
        title: "Team projection project",
        workspaceRoot: "/tmp/project-team-projection",
        defaultModelSelection: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-team-projection-thread"),
        threadId,
        projectId,
        title: "Team projection thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        team,
        createdAt,
      });

      const readTeam = Effect.gen(function* () {
        const shell = Option.getOrThrow(yield* snapshotQuery.getThreadShellById(threadId));
        const detail = Option.getOrThrow(yield* snapshotQuery.getThreadDetailById(threadId));
        return { shell: shell.team, detail: detail.team };
      });
      assert.deepEqual(yield* readTeam, { shell: team, detail: team });

      yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
      yield* sql`
        UPDATE projection_state
        SET last_applied_sequence = 0
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threads}
      `;
      yield* projectionPipeline.bootstrap;

      assert.deepEqual(yield* readTeam, { shell: team, detail: team });
    }),
  );
});
