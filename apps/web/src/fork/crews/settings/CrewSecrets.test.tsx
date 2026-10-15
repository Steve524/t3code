// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CrewSecrets } from "./CrewSecrets";

const mocks = vi.hoisted(() => ({
  canWrite: true,
  update: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.canWrite }));
vi.mock("../../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({ FIRST: "•••", SECOND: "•••" }),
}));
vi.mock("../../../state/server", () => ({
  serverEnvironment: { updateSettings: { permissionAtom: () => null } },
}));
vi.mock("../../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("../../../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../../../components/settings/settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../board/crewBoardState", () => ({ useCrewControl: vi.fn() }));

let host: HTMLDivElement;
let root: Root;

function input(label: string) {
  const fieldLabel = [...host.querySelectorAll("label")].find((node) => node.textContent === label);
  const field = document.getElementById(fieldLabel?.htmlFor ?? "");
  if (!(field instanceof HTMLInputElement)) throw new Error(`Missing ${label} input`);
  return field;
}

function type(label: string, value: string) {
  const field = input(label);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(text: string) {
  const found = [...host.querySelectorAll("button")].find((node) => node.textContent === text);
  if (!found) throw new Error(`Missing ${text} button`);
  return found;
}

function render() {
  act(() =>
    root.render(
      <CrewSecrets
        environmentId={EnvironmentId.make("test")}
        environmentLabel="Test"
        referenced={[]}
      />,
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.canWrite = true;
  mocks.update.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.toast.mockClear();
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

describe("crew secret editing", () => {
  it("saves a valid replacement, clears the draft, and announces success", async () => {
    type("Name", "FIRST");
    type("Value", "replacement");
    await act(async () => button("Save").click());
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "test",
      input: { patch: { forkCrewSecrets: { FIRST: "replacement" } } },
    });
    expect(input("Value").value).toBe("");
    expect(mocks.toast).toHaveBeenCalledWith({ type: "success", title: "Crew secret saved" });
  });

  it("keeps a failed save's draft for retry", async () => {
    mocks.update.mockResolvedValueOnce({ _tag: "Failure" });
    type("Name", "FIRST");
    type("Value", "replacement");
    await act(async () => button("Save").click());
    expect(input("Value").value).toBe("replacement");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("locks the form and ignores duplicate submissions until a save finishes", async () => {
    let resolveSave!: (result: { _tag: "Success" }) => void;
    const pending = new Promise<{ _tag: "Success" }>((resolve) => {
      resolveSave = resolve;
    });
    mocks.update.mockReturnValueOnce(pending);
    type("Name", "FIRST");
    type("Value", "replacement");
    act(() => {
      for (let attempt = 0; attempt < 2; attempt++)
        host
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(input("Value").matches(":disabled")).toBe(true);
    await act(async () => resolveSave({ _tag: "Success" }));
    expect(input("Value").matches(":disabled")).toBe(false);
  });

  it("clears a replacement when choosing a different secret", () => {
    type("Name", "FIRST");
    type("Value", "belongs-to-first");
    act(() => button("SECOND · saved").click());
    expect(input("Name").value).toBe("SECOND");
    expect(input("Value").value).toBe("");
    expect(button("Save").disabled).toBe(true);
  });

  it("refuses invalid names even when the form is submitted directly", async () => {
    type("Name", "not valid!");
    type("Value", "replacement");
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(mocks.update).not.toHaveBeenCalled();
    expect(input("Name").getAttribute("aria-invalid")).toBe("true");
  });

  it("disables read-only connections and rejects direct submissions", async () => {
    type("Name", "FIRST");
    type("Value", "replacement");
    mocks.canWrite = false;
    render();
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(input("Value").matches(":disabled")).toBe(true);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(host.textContent).toContain("This connection cannot edit crew secrets.");
  });

  it("requires confirmation to remove a saved secret, and Escape cancels it", async () => {
    type("Name", "FIRST");
    act(() => button("Remove secret").click());
    expect(mocks.update).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(button("Remove secret")).toBeDefined();
    act(() => button("Remove secret").click());
    await act(async () => button("Confirm remove secret").click());
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "test",
      input: { patch: { forkCrewSecrets: { FIRST: null } } },
    });
  });
});
