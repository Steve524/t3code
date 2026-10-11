import type { Atom } from "effect/reactivity";

import { FORK_CREWS_WS_METHODS } from "../../../../contracts/src/fork/crews/crewRpc.ts";
import type * as EnvironmentRegistry from "../../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../../state/runtime.ts";

/** Crew state shared by web and, later, mobile. */
export function createCrewCatalogAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    /**
     * Live crew list for one project, or for T3 home alone without a `projectId`. Each emission
     * also means a crew's detail may have changed.
     */
    crewsLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:fork:crews:live",
      tag: FORK_CREWS_WS_METHODS.subscribe,
    }),
    setToolboxMode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:fork:crews:toolbox:set-mode",
      tag: FORK_CREWS_WS_METHODS.toolboxSetMode,
    }),
    setRoleOverride: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:fork:crews:role-override:set",
      tag: FORK_CREWS_WS_METHODS.roleOverridesSet,
    }),
    resetRoleOverrides: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:fork:crews:role-override:reset",
      tag: FORK_CREWS_WS_METHODS.roleOverridesReset,
    }),
  };
}
