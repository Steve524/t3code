import { AsyncResult, Atom } from "effect/reactivity";

import { FORK_CREWS_WS_METHODS } from "../../../../contracts/src/fork/crews/crewRpc.ts";
import type { CrewRunView } from "../../../../contracts/src/fork/crews/crewRun.ts";
import type * as EnvironmentRegistry from "../../connection/registry.ts";
import {
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../../state/runtime.ts";

export function crewRunActivity(view: CrewRunView | null) {
  return {
    working: view?.cards.filter((card) => card.lane === "working").length ?? 0,
    needsYou: view?.cards.filter((card) => card.lane === "needs_you").length ?? 0,
    cardThreads: new Map(
      view?.cards.flatMap((card) => (card.threadId ? [[card.threadId, card] as const] : [])) ?? [],
    ),
  };
}

export function createCrewRunAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const live = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:fork:crews:runs:live",
    tag: FORK_CREWS_WS_METHODS.runsSubscribe,
  });
  return {
    live,
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:fork:crews:runs:list",
      tag: FORK_CREWS_WS_METHODS.runsList,
    }),
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:fork:crews:runs:get",
      tag: FORK_CREWS_WS_METHODS.runsGet,
      refreshTrigger: live,
    }),
    activity: (target: Parameters<typeof live>[0]) =>
      Atom.map(live(target), AsyncResult.map(crewRunActivity)),
  };
}
