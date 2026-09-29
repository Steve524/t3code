import * as Effect from "effect/Effect";

import reconcileTeamAndPullRequestFilesViewed from "./054_ReconcileTeamAndPullRequestFilesViewed.ts";
import projectionThreadsAutoSettleDisabledAt from "../../../persistence/Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

// Slot 54 was already used by the fork before upstream assigned it another migration.
export default Effect.gen(function* () {
  yield* reconcileTeamAndPullRequestFilesViewed;
  yield* projectionThreadsAutoSettleDisabledAt;
});
