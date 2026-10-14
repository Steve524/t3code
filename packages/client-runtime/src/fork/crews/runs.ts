import { AsyncResult, Atom } from "effect/reactivity";

import { FORK_CREWS_WS_METHODS } from "../../../../contracts/src/fork/crews/crewRpc.ts";
import type { CrewRunSummary, CrewRunView } from "../../../../contracts/src/fork/crews/crewRun.ts";
import type * as EnvironmentRegistry from "../../connection/registry.ts";
import {
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../../state/runtime.ts";

export function crewRunActivity(view: CrewRunView | null) {
  return {
    working: view?.cards.filter((card) => card.lane === "working").length ?? 0,
    needsYou:
      (view?.cards.filter((card) => card.lane === "needs_you").length ?? 0) +
      (view?.budget.gate ? 1 : 0),
    cardThreads: new Map(
      view?.cards.flatMap((card) => (card.threadId ? [[card.threadId, card] as const] : [])) ?? [],
    ),
  };
}

/** Environment is part of the key: remote environments can reuse thread ids. */
export function crewThreadIndex(
  groups: ReadonlyArray<{ environmentId: string; runs: ReadonlyArray<CrewRunSummary> }>,
) {
  const index = new Map<string, { run: CrewRunSummary; home: boolean }>();
  for (const { environmentId, runs } of groups)
    for (const run of runs) {
      for (const id of run.cardThreadIds ?? [])
        index.set(`${environmentId}:${id}`, { run, home: false });
      if (run.homeThreadId) index.set(`${environmentId}:${run.homeThreadId}`, { run, home: true });
    }
  return index;
}

export function isCrewCardThread(
  thread: { environmentId: string; id?: string },
  index: ReturnType<typeof crewThreadIndex>,
  showRoleThreads: boolean,
) {
  return (
    !showRoleThreads &&
    thread.id !== undefined &&
    index.get(`${thread.environmentId}:${thread.id}`)?.home === false
  );
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
      // Card details read the frozen toolbox, so they need no second live subscription.
    }),
    activity: (target: Parameters<typeof live>[0]) =>
      Atom.map(live(target), AsyncResult.map(crewRunActivity)),
  };
}
