import { ThreadId } from "@t3tools/contracts";
import { BUILT_IN_RESEARCH_PLAN_WORKFLOW, BUILT_IN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { canUseTeamTools, resolveRuntimeInstructionTeam } from "./TeamProviderSession.ts";

const threadId = ThreadId.make("team-provider-session");
const queryFor = (team: unknown) =>
  Option.some({
    getThreadShellById: () => Effect.succeed(Option.some({ team })),
  } as unknown as ProjectionSnapshotQuery["Service"]);

it.effect("grants team tools only to orchestrator threads", () =>
  Effect.gen(function* () {
    assert.isFalse(yield* canUseTeamTools(Option.none(), threadId));
    assert.isTrue(
      yield* canUseTeamTools(
        queryFor({ role: "orchestrator", workflow: BUILT_IN_TEAM_WORKFLOW }),
        threadId,
      ),
    );
    assert.isFalse(
      yield* canUseTeamTools(
        queryFor({ role: "worker", orchestratorThreadId: threadId }),
        threadId,
      ),
    );
  }),
);

it.effect("resolves a worker's role kind from its orchestrator's workflow", () =>
  Effect.gen(function* () {
    const orchestratorId = ThreadId.make("team-planner");
    const threads = new Map<ThreadId, unknown>([
      [
        orchestratorId,
        {
          title: "Plan the feature",
          team: { role: "orchestrator", workflow: BUILT_IN_RESEARCH_PLAN_WORKFLOW },
        },
      ],
      [
        threadId,
        {
          branch: null,
          team: {
            role: "worker",
            orchestratorThreadId: orchestratorId,
            roleId: "plan-reviewer",
            roleLabel: "Plan reviewer",
            taskTitle: "Review plan",
          },
        },
      ],
    ]);
    const query = Option.some({
      getThreadShellById: (id: ThreadId) => Effect.succeed(Option.fromNullishOr(threads.get(id))),
    } as unknown as ProjectionSnapshotQuery["Service"]);
    const team = yield* resolveRuntimeInstructionTeam(query, threadId);
    assert.deepInclude(team, { role: "worker", roleKind: "plan-reviewer" });
  }),
);
