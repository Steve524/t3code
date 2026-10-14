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
    // The separate decision card owns attention, so its source must not count twice.
    ["blocked", "no_report", "queued"],
    ["blocked", "failed", "failed"],
    ["done", "approve", "done"],
    ["skipped", null, "skipped"],
    ["cancelled", null, "skipped"],
  ])("puts a %s card with outcome %s in %s", (state, outcome, lane) => {
    expect(crewCardLane({ state, outcome }, false)).toBe(lane);
  });

  it("shows a merge that waits on its conflict resolver as working, not as the user's turn", () => {
    expect(crewCardLane({ state: "blocked", outcome: null, stepType: "merge" }, false)).toBe(
      "working",
    );
    expect(crewCardLane({ state: "blocked", outcome: null, stepType: "merge" }, true)).toBe(
      "skipped",
    );
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
