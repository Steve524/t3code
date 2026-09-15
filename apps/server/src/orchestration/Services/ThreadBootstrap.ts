import type {
  OrchestrationClientOrigin,
  OrchestrationCommand,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

type ThreadTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

export interface ThreadBootstrapShape {
  readonly dispatch: (
    command: ThreadTurnStartCommand,
    options?: { readonly origin?: OrchestrationClientOrigin },
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
}

export class ThreadBootstrap extends Context.Service<ThreadBootstrap, ThreadBootstrapShape>()(
  "t3/orchestration/Services/ThreadBootstrap",
) {}
