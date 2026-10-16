/**
 * The board read model. A card's lane and column are worked out here each time
 * the run is read; nothing about them is stored.
 *
 * @module crewRunView
 */
import type {
  CrewRunLane,
  CrewRunStatus,
  CrewRunView,
} from "../../../../../packages/contracts/src/fork/crews/crewRun.ts";
import type { CrewCardRow, CrewRunRecord } from "./CrewRunStore.ts";

/** Whose turn a card is waiting on. A finished run has nothing left running. */
export function crewCardLane(
  card: { readonly state: string; readonly outcome: string | null; readonly stepType?: string },
  runOver: boolean,
): CrewRunLane {
  switch (card.state) {
    case "queued":
      return runOver ? "skipped" : "queued";
    case "dispatching":
    case "working":
    case "reported":
    case "stopping":
      return runOver ? "skipped" : "working";
    case "waiting_lead":
      return runOver ? "skipped" : "waiting_lead";
    case "needs_you":
      return runOver ? "skipped" : "needs_you";
    // The card's own outcome is waiting on a decision card. A merge waits on its conflict resolver.
    case "blocked":
      if (card.stepType === "merge") return runOver ? "skipped" : "working";
      return card.outcome === "failed" ? "failed" : runOver ? "skipped" : "queued";
    case "done":
      return "done";
    default:
      return "skipped";
  }
}

export function buildCrewRunView(
  run: CrewRunRecord,
  rows: ReadonlyArray<CrewCardRow>,
  options: { readonly toolbox: boolean },
): CrewRunView {
  const { crew, snapshot } = run;
  // A run is stored only once it has started, so the engine's `pending` never reaches here.
  const status: CrewRunStatus = snapshot.status === "pending" ? "running" : snapshot.status;
  const runOver = status === "completed" || status === "failed" || status === "cancelled";
  const engineCards = new Map(snapshot.cards.map((card) => [`${run.runId}:${card.id}`, card]));
  const cards = rows.map((row) => {
    const card = engineCards.get(row.cardId);
    const step = crew.flow.steps[row.stepId];
    const item = card?.item;
    const itemTitle =
      typeof item === "string"
        ? item
        : item && typeof item === "object" && "title" in item && typeof item.title === "string"
          ? item.title
          : null;
    return {
      ...row,
      outcome: card?.report?.outcome ?? row.outcome,
      title:
        itemTitle ??
        (step && "name" in step && typeof step.name === "string" ? step.name : undefined) ??
        row.stepId,
      outcomes: [
        ...new Set(
          snapshot.flow.edges
            .filter((edge) => edge.from === row.stepId && edge.outcome)
            .map((edge) => edge.outcome!),
        ),
      ],
      note: card?.note ?? null,
      ...(card?.enteredVia ? { enteredVia: card.enteredVia } : {}),
      ...(card?.scriptExitCode !== undefined ? { scriptExitCode: card.scriptExitCode } : {}),
      ...(card?.type === "merge"
        ? { mergedCount: card.mergedCount ?? 0, conflictPaths: card.conflictPaths ?? [] }
        : {}),
      lane: crewCardLane(row, runOver),
      column: row.stepType,
    };
  });
  const columns = [...new Set(cards.map((card) => card.column))].map((id) => ({ id, label: id }));
  const { budget } = snapshot;
  return {
    runId: run.runId,
    projectId: run.projectId,
    crewId: run.crewId,
    crewName: crew.name,
    brief: String(run.inputs.brief ?? ""),
    status,
    homeMode: snapshot.homeMode,
    leadRoleId: snapshot.lead?.roleId ?? null,
    homeThreadId: run.homeThreadId,
    integrationBranch: run.integrationBranch,
    integrationWorktree: run.integrationWorktree,
    toolboxMode: run.toolboxMode,
    roles: Object.entries(run.roles).map(([id, role]) => {
      const toolbox = run.toolboxes[id];
      return {
        id,
        name: role.name,
        // A model the user picked mid-run is what the role's next cards run on.
        modelSelection: snapshot.roleModels[id] ?? role.modelSelection,
        runtimeMode: role.runtimeMode,
        ...(options.toolbox && toolbox !== undefined ? { toolbox } : {}),
      };
    }),
    routes: snapshot.flow.edges.flatMap((edge) =>
      edge.limit === undefined || edge.kind === "join"
        ? []
        : [
            {
              id: edge.id,
              label: edge.limit.label ?? edge.id,
              used: snapshot.routeCounters[edge.id] ?? 0,
              max: edge.limit.max,
            },
          ],
    ),
    budget: {
      cards: {
        used: budget.cards,
        limit: budget.limits.maxCards,
        extended: budget.extensions.maxCards,
      },
      hours: {
        used: budget.activeSeconds / 3600,
        limit: budget.limits.maxHours,
        extended: budget.extensions.maxHours,
      },
      fanoutItems: budget.limits.maxFanoutItems,
      gate:
        snapshot.budgetGate === null
          ? null
          : {
              kind: snapshot.budgetGate.kind,
              choices: snapshot.budgetGate.choices,
              total: snapshot.budgetGate.total,
            },
    },
    columns,
    cards,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
