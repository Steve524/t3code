import type { CrewRunCard, CrewRunLane, CrewRunView } from "@t3tools/contracts/fork/crews/crewRun";

const laneOrder: Record<CrewRunLane, number> = {
  needs_you: 0,
  failed: 1,
  waiting_lead: 2,
  working: 3,
  queued: 4,
  done: 5,
  skipped: 6,
};

export function crewBoardColumns(view: CrewRunView, needsYouOnly: boolean) {
  const columns = [...view.columns];
  for (const card of view.cards)
    if (!columns.some((column) => column.id === card.column))
      columns.push({ id: card.column, label: card.column });
  return columns.map((column) => ({
    ...column,
    cards: view.cards
      .filter((card) => card.column === column.id && (!needsYouOnly || card.lane === "needs_you"))
      .toSorted((a, b) => laneOrder[a.lane] - laneOrder[b.lane]),
  }));
}

export function crewLaneLabel(card: CrewRunCard) {
  if (card.state === "stopping") return "Stopping";
  if (card.state === "blocked" && card.stepType !== "merge" && card.outcome !== "failed")
    return "Waiting for decision";
  if (card.state === "reported") return `Reported: ${card.outcome ?? "waiting for turn end"}`;
  if (card.outcome === "no_report" && card.lane !== "done") return "No report";
  if (card.stepType === "merge" && (card.conflictPaths?.length ?? 0) > 0 && card.lane !== "done")
    return "Merge conflict";
  return {
    queued: "Queued",
    working: "Working",
    waiting_lead: "Lead deciding",
    needs_you: "Needs you",
    done: "Done",
    failed: "Failed",
    skipped: "Skipped",
  }[card.lane];
}

export function crewCounterLabel(route: CrewRunView["routes"][number]) {
  return `${route.label} ${route.used}/${route.max}`;
}
export function crewBudgetLabel(usage: CrewRunView["budget"]["cards"], unit: "cards" | "h") {
  const number = (value: number) =>
    unit === "h" ? String(Math.round(value * 10) / 10) : String(value);
  return `${number(usage.used)}/${number(usage.limit)} ${unit}${usage.extended ? " (extended)" : ""}`;
}
export function crewAttemptLabels(card: CrewRunCard) {
  return [
    `Attempt ${card.attempt}`,
    ...(card.enteredVia ? [`Send-back ${card.enteredVia.used}/${card.enteredVia.max}`] : []),
  ];
}
export function crewCardActions(card: CrewRunCard, view: CrewRunView) {
  const running = !["completed", "failed", "cancelled"].includes(view.status);
  const task =
    card.stepType !== "gate" && card.stepType !== "decision" && card.sourceCardId === null;
  return {
    stop: running && task && card.threadId !== null && ["working", "reported"].includes(card.state),
    retry: running && task && ["queued", "blocked", "needs_you"].includes(card.state),
  };
}
export function crewCardElapsed(card: CrewRunCard, now: string) {
  if (!card.startedAt) return "Not started";
  const minutes = Math.max(
    0,
    Math.floor((Date.parse(card.finishedAt ?? `${now}:00Z`) - Date.parse(card.startedAt)) / 60_000),
  );
  const label =
    minutes < 1
      ? "<1 min"
      : minutes < 60
        ? `${minutes} min`
        : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return card.finishedAt ? `Finished in ${label}` : label;
}

export function positiveCrewAmount(value: string, integer = true) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 && (!integer || Number.isInteger(amount))
    ? amount
    : null;
}
