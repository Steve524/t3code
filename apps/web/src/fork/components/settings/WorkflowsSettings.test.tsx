import {
  DEFAULT_UNIFIED_SETTINGS,
  ProviderInstanceId,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { BUILT_IN_RESEARCH_PLAN_WORKFLOW, BUILT_IN_TEAM_WORKFLOW } from "@t3tools/shared/team";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ScopedSettingsPatch } from "../../../components/settings/scopedSettings";

const state = vi.hoisted(() => ({
  settings: undefined as unknown as UnifiedSettings,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

const instanceId = ProviderInstanceId.make("codex");

vi.mock("../../../providerInstances", () => ({
  applyProviderInstanceSettings: (entries: ReadonlyArray<unknown>) => entries,
  deriveProviderInstanceEntries: () => [
    {
      instanceId: "codex",
      driverKind: "codex",
      displayName: "Codex",
      models: [],
    },
  ],
  sortProviderInstanceEntries: (entries: ReadonlyArray<unknown>) => entries,
  resolveDefaultProviderModelSelection: (
    _providers: ReadonlyArray<unknown>,
    selection: { instanceId: string; model: string; options?: ReadonlyArray<unknown> } | null,
  ) => selection ?? { instanceId: "codex", model: "gpt-host" },
}));
vi.mock("../../../modelSelection", () => ({
  getCustomModelOptionsByInstance: () => new Map([["codex", []]]),
}));
vi.mock("../../../components/settings/useScopedSettings", () => ({
  useScopedSettings: () => state.settings,
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock("../../../components/settings/SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment", environmentIds: ["test"] },
    environment: { serverConfig: { providers: [{}] } },
  }),
}));
vi.mock("../../../components/chat/ProviderModelPicker", () => ({
  ProviderModelPicker: (props: {
    triggerAriaLabel: string;
    model: string;
    onInstanceModelChange: (instanceId: string, model: string) => void;
  }) => (
    <button
      aria-label={props.triggerAriaLabel}
      data-model={props.model}
      onClick={() => props.onInstanceModelChange("codex", "gpt-test")}
    />
  ),
}));
vi.mock("../../../components/chat/TraitsPicker", () => ({
  TraitsPicker: (props: {
    onModelOptionsChange: (options: ReadonlyArray<{ id: string; value: string }>) => void;
  }) => (
    <button
      aria-label="Model effort"
      onClick={() => props.onModelOptionsChange([{ id: "reasoningEffort", value: "high" }])}
    />
  ),
}));
vi.mock("../../../components/settings/settingsSearch", () => ({
  searchableSetting: (id: string) => ({ id, title: id }),
}));
vi.mock("../../../components/settings/settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children: ReactNode;
    headerAction?: ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({
    children,
    control,
    resetAction,
  }: {
    children?: ReactNode;
    control?: ReactNode;
    resetAction?: ReactNode;
  }) => (
    <div>
      {control}
      {resetAction}
      {children}
    </div>
  ),
  SettingResetButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button onClick={onClick}>{`Reset ${label}`}</button>
  ),
}));
vi.mock("../../../components/settings/SettingsScopeNotice", () => ({
  SettingsScopeNotice: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: ComponentProps<"button">) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("../../../components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => children,
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  CollapsiblePanel: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../components/ui/number-field", () => ({
  NumberField: ({
    children,
    value,
    onValueCommitted,
  }: {
    children: ReactNode;
    value: number;
    onValueCommitted: (value: number) => void;
  }) => (
    <div>
      <input
        aria-label="Limit"
        value={value}
        onChange={(event) => onValueCommitted(Number(event.target.value))}
      />
      {children}
    </div>
  ),
  NumberFieldGroup: ({ children }: { children: ReactNode }) => children,
  NumberFieldInput: () => <input />,
}));
vi.mock("../../../components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
    value,
  }: {
    children: ReactNode;
    onValueChange: (value: string) => void;
    value: string;
  }) => (
    <div>
      <select
        aria-label="Select value"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      />
      {["same-as-orchestrator", "full-access", "approval-required"].includes(value) ? (
        <button
          aria-label="Use inherited permissions"
          onClick={() => onValueChange("same-as-orchestrator")}
        />
      ) : null}
      {children}
    </div>
  ),
  SelectItem: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  SelectPopup: ({ children }: { children: ReactNode }) => children,
  SelectTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  SelectValue: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../components/ui/switch", () => ({
  Switch: () => <input type="checkbox" />,
}));
vi.mock("../../../components/ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../../../components/ui/input", () => ({ Input: "input" }));

import {
  readOnlyPermissionLabel,
  shouldSuggestIndependentQa,
  WorkflowsSettingsPanel,
} from "./WorkflowsSettings";

let renderer: ReactTestRenderer | null;

function renderPanel() {
  act(() => {
    renderer = create(<WorkflowsSettingsPanel />);
  });
}

function rerenderPanel() {
  act(() => renderer!.update(<WorkflowsSettingsPanel />));
}

function buttonByLabel(label: string) {
  return renderer!.root.findAllByType("button").find((item) => item.props["aria-label"] === label)!;
}

function buttonByText(text: string) {
  return renderer!.root.findAllByType("button").find((item) => item.children.includes(text))!;
}

function frontendRole() {
  return state.settings.teamWorkflows[0]!.roles.find(({ id }) => id === "frontend")!;
}

function selectPreset(id: string) {
  act(() => renderer!.root.findAllByType("select")[0]!.props.onChange({ target: { value: id } }));
}

function folderInput(label: string) {
  return renderer!.root
    .findAllByType("input")
    .find((input) => input.props["aria-label"] === label)!;
}

function editFolder(label: string, value: string) {
  act(() => folderInput(label).props.onBlur({ currentTarget: { value } }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    teamWorkflows: [BUILT_IN_TEAM_WORKFLOW],
  };
  state.updateSettings.mockReset().mockImplementation((patch) => {
    if (patch.teamWorkflows)
      state.settings = { ...state.settings, teamWorkflows: patch.teamWorkflows };
  });
  renderPanel();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("workflow settings", () => {
  it("selects Research & plan, shows read-only labels, and saves its roles and limits independently", () => {
    selectPreset(BUILT_IN_RESEARCH_PLAN_WORKFLOW.id);
    expect(
      renderer!.root
        .findAllByType("p")
        .filter((p) =>
          p.children.includes("Read-only: enforced on Claude, isolated worktree elsewhere"),
        ),
    ).toHaveLength(2);
    expect(buttonByLabel("Use inherited permissions")).toBeUndefined();
    expect(renderer!.root.findAllByType("select")).toHaveLength(1);
    act(() => buttonByLabel("Researcher model").props.onClick());
    rerenderPanel();
    expect(
      renderer!.root
        .findAllByType("p")
        .some((p) => p.children.includes("Read-only not enforced on Codex (isolated worktree)")),
    ).toBe(true);
    act(() =>
      renderer!.root
        .findAllByType("input")
        .find((input) => input.props["aria-label"] === "Limit")!
        .props.onChange({ target: { value: "3" } }),
    );
    const saved = state.settings.teamWorkflows.find(
      ({ id }) => id === BUILT_IN_RESEARCH_PLAN_WORKFLOW.id,
    )!;
    expect(saved.roles[0]!.modelSelection).toEqual({ instanceId, model: "gpt-test" });
    expect(saved.maxParallelWorkers).toBe(3);
    expect(state.settings.teamWorkflows[0]).toEqual(BUILT_IN_TEAM_WORKFLOW);
    selectPreset(BUILT_IN_TEAM_WORKFLOW.id);
    expect(folderInput("Plans folder")).toBeUndefined();
    expect(buttonByLabel("Frontend model")).toBeDefined();
  });

  it("persists both artifact folders across a reload and restores only the selected preset", async () => {
    state.settings = {
      ...state.settings,
      teamWorkflows: [{ ...BUILT_IN_TEAM_WORKFLOW, maxParallelWorkers: 9 }],
    };
    rerenderPanel();
    selectPreset(BUILT_IN_RESEARCH_PLAN_WORKFLOW.id);
    expect(folderInput("Plans folder").props.defaultValue).toBe("docs/plans");
    expect(folderInput("Research folder").props.defaultValue).toBe("docs/research");
    editFolder("Plans folder", " notes/plans ");
    rerenderPanel();
    editFolder("Research folder", "notes/research");
    await act(async () => renderer?.unmount());
    renderPanel();
    selectPreset(BUILT_IN_RESEARCH_PLAN_WORKFLOW.id);
    expect(folderInput("Plans folder").props.defaultValue).toBe("notes/plans");
    expect(folderInput("Research folder").props.defaultValue).toBe("notes/research");
    act(() => buttonByText("Restore built-in preset").props.onClick());
    rerenderPanel();
    expect(folderInput("Plans folder").props.defaultValue).toBe("docs/plans");
    expect(state.settings.teamWorkflows).toEqual([
      { ...BUILT_IN_TEAM_WORKFLOW, maxParallelWorkers: 9 },
      BUILT_IN_RESEARCH_PLAN_WORKFLOW,
    ]);
  });

  it("rejects invalid folders without saving and lets the user correct them", () => {
    selectPreset(BUILT_IN_RESEARCH_PLAN_WORKFLOW.id);
    for (const invalid of ["", "../outside", "C:\\plans"]) {
      editFolder("Plans folder", invalid);
      expect(folderInput("Plans folder").props["aria-invalid"]).toBe(true);
      expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain(
        "relative folder",
      );
      expect(state.updateSettings).not.toHaveBeenCalled();
    }
    editFolder("Plans folder", "notes/plans");
    expect(folderInput("Plans folder").props["aria-invalid"]).toBe(false);
    expect(state.settings.teamWorkflows[1]!.plansDir).toBe("notes/plans");
  });

  it("labels read-only roles by whether their provider enforces read-only", () => {
    expect(
      readOnlyPermissionLabel({ driverKind: "claudeAgent" as never, displayName: "Claude" }),
    ).toBe("Read-only (enforced)");
    expect(readOnlyPermissionLabel({ driverKind: "codex" as never, displayName: "work1" })).toBe(
      "Read-only not enforced on work1 (isolated worktree)",
    );
    // "Same as host": the planner's provider is only known when a thread starts.
    expect(readOnlyPermissionLabel(undefined)).toBe(
      "Read-only: enforced on Claude, isolated worktree elsewhere",
    );
  });

  it("suggests an independent QA provider for the built-in inherited models", () => {
    expect(
      shouldSuggestIndependentQa(
        BUILT_IN_TEAM_WORKFLOW,
        (selection) => selection?.instanceId ?? "same-as-host",
      ),
    ).toBe(true);
  });

  it("persists a role model and effort across a reload, then stores null for Same as host", async () => {
    act(() => buttonByLabel("Frontend model").props.onClick());
    expect(frontendRole().modelSelection).toEqual({ instanceId, model: "gpt-test" });

    rerenderPanel();
    act(() => buttonByLabel("Model effort").props.onClick());
    expect(frontendRole().modelSelection).toEqual({
      instanceId,
      model: "gpt-test",
      options: [{ id: "reasoningEffort", value: "high" }],
    });

    await act(async () => renderer?.unmount());
    renderPanel();
    expect(buttonByLabel("Frontend model").props["data-model"]).toBe("gpt-test");

    act(() => buttonByText("Same as host").props.onClick());
    expect(frontendRole().modelSelection).toBeNull();
  });

  it("restores the built-in preset", () => {
    state.settings = {
      ...state.settings,
      teamWorkflows: [{ ...BUILT_IN_TEAM_WORKFLOW, maxParallelWorkers: 9 }],
    };
    rerenderPanel();

    act(() => buttonByText("Restore built-in preset").props.onClick());

    expect(state.settings.teamWorkflows).toEqual([BUILT_IN_TEAM_WORKFLOW]);
  });

  it("stores null for Same as orchestrator", () => {
    state.settings = {
      ...state.settings,
      teamWorkflows: [
        {
          ...BUILT_IN_TEAM_WORKFLOW,
          roles: BUILT_IN_TEAM_WORKFLOW.roles.map((role) =>
            role.id === "frontend" ? { ...role, runtimeMode: "full-access" } : role,
          ),
        },
      ],
    };
    rerenderPanel();

    act(() => buttonByLabel("Use inherited permissions").props.onClick());

    expect(frontendRole().runtimeMode).toBeNull();
  });
});
