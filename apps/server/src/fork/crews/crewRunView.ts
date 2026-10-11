/**
 * The board read model. A card's lane and column are worked out here each time
 * the run is read; nothing about them is stored.
 *
 * @module crewRunView
 */
import type { CrewFile } from "../../../../../packages/contracts/src/fork/crews/crewFile.ts";
import type {
  CrewRunLane,
  CrewRunStatus,
  CrewRunView,
} from "../../../../../packages/contracts/src/fork/crews/crewRun.ts";
import type { CrewCardRow, CrewRunRecord } from "./CrewRunStore.ts";

/** Whose turn a card is waiting on. A finished run has nothing left running. */
export function crewCardLane(
  card: { readonly state: string; readonly outcome: string | null },
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
      return "waiting_lead";
    case "needs_you":
      return "needs_you";
    // The card's own outcome is waiting on a decision card.
    case "blocked":
      return card.outcome === "failed" ? "failed" : "needs_you";
    case "done":
      return "done";
    default:
      return "skipped";
  }
}

/** The step's own column, else the board column listing it, else one per step type. */
export function crewCardColumn(crew: CrewFile, stepId: string, stepType: string) {
  const step = Object.hasOwn(crew.flow.steps, stepId) ? crew.flow.steps[stepId] : undefined;
  return (
    step?.column ??
    crew.board?.columns.find((column) => column.steps.includes(stepId))?.id ??
    stepType
  );
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
  const cards = rows.map((row) => ({
    ...row,
    lane: crewCardLane(row, runOver),
    column: crewCardColumn(crew, row.stepId, row.stepType),
  }));
  const columns = (crew.board?.columns ?? []).map(({ id, label }) => ({ id, label }));
  for (const card of cards) {
    if (!columns.some((column) => column.id === card.column)) {
      columns.push({ id: card.column, label: card.column });
    }
  }
  const { budget } = snapshot;
  return {
    runId: run.runId,
    projectId: run.projectId,
    crewId: run.crewId,
    crewName: crew.name,
    status,
    homeMode: snapshot.homeMode,
    leadRoleId: null,
    homeThreadId: run.homeThreadId,
    integrationBranch: run.integrationBranch,
    integrationWorktree: run.integrationWorktree,
    toolboxMode: run.toolboxMode,
    roles: Object.entries(run.roles).map(([id, role]) => {
      const toolbox = run.toolboxes[id];
      return {
        id,
        name: role.name,
        modelSelection: role.modelSelection,
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
      cards: { used: budget.cards, limit: budget.limits.maxCards },
      hours: { used: budget.activeSeconds / 3600, limit: budget.limits.maxHours },
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
