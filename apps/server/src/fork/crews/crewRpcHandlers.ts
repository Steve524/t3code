import * as Effect from "effect/Effect";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  FORK_CREWS_WS_METHODS,
  ForkCrewsRpcs,
} from "../../../../../packages/contracts/src/fork/crews/crewRpc.ts";
import * as CrewCatalog from "./CrewCatalog.ts";
import * as CrewRunService from "./CrewRunService.ts";

const ForkCrewsRpcGroup = RpcGroup.make(...ForkCrewsRpcs);

/** Spread into the WebSocket handler map. Each handler calls one service method. */
export const handlers = Effect.gen(function* () {
  const crews = yield* CrewCatalog.CrewCatalog;
  const runs = yield* CrewRunService.CrewRunService;
  return ForkCrewsRpcGroup.of({
    [FORK_CREWS_WS_METHODS.list]: (input) => crews.list(input.projectId),
    [FORK_CREWS_WS_METHODS.get]: (input) => crews.get(input),
    [FORK_CREWS_WS_METHODS.subscribe]: (input) => crews.subscribe(input.projectId),
    [FORK_CREWS_WS_METHODS.validate]: (input) => crews.validateText(input),
    [FORK_CREWS_WS_METHODS.toolboxGet]: (input) => crews.getToolbox(input.projectId),
    [FORK_CREWS_WS_METHODS.toolboxSetMode]: (input) => crews.setToolboxMode(input),
    [FORK_CREWS_WS_METHODS.roleOverridesList]: (input) => crews.listRoleOverrides(input),
    [FORK_CREWS_WS_METHODS.roleOverridesSet]: (input) => crews.setRoleOverride(input),
    [FORK_CREWS_WS_METHODS.roleOverridesReset]: (input) => crews.resetRoleOverrides(input),
    [FORK_CREWS_WS_METHODS.runsStart]: (input) => runs.start(input),
    [FORK_CREWS_WS_METHODS.runsControl]: ({ runId, action }) => {
      switch (action.type) {
        case "pause":
          return runs.pause(runId);
        case "resume":
          return runs.resume(runId);
        case "cancel":
          return runs.cancel(runId);
        case "resolveGate":
          return runs.resolveGate({ runId, ...action });
      }
    },
    [FORK_CREWS_WS_METHODS.runsGet]: (input) => runs.get(input.runId),
    [FORK_CREWS_WS_METHODS.runsList]: (input) => runs.list(input),
    [FORK_CREWS_WS_METHODS.runsSubscribe]: (input) =>
      "runId" in input ? runs.subscribe(input.runId) : runs.subscribeByThread(input.threadId),
  });
});
