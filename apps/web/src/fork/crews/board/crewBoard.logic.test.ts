import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type {
  CrewRunCard,
  CrewRunSummary,
  CrewRunView,
} from "@t3tools/contracts/fork/crews/crewRun";
import {
  crewRunActivity,
  crewThreadIndex,
  isCrewCardThread,
} from "@t3tools/client-runtime/fork/crews/runs";
import {
  crewAttemptLabels,
  crewBoardColumns,
  crewBudgetLabel,
  crewCardActions,
  crewCardElapsed,
  crewCounterLabel,
  crewLaneLabel,
  positiveCrewAmount,
} from "./crewBoard.logic";

function card(patch: Partial<CrewRunCard> = {}): CrewRunCard {
  return {
    cardId: "card",
    stepId: "build",
    stepType: "task",
    visit: 1,
    itemIndex: null,
    roleId: "worker",
    modelSelection: null,
    threadId: ThreadId.make("role"),
    state: "working",
    lane: "working",
    column: "build",
    attempt: 1,
    outcome: null,
    summary: null,
    gate: null,
    decidedBy: null,
    sourceCardId: null,
    branch: null,
    worktreePath: null,
    ownershipViolations: [],
    startedAt: "2026-10-14T10:00:00Z",
    finishedAt: null,
    updatedAt: "2026-10-14T10:00:00Z",
    ...patch,
  };
}
function view(cards: CrewRunCard[], patch: Partial<CrewRunView> = {}): CrewRunView {
  return {
    runId: "run",
    projectId: ProjectId.make("project"),
    crewId: "crew",
    crewName: "Crew",
    status: "running",
    homeMode: "lead",
    leadRoleId: "lead",
    homeThreadId: ThreadId.make("home"),
    integrationBranch: null,
    integrationWorktree: null,
    toolboxMode: "extend",
    roles: [],
    routes: [],
    budget: {
      cards: { used: 60, limit: 60 },
      hours: { used: 1.2, limit: 8 },
      fanoutItems: 20,
      gate: null,
    },
    columns: [
      { id: "build", label: "Build" },
      { id: "review", label: "Review" },
    ],
    cards,
    createdAt: "2026-10-14T10:00:00Z",
    updatedAt: "2026-10-14T10:00:00Z",
    ...patch,
  };
}

describe("crew board", () => {
  it("keeps server columns and orders attention inside them, without making lanes into columns", () => {
    const board = view([
      card({ cardId: "done", lane: "done" }),
      card({ cardId: "lead", lane: "waiting_lead" }),
      card({ cardId: "working" }),
      card({ cardId: "you", lane: "needs_you" }),
      card({ cardId: "review", column: "review" }),
      card({ cardId: "other", column: "extra" }),
    ]);
    const grouped = crewBoardColumns(board, false);
    expect(grouped.map((column) => column.id)).toEqual(["build", "review", "extra"]);
    expect(grouped[0]!.cards.map((item) => item.cardId)).toEqual([
      "you",
      "lead",
      "working",
      "done",
    ]);
    expect(
      crewBoardColumns(board, true)
        .flatMap((column) => column.cards)
        .map((item) => item.cardId),
    ).toEqual(["you"]);
  });
  it("counts escalations and a budget gate once, excluding lead decisions", () => {
    const board = view([
      card({ lane: "waiting_lead" }),
      card({ cardId: "you", lane: "needs_you" }),
    ]);
    expect(crewRunActivity(board)).toMatchObject({ working: 0, needsYou: 1 });
    expect(
      crewRunActivity({
        ...board,
        budget: {
          ...board.budget,
          gate: { kind: "maxCards", total: null, choices: ["extend", "stop"] },
        },
      }).needsYou,
    ).toBe(2);
    expect(crewRunActivity(null).needsYou).toBe(0);
  });
  it("keeps retry attempts independent of historical send-backs and formats reset counters", () => {
    expect(
      crewAttemptLabels(card({ attempt: 2, enteredVia: { id: "review", used: 2, max: 3 } })),
    ).toEqual(["Attempt 2", "Send-back 2/3"]);
    expect(crewCounterLabel({ id: "r", label: "Review send-backs", used: 2, max: 3 })).toBe(
      "Review send-backs 2/3",
    );
    expect(crewCounterLabel({ id: "r", label: "Review send-backs", used: 0, max: 3 })).toBe(
      "Review send-backs 0/3",
    );
  });
  it("marks extended budgets and handles fractional active hours", () => {
    expect(crewBudgetLabel({ used: 60, limit: 60 }, "cards")).toBe("60/60 cards");
    expect(crewBudgetLabel({ used: 60, limit: 80, extended: 20 }, "cards")).toBe(
      "60/80 cards (extended)",
    );
    expect(crewBudgetLabel({ used: 1.2345, limit: 8 }, "h")).toBe("1.2/8 h");
  });
  it("offers stop while working, then retry only after the stop acknowledgement", () => {
    const board = view([]);
    expect(crewCardActions(card(), board)).toEqual({ stop: true, retry: false });
    expect(crewCardActions(card({ state: "dispatching" }), board)).toEqual({
      stop: false,
      retry: false,
    });
    expect(crewCardActions(card({ state: "stopping" }), board)).toEqual({
      stop: false,
      retry: false,
    });
    expect(crewCardActions(card({ state: "blocked", outcome: "failed" }), board)).toEqual({
      stop: false,
      retry: true,
    });
    expect(crewCardActions(card(), { ...board, status: "completed" })).toEqual({
      stop: false,
      retry: false,
    });
    expect(crewCardActions(card({ state: "needs_you", stepType: "decision" }), board).retry).toBe(
      false,
    );
  });
  it("labels lead, escalation, merge and elapsed state without timers on cards", () => {
    expect(crewLaneLabel(card({ state: "waiting_lead", lane: "waiting_lead" }))).toBe(
      "Lead deciding",
    );
    expect(crewLaneLabel(card({ state: "needs_you", lane: "needs_you" }))).toBe("Needs you");
    expect(crewLaneLabel(card({ stepType: "merge", conflictPaths: ["a"] }))).toBe("Merge conflict");
    expect(crewCardElapsed(card(), "2026-10-14T10:12")).toBe("12 min");
    expect(crewCardElapsed(card({ finishedAt: "2026-10-14T10:03:00Z" }), "2026-10-14T12:00")).toBe(
      "Finished in 3 min",
    );
  });
  it.each(["", "0", "-2", "NaN", "Infinity", "2.5"])(
    "refuses invalid card/fanout amounts: %s",
    (value) => expect(positiveCrewAmount(value)).toBeNull(),
  );
  it("accepts fractional hour extensions", () =>
    expect(positiveCrewAmount("0.5", false)).toBe(0.5));
});

describe("crew sidebar index", () => {
  it("hides every role attempt, preserves home threads and separates environments", () => {
    const run: CrewRunSummary = {
      runId: "run",
      projectId: ProjectId.make("project"),
      crewId: "crew",
      crewName: "Crew",
      status: "running",
      homeThreadId: ThreadId.make("home"),
      cardThreadIds: [
        ThreadId.make("home"),
        ...[1, 2, 3, 4, 5].map((n) => ThreadId.make(`role-${n}`)),
      ],
      needsYou: 0,
      createdAt: "now",
      updatedAt: "now",
    };
    const index = crewThreadIndex([{ environmentId: EnvironmentId.make("remote"), runs: [run] }]);
    for (let n = 1; n <= 5; n++)
      expect(isCrewCardThread({ environmentId: "remote", id: `role-${n}` }, index, false)).toBe(
        true,
      );
    expect(isCrewCardThread({ environmentId: "remote", id: "home" }, index, false)).toBe(false);
    expect(isCrewCardThread({ environmentId: "local", id: "role-1" }, index, false)).toBe(false);
    expect(isCrewCardThread({ environmentId: "remote", id: "role-1" }, index, true)).toBe(false);
    expect(isCrewCardThread({ environmentId: "remote", id: "ordinary" }, index, false)).toBe(false);
  });
});
