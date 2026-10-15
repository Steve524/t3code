// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { CrewRunView } from "@t3tools/contracts/fork/crews/crewRun";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CrewBannerGates, CrewBudgetGate } from "./CrewControls";
import { useCrewControl } from "./crewBoardState";

vi.mock("./crewBoardState", () => ({ useCrewControl: vi.fn() }));

const view: CrewRunView = {
  runId: "run",
  projectId: ProjectId.make("project"),
  crewId: "crew",
  crewName: "Crew",
  status: "running",
  homeMode: "first-step",
  leadRoleId: null,
  homeThreadId: null,
  integrationBranch: null,
  integrationWorktree: null,
  toolboxMode: "extend",
  roles: [],
  routes: [],
  budget: {
    cards: { used: 10, limit: 10 },
    hours: { used: 1, limit: 1 },
    fanoutItems: 5,
    gate: { kind: "maxFanoutItems", total: 10, choices: ["all", "first", "stop"] },
  },
  columns: [],
  cards: [],
  createdAt: "2026-10-14T10:00:00Z",
  updatedAt: "2026-10-14T10:00:00Z",
};

let host: HTMLDivElement;
let root: Root;
const send = vi.fn().mockResolvedValue(undefined);

function render(nextView = view, disabled = false) {
  act(() =>
    root.render(<CrewBudgetGate view={nextView} control={{ send, pending: false, disabled }} />),
  );
}

function input() {
  const field = host.querySelector("input");
  if (!field) throw new Error("Missing budget input");
  return field;
}

function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function enter() {
  act(() =>
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  send.mockClear();
  vi.mocked(useCrewControl).mockReturnValue({ send, pending: false, disabled: false });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  render();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("crew budget controls", () => {
  it("explains invalid fan-out amounts and prevents keyboard submission", () => {
    type("6");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Enter no more than 5 items.");
    enter();
    expect(send).not.toHaveBeenCalled();
    type("2.5");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Enter a whole number greater than zero.",
    );
    enter();
    expect(send).not.toHaveBeenCalled();
  });

  it("submits a valid fan-out count with Enter and clears validation feedback", () => {
    type("6");
    type("3");
    enter();
    expect(send).toHaveBeenCalledWith({ type: "selectFanout", choice: "first", count: 3 });
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("accepts fractional hour extensions and rejects zero", () => {
    render({
      ...view,
      budget: {
        ...view.budget,
        gate: { kind: "maxHours", total: null, choices: ["extend", "stop"] },
      },
    });
    type("0");
    enter();
    expect(send).not.toHaveBeenCalled();
    type("0.25");
    enter();
    expect(send).toHaveBeenCalledWith({ type: "extendBudget", kind: "maxHours", by: 0.25 });
  });

  it("blocks editing and keyboard submission while disabled", () => {
    type("3");
    render(view, true);
    enter();
    expect(input().disabled).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "hides stale budget actions for a %s run",
    (status) => {
      act(() =>
        root.render(
          <CrewBannerGates environmentId={EnvironmentId.make("test")} view={{ ...view, status }} />,
        ),
      );
      expect(host.querySelector("button")).toBeNull();
      expect(host.textContent).toBe("");
    },
  );
});
