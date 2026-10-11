import { describe, expect, it } from "vite-plus/test";

import type { ModelSelection } from "../../../../contracts/src/modelSelection.ts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
} from "../../../../contracts/src/providerInstance.ts";
import { decodeCrew, example, worker } from "./crewTestFixtures.ts";
import {
  resolveRoleModel,
  resolveRoleRuntimeMode,
  type CrewUsableProvider,
} from "./resolveRoleModel.ts";

const provider = (instanceId: string, driver: string, ...models: string[]): CrewUsableProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  models,
});
const selection = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});
const crewWith = (role: Record<string, unknown>, defaults?: Record<string, unknown>) =>
  decodeCrew({
    ...example,
    roles: { worker: { ...worker, ...role } },
    ...(defaults && { defaults }),
  });

const providers = [
  provider("codex-work", "codex", "gpt-5.6-terra", "gpt-5.6-luna"),
  provider("codex-personal", "codex", "gpt-5.6-terra"),
  provider("claude", "claudeAgent", "claude-opus-5-5"),
];
const hinted = crewWith({ model: { driver: "codex", model: "gpt-5.6-terra" } });
const run = selection("claude", "claude-opus-5-5");
const project = selection("codex-personal", "gpt-5.6-terra");
const environment = selection("codex-work", "gpt-5.6-luna");
const composer = selection("claude", "claude-opus-5-5");

describe("role model resolution", () => {
  it.each([
    {
      name: "run override first",
      input: { runOverride: run, projectOverride: project, environmentOverride: environment },
      expected: [run, "run"],
    },
    {
      name: "AC 5 project override over environment override",
      input: { projectOverride: project, environmentOverride: environment },
      expected: [project, "project"],
    },
    {
      name: "AC 5 environment override where the project has none",
      input: { environmentOverride: environment },
      expected: [environment, "environment"],
    },
    {
      name: "AC 4 first matching instance in picker order for a crew hint",
      input: {},
      expected: [selection("codex-work", "gpt-5.6-terra"), "crew-hint"],
    },
  ])("uses the $name", ({ input, expected }) => {
    const result = resolveRoleModel(hinted, "worker", {
      ...input,
      composerSelection: composer,
      providers,
    });
    expect([result.selection, result.source]).toEqual(expected);
    expect(result.warnings).toEqual([]);
  });

  it("AC 6 falls through to the composer with a warning when no instance offers the hint", () => {
    const crew = crewWith({ model: { driver: "codex", model: "gpt-9" } });
    const result = resolveRoleModel(crew, "worker", { composerSelection: composer, providers });
    expect([result.selection, result.source]).toEqual([composer, "composer"]);
    expect(result.warnings).toEqual([expect.stringContaining("codex/gpt-9")]);
  });

  it("skips an override whose instance is not usable and says so", () => {
    const result = resolveRoleModel(hinted, "worker", {
      projectOverride: selection("signed-out", "gpt-5.6-terra"),
      environmentOverride: selection("codex-work", "not-a-model"),
      providers,
    });
    expect(result.source).toBe("crew-hint");
    expect(result.warnings).toEqual([
      expect.stringContaining("project override signed-out/gpt-5.6-terra"),
      expect.stringContaining("environment override codex-work/not-a-model"),
    ]);
  });

  it("prefers the hint's exact instance and carries its options", () => {
    const crew = crewWith({
      model: {
        driver: "codex",
        model: "gpt-5.6-terra",
        instance: "codex-personal",
        options: { effort: "high" },
      },
    });
    expect(resolveRoleModel(crew, "worker", { providers }).selection).toEqual({
      instanceId: "codex-personal",
      model: "gpt-5.6-terra",
      options: [{ id: "effort", value: "high" }],
    });
  });

  it("reports the composer source with no selection when nothing applies", () => {
    expect(resolveRoleModel(crewWith({}), "worker", { providers })).toEqual({
      selection: null,
      source: "composer",
      warnings: [],
    });
  });
});

describe("role runtime mode resolution", () => {
  const fullAccess = crewWith({ runtimeMode: "full-access" });

  it.each([
    {
      name: "run override first",
      crew: fullAccess,
      input: { runOverride: "auto", projectOverride: "full-access" },
      expected: { runtimeMode: "auto", source: "run", clamped: false },
    },
    {
      name: "project override over environment override",
      crew: fullAccess,
      input: { projectOverride: "auto-accept-edits", environmentOverride: "full-access" },
      expected: { runtimeMode: "auto-accept-edits", source: "project", clamped: false },
    },
    {
      name: "an override broader than the run, because the user raised it",
      crew: fullAccess,
      input: { environmentOverride: "full-access", startingRuntimeMode: "approval-required" },
      expected: { runtimeMode: "full-access", source: "environment", clamped: false },
    },
    {
      name: "the crew file's mode clamped to the run's starting mode",
      crew: fullAccess,
      input: { startingRuntimeMode: "auto-accept-edits" },
      expected: { runtimeMode: "auto-accept-edits", source: "crew-hint", clamped: true },
    },
    {
      name: "the crew file's mode when it is narrower than the run",
      crew: crewWith({ runtimeMode: "approval-required" }),
      input: { startingRuntimeMode: "full-access" },
      expected: { runtimeMode: "approval-required", source: "crew-hint", clamped: false },
    },
    {
      name: "crew defaults when the role sets none",
      crew: crewWith({}, { runtimeMode: "auto-accept-edits" }),
      input: {},
      expected: { runtimeMode: "auto-accept-edits", source: "crew-hint", clamped: false },
    },
    {
      name: "the run's starting mode for inherit",
      crew: crewWith({ runtimeMode: "inherit" }, { runtimeMode: "full-access" }),
      input: { startingRuntimeMode: "auto" },
      expected: { runtimeMode: "auto", source: "inherit", clamped: false },
    },
    {
      name: "inherit until a run starts",
      crew: crewWith({}),
      input: {},
      expected: { runtimeMode: "inherit", source: "inherit", clamped: false },
    },
  ] as const)("uses $name", ({ crew, input, expected }) => {
    expect(resolveRoleRuntimeMode(crew, "worker", input)).toEqual(expected);
  });
});
