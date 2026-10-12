import { compileCrewFlow } from "../../../../../../packages/shared/src/fork/crews/compileCrewFlow.ts";
import {
  decodeCrew,
  withSteps,
  worker,
} from "../../../../../../packages/shared/src/fork/crews/crewTestFixtures.ts";
import { createCrewSnapshot, decide } from "./decide.ts";
import type { CrewCard, CrewEvent } from "./types.ts";

export {
  end,
  task,
  worker,
} from "../../../../../../packages/shared/src/fork/crews/crewTestFixtures.ts";

/** Crew fields that put a role of its own in the home thread, apart from the worker. */
export const led = {
  home: { mode: "lead" as const, role: "lead" },
  roles: { worker, lead: { name: "Lead", instructions: "Lead the crew." } },
};

type Input = {
  [K in CrewEvent["type"]]: Omit<Extract<CrewEvent, { type: K }>, "seq" | "at">;
}[CrewEvent["type"]];

export function engine(
  steps: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  options: Parameters<typeof createCrewSnapshot>[2] = {},
) {
  const crew = decodeCrew(withSteps(steps, extra));
  let snapshot = createCrewSnapshot(crew, compileCrewFlow(crew), options);
  const send = (input: Input, at = snapshot.lastEventAt ?? 0) => {
    const result = decide(snapshot, { ...input, seq: snapshot.lastEventSeq + 1, at });
    snapshot = result.snapshot;
    return result;
  };
  const latest = (stepId: string) =>
    snapshot.cards.findLast((card) => card.stepId === stepId && card.type !== "decision")!;
  const complete = (card: CrewCard, outcome = "done", at = snapshot.lastEventAt ?? 0) =>
    send({ type: "card.completed", cardId: card.id, attempt: card.attempt, outcome }, at);
  const dispatched = (card: CrewCard, at = snapshot.lastEventAt ?? 0) =>
    send(
      {
        type: "card.dispatched",
        cardId: card.id,
        attempt: card.attempt,
        threadId: `thread:${card.id}`,
        orchestrationRunId: `turn:${card.id}:${card.attempt}`,
      },
      at,
    );
  return {
    get snapshot() {
      return snapshot;
    },
    send,
    latest,
    complete,
    dispatched,
    /** Starts the run. In lead mode the kickoff turn ends too, so the flow's first step is entered. */
    start: () => {
      const created = send({ type: "run.created" });
      const kickoff = snapshot.lead?.turn;
      return kickoff ? send({ type: "lead.turn_finished", turnId: kickoff.id }) : created;
    },
  };
}
