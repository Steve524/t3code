import type { Atom } from "effect/reactivity";

import { FORK_CREWS_WS_METHODS } from "../../../../contracts/src/fork/crews/crewRpc.ts";
import type * as EnvironmentRegistry from "../../connection/registry.ts";
import { createEnvironmentRpcCommand } from "../../state/runtime.ts";

/** All run mutations use the existing guarded start/control RPCs. Settings commands stay in catalog. */
export function createCrewCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:fork:crews:runs:start",
      tag: FORK_CREWS_WS_METHODS.runsStart,
    }),
    control: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:fork:crews:runs:control",
      tag: FORK_CREWS_WS_METHODS.runsControl,
    }),
  };
}
