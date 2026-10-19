import { RpcScopeAuthorization } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  FORK_CREWS_WS_METHODS,
  ForkCrewsRpcs,
} from "../../../../../packages/contracts/src/fork/crews/crewRpc.ts";
import { RpcInstrumentation } from "../../observability/RpcInstrumentation.ts";
import * as CrewCatalog from "./CrewCatalog.ts";

export const methods = Object.values(FORK_CREWS_WS_METHODS);
export const group = RpcGroup.make(...ForkCrewsRpcs)
  .middleware(RpcScopeAuthorization)
  .middleware(RpcInstrumentation);

/** Type handlers separately: the combined group's handler inference exceeds TypeScript's limit. */
export const layer = group.toLayer(
  Effect.gen(function* () {
    const crews = yield* CrewCatalog.CrewCatalog;
    return group.of({
      [FORK_CREWS_WS_METHODS.list]: (input) => crews.list(input.projectId),
      [FORK_CREWS_WS_METHODS.get]: (input) => crews.get(input),
      [FORK_CREWS_WS_METHODS.subscribe]: (input) => crews.subscribe(input.projectId),
      [FORK_CREWS_WS_METHODS.validate]: (input) => crews.validateText(input),
      [FORK_CREWS_WS_METHODS.toolboxGet]: (input) => crews.getToolbox(input.projectId),
      [FORK_CREWS_WS_METHODS.toolboxSetMode]: (input) => crews.setToolboxMode(input),
      [FORK_CREWS_WS_METHODS.roleOverridesList]: (input) => crews.listRoleOverrides(input),
      [FORK_CREWS_WS_METHODS.roleOverridesSet]: (input) => crews.setRoleOverride(input),
      [FORK_CREWS_WS_METHODS.roleOverridesReset]: (input) => crews.resetRoleOverrides(input),
    });
  }),
);
