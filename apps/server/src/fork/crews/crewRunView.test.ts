import { describe, expect, it } from "vite-plus/test";

import {
  decodeCrew,
  end,
  task,
  withSteps,
} from "../../../../../packages/shared/src/fork/crews/crewTestFixtures.ts";
import { crewCardColumn, crewCardLane } from "./crewRunView.ts";

describe("board lanes", () => {
  it.each([
    ["queued", null, "queued"],
    ["dispatching", null, "working"],
    ["reported", "approve", "working"],
    ["waiting_lead", null, "waiting_lead"],
    ["needs_you", null, "needs_you"],
    // A card whose outcome waits on a decision card: the turn is the user's unless it failed.
    ["blocked", "no_report", "needs_you"],
    ["blocked", "failed", "failed"],
    ["done", "approve", "done"],
    ["skipped", null, "skipped"],
    ["cancelled", null, "skipped"],
  ])("puts a %s card with outcome %s in %s", (state, outcome, lane) => {
    expect(crewCardLane({ state, outcome }, false)).toBe(lane);
  });

  it.each(["queued", "working", "stopping"])(
    "shows a %s card as skipped once the run is over",
    (state) => {
      expect(crewCardLane({ state, outcome: null }, true)).toBe("skipped");
    },
  );
});

describe("board columns", () => {
  const crew = decodeCrew(
    withSteps(
      {
        work: { ...task, next: "check" },
        check: { ...task, column: "qa", next: "done" },
        done: end,
      },
      { board: { columns: [{ id: "build", label: "Build", steps: ["work", "check"] }] } },
    ),
  );

  it("prefers the step's own column, then the board's, then the step type", () => {
    expect(crewCardColumn(crew, "check", "task")).toBe("qa");
    expect(crewCardColumn(crew, "work", "task")).toBe("build");
    const { board: _board, ...boardless } = crew;
    expect(crewCardColumn(boardless, "work", "task")).toBe("task");
  });
});
