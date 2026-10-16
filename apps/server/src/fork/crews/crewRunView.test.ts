import { describe, expect, it } from "vite-plus/test";

import { crewCardLane } from "./crewRunView.ts";

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
