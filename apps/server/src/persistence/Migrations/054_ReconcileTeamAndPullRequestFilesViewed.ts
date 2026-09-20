import * as Effect from "effect/Effect";

import projectionThreadTeam from "./053_ProjectionThreadTeam.ts";
import pullRequestFilesViewed from "./053_PullRequestFilesViewed.ts";

// Fork databases used slot 53 for team metadata; upstream used it for viewed files.
// Both migrations are idempotent, so either history can safely acquire the missing schema.
export default Effect.gen(function* () {
  yield* projectionThreadTeam;
  yield* pullRequestFilesViewed;
});
