import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { TeamReportReactor } from "./TeamReportReactor.ts";

export const teamReportReactorStartTestLayer = (started: string[]) =>
  Layer.succeed(TeamReportReactor, {
    start: () => {
      started.push("team-report-reactor");
      return Effect.void;
    },
    drain: Effect.void,
    drainThrough: () => Effect.void,
  });
