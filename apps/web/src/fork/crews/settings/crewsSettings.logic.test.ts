import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { CrewSummary } from "@t3tools/contracts/fork/crews/crewFile";
import { CrewFile, CrewsToolboxFile } from "@t3tools/shared/fork/crews/crewFileSchema";
import { resolveRoleToolbox } from "@t3tools/shared/fork/crews/resolveRoleToolbox";
import { parseCrewsToolboxYaml } from "@t3tools/shared/fork/crews/parseCrewYaml";
import { deriveProviderInstanceEntries } from "../../../providerInstances";
import {
  CREWS_TOOLBOX_EXAMPLE,
  crewHomeLine,
  crewModelDisabledReason,
  crewModelsMixed,
  crewModelSource,
  crewOverrideScope,
  crewPath,
  crewsDirectory,
  crewSecretStatus,
  crewToolboxChips,
  diagnosticLocation,
  hasRepoToolbox,
  instructionMarkdown,
  orderedCrewRoles,
  referencedCrewSecrets,
  roleInstructions,
  safeInstructionPath,
  showsRepoToolbox,
  toolboxGrantCount,
} from "./crewsSettings.logic";

const crew = Schema.decodeUnknownSync(CrewFile)({
  version: 1,
  id: "feature-trio",
  name: "Feature trio",
  roles: {
    worker: {
      name: "Worker",
      instructions: "Work carefully",
      tags: ["worker"],
      skills: ["shared"],
      tools: ["missing"],
    },
    orchestrator: { name: "Orchestrator", instructions: "Delegate work" },
  },
  flow: { start: "done", steps: { done: { type: "end" } } },
});
const summary: CrewSummary = {
  id: crew.id,
  name: crew.name,
  path: "/custom/crews/feature-trio",
  roles: Object.entries(crew.roles).map(([id, role]) => ({
    id,
    name: role.name,
    tags: role.tags ?? [],
  })),
  home: { mode: "lead", roleId: "orchestrator", source: "auto" },
  status: "warnings",
  diagnosticCounts: { errors: 0, warnings: 1, info: 0 },
};

describe("home and role presentation", () => {
  it("puts an auto-detected lead first without mutating catalog order", () => {
    expect(crewHomeLine(summary, crew)).toBe(
      "Runs in your thread: Orchestrator (lead, auto-detected) · read-only",
    );
    expect(orderedCrewRoles(summary).map((role) => role.id)).toEqual(["orchestrator", "worker"]);
    expect(summary.roles[0]?.id).toBe("worker");
  });
  it("shows explicit lead edit access", () => {
    expect(
      crewHomeLine(
        { ...summary, home: { mode: "lead", roleId: "orchestrator", source: "explicit" } },
        { ...crew, home: { mode: "lead", role: "orchestrator", canEdit: true } },
      ),
    ).toBe("Runs in your thread: Orchestrator (lead) · can edit");
  });
  it.each(["auto", "explicit"] as const)(
    "shows the %s first-step role without lead permissions",
    (source) => {
      const first = { ...summary, home: { mode: "first-step" as const, roleId: "worker", source } };
      expect(crewHomeLine(first, crew)).toBe(
        `Runs in your thread: Worker (first step${source === "auto" ? ", auto-detected" : ""})`,
      );
      expect(orderedCrewRoles(first)).toEqual(summary.roles);
    },
  );
  it("handles a malformed crew without a home", () => {
    expect(crewHomeLine({ ...summary, home: null }, null)).toBe(
      "Runs in your thread: not resolved",
    );
  });
});

describe("settings scope and inheritance", () => {
  it.each(["all", "environment", "unavailable"] as const)("hides repo toolbox for %s", (scope) => {
    expect(showsRepoToolbox(scope)).toBe(false);
  });
  it.each(["project", "checkout"] as const)("shows repo toolbox for %s", (scope) => {
    expect(showsRepoToolbox(scope)).toBe(true);
  });
  it("routes writes to the selected project or environment without inventing a project", () => {
    expect(crewOverrideScope(null)).toEqual({ scope: "environment" });
    expect(crewOverrideScope(ProjectId.make("project-one"))).toEqual({
      scope: "project",
      projectId: "project-one",
    });
  });
  it("labels an inherited environment selection separately from a project override", () => {
    expect(crewModelSource("environment", true)).toBe("Inherited from All projects");
    expect(crewModelSource("environment", false)).toBe("All projects");
    expect(crewModelSource("project", true)).toBe("This project");
    expect(crewModelSource("crew-hint", true)).toBe("Crew default");
    expect(crewModelSource("composer", true)).toBe("Composer model");
  });
  it("treats accounts, traits, and inheritance differences as mixed", () => {
    const model = {
      selection: {
        instanceId: ProviderInstanceId.make("codex_work"),
        model: "gpt-test",
        options: [{ id: "effort", value: "high" }],
      },
      source: "environment" as const,
      warnings: [],
    };
    expect(crewModelsMixed([model, structuredClone(model)])).toBe(false);
    expect(
      crewModelsMixed([
        model,
        {
          ...model,
          selection: { ...model.selection, instanceId: ProviderInstanceId.make("codex_personal") },
        },
      ]),
    ).toBe(true);
    expect(
      crewModelsMixed([model, { ...model, selection: { ...model.selection, options: [] } }]),
    ).toBe(true);
    expect(crewModelsMixed([model, { ...model, source: "project" }])).toBe(true);
  });
});

describe("resolved toolbox chips", () => {
  const definition = (name: string, path: string) => ({ name, path, realPath: path });
  const decodeGrants = Schema.decodeUnknownSync(CrewsToolboxFile);
  const grants = decodeGrants({ version: 1, tags: { worker: { skills: ["storybook"] } } });
  const toolbox = {
    homeSkills: [definition("shared", "/home/skills/shared")],
    repoSkills: [
      definition("shared", "/repo/.t3/skills/shared"),
      definition("storybook", "/repo/.t3/skills/storybook"),
    ],
    grants,
    crewSource: { file: "/home/crews/feature-trio/crew.yaml" },
    grantsSource: { file: "/repo/.t3/crews.yaml" },
  };
  it("uses the server winner and names the losing path on a collision", () => {
    const extend = crewToolboxChips(resolveRoleToolbox(crew, "worker", toolbox, "extend"), true);
    const override = crewToolboxChips(
      resolveRoleToolbox(crew, "worker", toolbox, "override"),
      true,
    );
    expect(extend.find((chip) => chip.key === "skill:shared")?.label).toBe("shared · T3 home");
    const winner = override.find((chip) => chip.key === "skill:shared");
    expect(winner?.label).toBe("shared · repo");
    expect(winner?.warning).toBe(true);
    expect(winner?.tooltip).toContain("/home/skills/shared");
    expect(winner?.tooltip).toContain("/repo/.t3/skills/shared");
  });
  it("names the repo tag that granted a skill", () => {
    const chip = crewToolboxChips(resolveRoleToolbox(crew, "worker", toolbox), true).find(
      (chip) => chip.key === "skill:storybook",
    );
    expect(chip?.label).toBe("storybook · repo");
    expect(chip?.tooltip).toContain("tags.worker");
    expect(chip?.tooltip).toContain("/repo/.t3/crews.yaml");
  });
  it("keeps unresolved grants visible as warnings for a project", () => {
    const missing = crewToolboxChips(resolveRoleToolbox(crew, "worker", toolbox), true).find(
      (chip) => chip.key === "tool:missing",
    );
    expect(missing?.warning).toBe(true);
    expect(missing?.label).toBe("missing · not defined in this project");
    expect(missing?.tooltip).toContain("roles.worker.tools.0");
  });
  it("shows only home content for All projects, including role and crew-local skills", () => {
    const resolved = resolveRoleToolbox(crew, "worker", {
      ...toolbox,
      roleSkills: {
        worker: [
          definition("local-role", "/home/crews/feature-trio/roles/worker/skills/local-role"),
        ],
      },
      crewSkills: [definition("local-crew", "/home/crews/feature-trio/skills/local-crew")],
    });
    expect(crewToolboxChips(resolved, false).map((chip) => chip.label)).toEqual([
      "local-role · role",
      "local-crew · crew",
      "shared · T3 home",
    ]);
  });
  it("does not mistake another item's collision for this item's", () => {
    const chips = crewToolboxChips(resolveRoleToolbox(crew, "worker", toolbox), true);
    expect(chips.find((chip) => chip.key === "skill:storybook")?.warning).toBe(false);
  });
  it("counts grant selectors instead of the number of definitions or referenced tools", () => {
    expect(toolboxGrantCount(null)).toBe(0);
    expect(
      toolboxGrantCount({
        version: 1,
        tags: { worker: { tools: ["a", "b"] } },
        crews: { "*": { "*": { skills: ["x"] } }, "feature-trio": { worker: { tools: ["c"] } } },
      }),
    ).toBe(3);
  });
});

describe("paths and instructions", () => {
  it.each([
    ["/custom/t3/userdata/keybindings.json", "/custom/t3/crews"],
    ["/checkout/.t3/dev/keybindings.json", "/checkout/.t3/crews"],
    ["C:\\custom\\t3\\userdata\\keybindings.json", "C:\\custom\\t3\\crews"],
    ["\\\\host\\share\\t3\\userdata\\keybindings.json", "\\\\host\\share\\t3\\crews"],
  ])("derives the empty-state folder from server path %s", (path, expected) => {
    expect(crewsDirectory(path)).toBe(expected);
  });
  it("preserves Windows drive letters in diagnostic locations", () => {
    expect(
      diagnosticLocation({
        file: "C:\\t3\\crews\\crew.yaml",
        line: 17,
        column: 4,
        message: "Invalid role",
        path: [],
        severity: "error",
      }),
    ).toBe("C:\\t3\\crews\\crew.yaml:17:4");
    expect(crewPath("C:\\t3\\crews\\", "team/crew.yaml")).toBe("C:\\t3\\crews\\team\\crew.yaml");
  });
  it("supports inline instructions, explicit files and folder-first defaults", () => {
    expect(
      roleInstructions("worker", { name: "Worker", instructions: "Do the work.\nKeep it small." }),
    ).toEqual({ paths: [], text: "Do the work.\nKeep it small." });
    expect(
      roleInstructions("worker", { name: "Worker", instructions: "roles/custom.md" }).paths,
    ).toEqual(["roles/custom.md"]);
    expect(
      roleInstructions("worker", { name: "Worker", instructions: "file: roles/custom.md" }).paths,
    ).toEqual(["roles/custom.md"]);
    expect(roleInstructions("worker", { name: "Worker" }).paths).toEqual([
      "roles/worker/role.md",
      "roles/worker.md",
    ]);
    expect(instructionMarkdown("---\r\ndescription: Worker\r\n---\r\n# Work\nDo it")).toBe(
      "# Work\nDo it",
    );
    expect(instructionMarkdown("# Work\n---\nDo it")).toBe("# Work\n---\nDo it");
  });
  it("provides a valid commented toolbox example", () => {
    const parsed = parseCrewsToolboxYaml(CREWS_TOOLBOX_EXAMPLE);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.value).toEqual({ version: 1 });
  });
  it("keeps invalid instruction references from opening outside the crew", () => {
    expect(safeInstructionPath("../secret.md")).toBeNull();
    expect(safeInstructionPath("roles/../../secret.md")).toBeNull();
    expect(safeInstructionPath("C:\\private\\secret.md")).toBeNull();
    expect(safeInstructionPath("/private/secret.md")).toBeNull();
    expect(safeInstructionPath("./roles/worker/../worker.md")).toBe("roles/worker.md");
  });
});

describe("bulk model availability", () => {
  function provider(instanceId: string, enabled = true): ServerProvider {
    return {
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make("codex"),
      enabled,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-11T00:00:00Z",
      models: [],
      slashCommands: [],
      skills: [],
    };
  }
  const entries = deriveProviderInstanceEntries([
    provider("codex_work"),
    provider("codex_personal"),
  ]);
  const options = new Map(
    entries.map((entry) => [
      entry.instanceId,
      [{ slug: "gpt-test", name: "GPT test", provider: "codex" as const }],
    ]),
  );
  const selection = { instanceId: ProviderInstanceId.make("codex_personal"), model: "gpt-test" };
  it("keeps two accounts of the same provider selectable by exact instance", () => {
    expect(entries.map((entry) => entry.instanceId)).toEqual(["codex_work", "codex_personal"]);
    expect(
      crewModelDisabledReason(selection, entries, [{ label: "Desktop", entries, options }]),
    ).toBeNull();
  });
  it("refuses a bulk edit if only the other account exists on another machine", () => {
    expect(
      crewModelDisabledReason(selection, entries, [
        { label: "Remote", entries: entries.slice(0, 1), options },
      ]),
    ).toContain("Remote");
  });
  it("refuses a disabled account or unavailable model on any destination", () => {
    const disabled = deriveProviderInstanceEntries([provider("codex_personal", false)]);
    expect(
      crewModelDisabledReason(selection, entries, [
        { label: "Remote", entries: disabled, options },
      ]),
    ).toContain("Remote");
    const unavailable = new Map([
      [
        selection.instanceId,
        [{ slug: "gpt-test", name: "GPT test", provider: "codex" as const, isUnavailable: true }],
      ],
    ]);
    expect(
      crewModelDisabledReason(selection, entries, [
        { label: "Remote", entries, options: unavailable },
      ]),
    ).toContain("Remote");
  });
});

describe("repo toolbox and crew secrets", () => {
  const empty = {
    mode: "extend" as const,
    skills: [],
    mcp: { servers: {} },
    tools: { tools: {} },
    grants: null,
    diagnostics: [],
  };

  it("offers /crew-init setup only for a project with no toolbox content or diagnostics", () => {
    expect(hasRepoToolbox(empty)).toBe(false);
    expect(hasRepoToolbox({ ...empty, tools: { tools: { lint: { run: "pnpm lint" } } } })).toBe(
      true,
    );
    expect(hasRepoToolbox({ ...empty, grants: { version: 1 } })).toBe(true);
  });

  it("finds referenced secrets and which of them are not saved", () => {
    const referenced = referencedCrewSecrets({
      servers: {
        github: { command: "npx", env: { GITHUB_TOKEN: "${secret:GITHUB_TOKEN}", PORT: "3000" } },
        sentry: { command: "uvx", env: { AUTH: "Bearer ${secret:SENTRY} ${secret:GITHUB_TOKEN}" } },
        bare: { command: "tool" },
      },
    });
    expect(referenced).toEqual(["GITHUB_TOKEN", "SENTRY"]);
    // The server sends saved values as a redaction marker; an empty value is not saved.
    expect(crewSecretStatus({ SENTRY: "•••", OLD: "" }, referenced)).toEqual({
      saved: ["SENTRY"],
      missing: ["GITHUB_TOKEN"],
    });
  });
});
