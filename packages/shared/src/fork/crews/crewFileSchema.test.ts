// @effect-diagnostics nodeBuiltinImport:off - static fixtures and generated-schema snapshots.
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { parse, stringify } from "yaml";

import {
  buildCrewFileJsonSchema,
  buildCrewsToolboxJsonSchema,
  CrewFile,
  CrewMcpFile,
  CrewRoleFrontmatter,
  CrewStep,
  CrewToolsFile,
} from "./crewFileSchema.ts";
import { parseCrewYaml, parseCrewsToolboxYaml } from "./parseCrewYaml.ts";

const decodeStep = Schema.decodeUnknownSync(CrewStep);
const decodeStepStrict = Schema.decodeUnknownSync(CrewStep, { onExcessProperty: "error" });
const decodeCrew = Schema.decodeUnknownSync(CrewFile);
const decodeMcp = Schema.decodeUnknownSync(CrewMcpFile);
const decodeTools = Schema.decodeUnknownSync(CrewToolsFile);
const decodeFrontmatter = Schema.decodeUnknownSync(CrewRoleFrontmatter);
const fixture = (name: string) =>
  NodeFS.readFileSync(new URL(`./__fixtures__/${name}.yaml`, import.meta.url), "utf8");
const minimal = {
  version: 1,
  id: "example",
  name: "Example",
  roles: { worker: { name: "Worker" } },
  flow: {
    start: "work",
    steps: { work: { role: "worker", task: "Work", next: "done" }, done: { type: "end" } },
  },
};

describe("crew file v1", () => {
  it("decodes the section 5.1 fixture and normalizes legacy model options", () => {
    const result = parseCrewYaml(fixture("feature-trio"));
    expect(result.diagnostics).toEqual([]);
    expect(result.value?.roles.planner?.model?.options).toEqual([{ id: "effort", value: "high" }]);
    expect(result.value?.roles.implementer?.model?.options).toEqual([
      { id: "effort", value: "medium" },
    ]);
    expect(result.value?.flow.steps.plan?.type).toBe("task");
    expect(result.value?.flow.steps.review?.outcomes?.changes).toEqual({
      to: "fix",
      max: 3,
      else: "approval",
    });
    expect(result.value?.artifacts?.plan).toEqual({
      type: "object",
      schema: {
        tasks: {
          type: "list",
          item: { id: "string", title: "string", brief: "string", owns: "string[]" },
        },
      },
    });
  });

  it("decodes the section 5.7 lead-mode fixture", () => {
    const result = parseCrewYaml(fixture("full-stack"));
    expect(result.diagnostics).toEqual([]);
    expect(result.value?.home).toEqual({
      mode: "lead",
      role: "orchestrator",
      canEdit: false,
      updates: "milestones",
      decisionTimeoutMinutes: 30,
    });
    expect(result.value?.flow.steps.build).toMatchObject({
      type: "parallel",
      branches: ["ui", "api"],
    });
    expect(result.value?.flow.steps.triage).toMatchObject({ type: "gate", by: "lead" });
  });

  it("decodes the remaining authoring fields without filling runtime defaults", () => {
    const result = parseCrewYaml(
      stringify({
        ...minimal,
        home: { mode: "first-step" },
        inputs: {
          brief: { type: "text", required: true },
          enabled: { type: "boolean", default: false },
          target: { type: "enum", values: ["web", "server"] },
        },
        defaults: {
          runtimeMode: "inherit",
          interactionMode: "default",
          isolation: "worktree",
          maxParallel: 2,
          autoCommit: false,
          onNoReport: "ask",
        },
        limits: { maxCards: 60, maxHours: 8, maxFanoutItems: 12 },
        roles: {
          worker: {
            name: "Worker",
            pool: ["codex_work"],
            maxConcurrent: 2,
            owns: ["src/**"],
            persona: {
              identity: "Builder",
              communicationStyle: "Brief",
              principles: ["Test changes"],
              facts: ["file:README.md"],
            },
            model: {
              driver: "codex",
              model: "custom",
              instance: "codex_work",
              options: [{ id: "fastMode", value: true }],
            },
          },
        },
        artifacts: {
          result: { type: "list", item: { ok: "boolean", stats: { count: "number" } } },
          notes: { type: "markdown" },
        },
        skills: ["repo-conventions"],
        mcp: ["playwright"],
        tools: ["tests"],
      }),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.value?.roles.worker?.model?.options).toEqual([{ id: "fastMode", value: true }]);
    expect(result.value?.home).toEqual({ mode: "first-step" });
    expect(parseCrewYaml(stringify(minimal)).value?.limits).toBeUndefined();
  });

  it.each([
    {
      type: "task",
      role: "worker",
      task: "Build",
      continue: "same-thread",
      consumes: ["plan"],
      produces: ["code"],
      owns: ["src/**"],
      next: { to: "review", max: 2, else: "done", resetOn: [], label: "Build retries" },
    },
    { type: "parallel", branches: ["a", "b"], join: "any", isolation: "shared", owns: ["src/**"] },
    {
      type: "fanout",
      role: "worker",
      task: "{{item.title}}",
      over: "artifacts.plan.tasks",
      owns: "{{item.owns}}",
      maxParallel: 3,
      join: "all",
    },
    { type: "merge", onConflict: "gate", checkOwnership: "block" },
    { type: "script", tool: "unit-tests", outcomes: { pass: "done", fail: "fix" } },
    { type: "script", run: "vp test run", timeoutMinutes: 10 },
    { type: "gate", prompt: "Ship?", outcomes: { yes: "done" } },
    { type: "end", status: "failed" },
  ])("decodes $type step fields", (step) => {
    expect(decodeStep(step)).toEqual(step);
  });

  it.each([
    { ...minimal, version: 2 },
    { ...minimal, version: undefined },
    { ...minimal, id: "1bad" },
    { ...minimal, id: "a".repeat(65) },
    { ...minimal, roles: {} },
    { ...minimal, roles: { worker: { name: "Worker", tags: ["not a slug"] } } },
    { ...minimal, limits: { maxCards: 0 } },
    { ...minimal, limits: { maxHours: 0 } },
    { ...minimal, defaults: { maxParallel: 1.5 } },
    { ...minimal, home: { mode: "lead" } },
    { ...minimal, home: { mode: "first-step", canEdit: true } },
    { ...minimal, unknown: true },
  ])("rejects malformed crew shape %# with located diagnostics", (input) => {
    const result = parseCrewYaml(stringify(input));
    expect(result.value).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.file).toBe("crew.yaml");
      expect(diagnostic.line).toBeGreaterThanOrEqual(1);
      expect(diagnostic.column).toBeGreaterThanOrEqual(1);
    }
  });

  it.each([
    { type: "script" },
    { type: "script", tool: "tests", run: "echo duplicate" },
    { type: "fanout", role: "worker", task: "Work" },
    { type: "parallel", branches: [] },
    { role: "worker", task: "Work", next: { to: "fix", max: 0, else: "done" } },
    { role: "worker", task: "Work", next: { to: "fix", max: 3 } },
    { type: "gate", prompt: "Ship?", outcomes: {} },
  ])("rejects malformed step %#", (step) => {
    expect(() => decodeStepStrict(step)).toThrow();
  });

  it("leaves reference and graph validation to phase 2", () => {
    const result = parseCrewYaml(
      stringify({
        ...minimal,
        flow: {
          start: "missing",
          steps: { work: { role: "unknown", task: "{{unknown}}", next: "work" } },
        },
      }),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.value).not.toBeNull();
  });
});

describe("toolbox and ancillary files", () => {
  it("decodes section 4.3 with exact, tag, crew-wide and global grants", () => {
    const result = parseCrewsToolboxYaml(fixture("crews"));
    expect(result.diagnostics).toEqual([]);
    expect(result.value?.tags?.worker).toEqual({
      tools: ["unit-tests"],
      skills: ["repo-conventions"],
    });
    expect(result.value?.crews?.["feature-trio"]?.implementer).toEqual({
      mcp: ["storybook"],
      tools: ["e2e"],
    });
    expect(result.value?.crews?.["*"]?.["*"]).toEqual({ tools: ["lint"] });
  });

  it.each([
    "version: 1\ncrews:\n  '*':\n    worker: {tools: [lint]}\n",
    "version: 1\ntags:\n  worker: {exclude: [lint]}\n",
    "version: 1\ntags:\n  worker: {tools: lint}\n",
    "version: 2\n",
  ])("rejects invalid toolbox grants with positions", (text) => {
    const result = parseCrewsToolboxYaml(text);
    expect(result.value).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(
      result.diagnostics.every((d) => d.file === ".t3/crews.yaml" && d.line >= 1 && d.column >= 1),
    ).toBe(true);
  });

  it("accepts empty v1 grants and unknown crew/tag references", () => {
    expect(parseCrewsToolboxYaml("version: 1\n").value).toEqual({ version: 1 });
    expect(
      parseCrewsToolboxYaml(
        "version: 1\ntags:\n  future: {tools: [uninstalled]}\ncrews:\n  future:\n    newRole: {}\n",
      ).diagnostics,
    ).toEqual([]);
  });

  it("decodes MCP and tool definitions without resolving secrets or running commands", () => {
    const mcp = {
      servers: {
        playwright: {
          command: "npx",
          args: ["@playwright/mcp@latest"],
          env: { TOKEN: "${secret:TOKEN}" },
        },
      },
    };
    const tools = {
      tools: {
        "unit-tests": { description: "Run unit tests", run: "vp test run", timeoutSeconds: 600 },
      },
    };
    expect(decodeMcp(mcp)).toEqual(mcp);
    expect(decodeTools(tools)).toEqual(tools);
    expect(() =>
      decodeTools({
        tools: { bad: { run: "echo test", timeoutSeconds: 0 } },
      }),
    ).toThrow();
    expect(() =>
      decodeMcp({
        servers: { bad: { command: "npx", env: { TOKEN: 42 } } },
      }),
    ).toThrow();
  });

  it("accepts copied role frontmatter without turning provider tools into crew grants", () => {
    const frontmatter = parse(
      "name: Reviewer\ndescription: Reviews code\nmodel: sonnet\ntools: Read, Grep\ncolor: blue\n",
    );
    expect(decodeFrontmatter(frontmatter)).toEqual({
      name: "Reviewer",
      description: "Reviews code",
      model: "sonnet",
      tools: "Read, Grep",
    });
    expect(
      decodeFrontmatter({
        model: { driver: "codex", model: "custom", options: { effort: "high" } },
        tools: ["Read"],
      }),
    ).toMatchObject({ model: { options: [{ id: "effort", value: "high" }] } });
  });
});

describe("YAML diagnostics", () => {
  it("locates nested schema errors at the value node", () => {
    const result = parseCrewsToolboxYaml("version: 1\ntags:\n  worker:\n    tools: false\n");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ path: ["tags", "worker", "tools"], line: 4, column: 12 }),
    );
  });

  it("locates a missing property at its containing node", () => {
    const result = parseCrewYaml(
      "version: 1\nid: test\nname: Test\nroles:\n  worker:\n    description: Missing name\nflow:\n  start: done\n  steps:\n    done: {type: end}\n",
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ path: ["roles", "worker", "name"], line: 6, column: 5 }),
    );
  });

  it.each([parseCrewYaml, parseCrewsToolboxYaml])(
    "returns syntax errors without throwing",
    (parseFile) => {
      const result = parseFile("version: 1\nroles: [\n");
      expect(result.value).toBeNull();
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(
        result.diagnostics.every(
          (d) => d.line >= 2 && d.column >= 1 && d.message.includes("Invalid YAML (code="),
        ),
      ).toBe(true);
    },
  );

  it("rejects duplicate keys and multiple documents", () => {
    for (const text of ["version: 1\nversion: 1\n", "version: 1\n---\nversion: 1\n"]) {
      expect(parseCrewsToolboxYaml(text).value).toBeNull();
    }
  });

  it("reports warnings and alias conversion failures with positions", () => {
    const warning = parseCrewsToolboxYaml("version: !!unknown 1\n");
    expect(warning.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "warning", line: 1 }),
    );
    const alias = parseCrewsToolboxYaml("version: 1\ntags: *missing\n");
    expect(alias.value).toBeNull();
    expect(alias.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        line: expect.any(Number),
        column: expect.any(Number),
      }),
    );
  });

  it("reports an empty document at line 1, column 1", () => {
    const result = parseCrewYaml("");
    expect(result.value).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ line: 1, column: 1 });
  });
});

describe("published schemas (AC 12)", () => {
  it("preserves slug constraints and optional wildcard grants for editors", () => {
    expect(buildCrewFileJsonSchema()).toMatchObject({
      properties: { id: { pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$", maxLength: 64 } },
    });
    const toolbox = buildCrewsToolboxJsonSchema() as {
      properties: { crews: { additionalProperties: { required?: string[] } } };
    };
    expect(toolbox.properties.crews.additionalProperties.required ?? []).not.toContain("*");
  });

  it.each([
    ["crew", buildCrewFileJsonSchema],
    ["crews-toolbox", buildCrewsToolboxJsonSchema],
  ] as const)("keeps %s.json current", (name, build) => {
    const committed = JSON.parse(
      NodeFS.readFileSync(
        new URL(`../../../../../docs/fork/schema/${name}.json`, import.meta.url),
        "utf8",
      ),
    );
    expect(committed, "Schema is stale. Run: node scripts/fork/generate-crew-schema.ts").toEqual(
      build(),
    );
  });

  it("publishes v1 as required and allows omitted task type in authoring", () => {
    expect(buildCrewFileJsonSchema()).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      required: expect.arrayContaining(["version", "roles", "flow"]),
    });
    expect(decodeCrew(minimal).flow.steps.work?.type).toBe("task");
  });
});
