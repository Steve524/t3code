import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { BUILT_IN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "../../orchestration/decider.ts";
import { createEmptyReadModel, projectEvent } from "../../orchestration/projector.ts";

it.layer(NodeServices.layer)("Team Workflow thread creation", (it) => {
  it.effect("preserves team metadata from the command through the event and read model", () =>
    Effect.gen(function* () {
      const createdAt = "2026-08-24T10:00:00.000Z";
      const projectId = ProjectId.make("project-1");
      const readModel = yield* projectEvent(createEmptyReadModel(createdAt), {
        sequence: 1,
        eventId: EventId.make("event-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: createdAt,
        commandId: CommandId.make("command-project-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-project-created"),
        metadata: {},
        payload: {
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      const team = { role: "orchestrator" as const, workflow: BUILT_IN_TEAM_WORKFLOW };
      const created = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("command-create-team-thread"),
          threadId: ThreadId.make("team-thread"),
          projectId,
          title: "Team thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          team,
          createdAt,
        },
        readModel,
      });

      expect(created).toMatchObject({ type: "thread.created", payload: { team } });
      const projected = yield* projectEvent(readModel, {
        ...(Array.isArray(created) ? created[0]! : created),
        sequence: 2,
      });
      expect(projected.threads[0]?.team).toEqual(team);
    }),
  );
});
