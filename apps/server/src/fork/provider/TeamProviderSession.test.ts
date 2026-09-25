import { ThreadId } from "@t3tools/contracts";
import { BUILT_IN_TEAM_WORKFLOW, RESEARCH_PLAN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { canUseTeamTools, normalizePlanLoopPrompt } from "./TeamProviderSession.ts";

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

it.effect(
  "normalizes the plan command before provider dispatch and rejects incompatible threads",
  () =>
    Effect.gen(function* () {
      const request = "/t3-plan-loop mode=review research=deep\nReview this plan.";
      const team = queryFor({ role: "orchestrator", workflow: RESEARCH_PLAN_TEAM_WORKFLOW });
      let reads = 0;
      const ordinary = Option.some({
        getThreadShellById: () => {
          reads++;
          return Effect.succeed(Option.none());
        },
      } as unknown as ProjectionSnapshotQuery["Service"]);
      assert.equal(
        yield* normalizePlanLoopPrompt(ordinary, threadId, "ordinary request"),
        "ordinary request",
      );
      assert.equal(reads, 0);
      assert.equal(
        yield* normalizePlanLoopPrompt(team, threadId, request),
        "mode=review research=deep\nReview this plan.",
      );
      const error = yield* Effect.flip(normalizePlanLoopPrompt(Option.none(), threadId, request));
      assert.include(error.issue, "Open a Research and plan orchestrator thread");
    }),
);
