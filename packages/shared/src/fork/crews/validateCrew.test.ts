import { describe, expect, it } from "vite-plus/test";
import { parse, stringify } from "yaml";

import { ProviderDriverKind } from "../../../../contracts/src/providerInstance.ts";
import { detectCrewHome } from "./crewHome.ts";
import {
  decodeCrew,
  definition,
  end,
  example,
  task,
  validationContext,
  withSteps,
  worker,
} from "./crewTestFixtures.ts";
import { parseCrewYaml } from "./parseCrewYaml.ts";
import { validateCrew, type CrewValidationContext } from "./validateCrew.ts";

const validate = (input: unknown, context: Partial<CrewValidationContext> = {}) =>
  validateCrew(input, {
    ...validationContext,
    source: { file: "/crews/example/crew.yaml", text: stringify(input) },
    ...context,
  });
const leadHome = { mode: "lead", role: "lead" };
const leadRoles = { worker, lead: worker };
const parallel = (
  left: Record<string, unknown> = {},
  right: Record<string, unknown> = {},
  group: Record<string, unknown> = {},
) =>
  withSteps({
    work: { ...task, next: "build" },
    build: { type: "parallel", branches: ["left", "right"], next: "done", ...group },
    left: { ...task, ...left },
    right: { ...task, ...right },
    done: end,
  });

describe("crew validation errors", () => {
  const cases = [
    { name: "unknown version", input: { ...example, version: 2 }, path: ["version"] },
    { name: "schema failure", input: { ...example, name: 123 }, path: ["name"] },
    {
      name: "directory mismatch",
      input: { ...example, id: "different" },
      message: "must match directory",
    },
    {
      name: "missing start",
      input: { ...example, flow: { steps: example.flow.steps } },
      path: ["flow", "start"],
    },
    {
      name: "unknown start",
      input: { ...example, flow: { ...example.flow, start: "missing" } },
      message: 'Unknown step "missing"',
    },
    {
      name: "non-task first step",
      input: withSteps({
        work: { type: "gate", prompt: "Go?", outcomes: { yes: "done" } },
        done: end,
      }),
      message: "requires flow.start to name a task",
    },
    { name: "missing lead role", input: { ...example, home: { mode: "lead" } }, path: ["home"] },
    {
      name: "unknown lead role",
      input: { ...example, home: { mode: "lead", role: "missing" } },
      message: "Unknown home role",
    },
    {
      name: "ambiguous auto home, AC 10",
      input: { ...example, roles: { ...leadRoles, orchestrator: worker } },
      message: "Set home explicitly",
    },
    {
      name: "first-step lead gate, AC 11",
      input: withSteps({
        work: { ...task, next: "gate" },
        gate: { type: "gate", by: "lead", prompt: "Go?", outcomes: { yes: "done" } },
        done: end,
      }),
      message: "requires lead home mode",
    },
    ...["canEdit", "updates", "decisionTimeoutMinutes"].map((key) => ({
      name: `first-step rejects home.${key}`,
      input: {
        ...example,
        home: {
          mode: "first-step",
          [key]: key === "canEdit" ? false : key === "updates" ? "decisions" : 30,
        },
      },
      path: ["home"],
    })),
    {
      name: "lead fanout",
      input: withSteps(
        {
          work: { ...task, next: "build" },
          build: { ...task, type: "fanout", role: "lead", over: "artifacts.items", next: "done" },
          done: end,
        },
        {
          roles: leadRoles,
          home: leadHome,
          artifacts: { items: { type: "list", item: "string" } },
        },
      ),
      message: "cannot run in fanout",
    },
    {
      name: "lead parallel branch",
      input: { ...parallel({ role: "lead" }), roles: leadRoles, home: leadHome },
      message: "cannot run in fanout or parallel",
    },
    {
      name: "lead later in a parallel branch",
      input: withSteps(
        {
          work: { ...task, next: "build" },
          build: { type: "parallel", branches: ["a", "b"], next: "done" },
          a: { ...task, next: "later" },
          later: { ...task, role: "lead" },
          b: task,
          done: end,
        },
        { roles: leadRoles, home: leadHome },
      ),
      message: "cannot run in fanout or parallel",
    },
    {
      name: "unknown task role",
      input: withSteps({ work: { ...task, role: "missing", next: "done" }, done: end }),
      message: 'Unknown role "missing"',
    },
    {
      name: "unknown conflict role",
      input: withSteps({
        work: { ...task, next: "merge" },
        merge: { type: "merge", onConflict: { role: "missing" }, next: "done" },
        done: end,
      }),
      message: 'Unknown role "missing"',
    },
    {
      name: "unknown next",
      input: withSteps({ work: { ...task, next: "missing" } }),
      message: 'Unknown step "missing"',
    },
    {
      name: "unknown outcome",
      input: withSteps({ work: { ...task, outcomes: { yes: "missing" } } }),
      message: 'Unknown step "missing"',
    },
    {
      name: "unknown branch",
      input: parallel({}, {}, { branches: ["left", "missing"] }),
      message: 'Unknown step "missing"',
    },
    ...["produces", "consumes"].map((key) => ({
      name: `unknown ${key} artifact`,
      input: withSteps({ work: { ...task, [key]: ["missing"], next: "done" }, done: end }),
      message: 'Unknown artifact "missing"',
    })),
    {
      name: "missing script tool, AC 14",
      input: withSteps({
        work: { ...task, next: "test" },
        test: { type: "script", tool: "unit-tests", next: "done" },
        done: end,
      }),
      message: 'Script tool "unit-tests" is not defined',
    },
    {
      name: "no role instructions",
      input: { ...example, roles: { worker: { name: "Worker" } } },
      message: "has no instructions",
    },
    {
      name: "unreachable step",
      input: withSteps({ ...example.flow.steps, unused: task }),
      message: 'Step "unused" is unreachable',
    },
    {
      name: "no path to end",
      input: withSteps({ work: task }),
      message: "No path from flow.start to an end",
    },
    {
      name: "unlimited cycle, AC 2",
      input: withSteps({
        work: { ...task, next: "review" },
        review: { ...task, outcomes: { changes: "fix", approve: "done" } },
        fix: { ...task, next: "review" },
        done: end,
      }),
      message: "Unlimited cycle: review -> fix -> review",
    },
    {
      name: "max below one",
      input: withSteps({
        work: { ...task, next: { to: "work", max: 0, else: "done" } },
        done: end,
      }),
      path: ["flow", "steps", "work"],
    },
    {
      name: "unknown limited to",
      input: withSteps({
        work: { ...task, next: { to: "missing", max: 1, else: "done" } },
        done: end,
      }),
      message: 'Unknown step "missing"',
    },
    {
      name: "unknown limited else",
      input: withSteps({ work: { ...task, next: { to: "work", max: 1, else: "missing" } } }),
      message: 'Unknown step "missing"',
    },
    {
      name: "unknown resetOn",
      input: withSteps({
        work: { ...task, next: { to: "work", max: 1, else: "done", resetOn: ["missing"] } },
        done: end,
      }),
      message: 'Unknown step "missing"',
    },
    ...["maxCards", "maxHours", "maxFanoutItems"].map((key) => ({
      name: `limits.${key} below one`,
      input: { ...example, limits: { [key]: 0 } },
      path: ["limits", key],
    })),
    {
      name: "unknown fanout artifact",
      input: withSteps({
        work: { ...task, next: "build" },
        build: { ...task, type: "fanout", over: "artifacts.missing", next: "done" },
        done: end,
      }),
      message: "must reference a list",
    },
    {
      name: "non-list fanout",
      input: withSteps(
        {
          work: { ...task, next: "build" },
          build: { ...task, type: "fanout", over: "artifacts.note", next: "done" },
          done: end,
        },
        { artifacts: { note: { type: "text" } } },
      ),
      message: "must reference a list",
    },
    {
      name: "unknown template key",
      input: withSteps({ work: { ...task, task: "{{inputs.missing}}", next: "done" }, done: end }),
      message: 'Unknown template key "inputs.missing"',
    },
    {
      name: "absolute file path",
      input: { ...example, roles: { worker: { ...worker, instructions: "/outside/role.md" } } },
      message: "escapes the crew directory",
    },
    {
      name: "relative path escape",
      input: { ...example, roles: { worker: { ...worker, instructions: "../role.md" } } },
      message: "escapes the crew directory",
    },
    {
      name: "missing instructions file",
      input: { ...example, roles: { worker: { ...worker, instructions: "roles/worker.md" } } },
      message: 'Referenced file "roles/worker.md" is missing',
    },
    {
      name: "missing task file",
      input: withSteps({ work: { ...task, task: "prompts/work.md", next: "done" }, done: end }),
      message: 'Referenced file "prompts/work.md" is missing',
    },
    {
      name: "missing persona fact file",
      input: {
        ...example,
        roles: { worker: { ...worker, persona: { facts: ["file:context.md"] } } },
      },
      message: 'Referenced file "context.md" is missing',
    },
    {
      name: "shared parallel with no owns",
      input: parallel({}, {}, { isolation: "shared" }),
      message: "needs owns",
    },
    {
      name: "shared parallel branch with no owns",
      input: parallel({ isolation: "shared" }),
      message: "needs owns",
    },
    {
      name: "shared fanout with no owns",
      input: withSteps(
        {
          work: { ...task, next: "build" },
          build: {
            ...task,
            type: "fanout",
            over: "artifacts.items",
            isolation: "shared",
            next: "done",
          },
          done: end,
        },
        { artifacts: { items: { type: "list", item: "string" } } },
      ),
      message: "needs owns",
    },
    {
      name: "inherited shared isolation",
      input: { ...parallel(), defaults: { isolation: "shared" } },
      message: "needs owns",
    },
    {
      name: "removed board field",
      input: {
        ...example,
        board: { columns: [{ id: "build", label: "Build", steps: ["missing"] }] },
      },
      path: ["board"],
    },
    {
      name: "removed step column",
      input: withSteps({ work: { ...task, column: "missing", next: "done" }, done: end }),
      path: ["flow", "steps", "work", "column"],
    },
  ];
  it.each(cases)("rejects $name with a located diagnostic", (entry) => {
    const result = validate(entry.input);
    const issue = result.errors.find((error) =>
      "message" in entry
        ? error.message.includes(entry.message!)
        : "path" in entry && entry.path!.every((segment, i) => error.path[i] === segment),
    );
    expect(issue, JSON.stringify(result)).toBeDefined();
    expect(issue?.file).toBe("/crews/example/crew.yaml");
    expect(issue?.line).toBeGreaterThan(0);
    expect(issue?.column).toBeGreaterThan(0);
  });

  it("AC 2 locates the review step in the original YAML", () => {
    const text =
      "version: 1\nid: example\nname: Example\nroles:\n  worker: { name: Worker, instructions: Work }\nflow:\n  start: review\n  steps:\n    review:\n      role: worker\n      task: Review\n      outcomes: { changes: fix, approve: done }\n    fix: { role: worker, task: Fix, next: review }\n    done: { type: end }\n";
    const parsed = parseCrewYaml(text);
    const result = validateCrew(parsed.value, {
      ...validationContext,
      source: { file: "crew.yaml", text },
    });
    expect(
      result.errors.find((issue) => issue.message.startsWith("Unlimited cycle")),
    ).toMatchObject({ file: "crew.yaml", line: 10, column: 7, path: ["flow", "steps", "review"] });
  });

  it("rejects board at its key's line in the original YAML", () => {
    const text = `# Retired board\nboard:\n  columns: []\n${stringify(example)}`;
    const result = validate(parse(text), { source: { file: "crew.yaml", text } });
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("board"),
        file: "crew.yaml",
        line: 2,
        column: 1,
        path: ["board"],
      }),
    );
  });
});

describe("home detection", () => {
  it.each([
    { by: "user", invalid: false },
    { by: "lead", invalid: true },
  ])("AC 2a validates a cycle paced by $by", ({ by, invalid }) => {
    const input = withSteps(
      {
        work: { ...task, next: "review" },
        review: { type: "gate", by, prompt: "Fix again?", outcomes: { fix: "fix", done: "done" } },
        fix: { ...task, next: "review" },
        done: end,
      },
      { roles: leadRoles, home: leadHome },
    );
    const result = validate(input);
    expect(result.errors.length > 0).toBe(invalid);
    if (invalid) expect(result.errors[0]?.message).toContain("Unlimited cycle");
  });

  it.each([
    {
      name: "ordinary crew",
      roles: { worker },
      home: undefined,
      expected: { mode: "first-step", roleId: "worker", source: "auto" },
    },
    {
      name: "orchestrator, AC 9",
      roles: { worker, orchestrator: worker },
      home: undefined,
      expected: { mode: "lead", roleId: "orchestrator", source: "auto" },
    },
    {
      name: "case-insensitive lead",
      roles: { worker, LeAd: worker },
      home: undefined,
      expected: { mode: "lead", roleId: "LeAd", source: "auto" },
    },
    {
      name: "case-insensitive orchestrator",
      roles: { worker, Orchestrator: worker },
      home: undefined,
      expected: { mode: "lead", roleId: "Orchestrator", source: "auto" },
    },
    {
      name: "explicit first step wins over detected lead",
      roles: leadRoles,
      home: { mode: "first-step" },
      expected: { mode: "first-step", roleId: "worker", source: "explicit" },
    },
    {
      name: "explicit role settles ambiguity",
      roles: { ...leadRoles, orchestrator: worker },
      home: leadHome,
      expected: { mode: "lead", roleId: "lead", source: "explicit" },
    },
  ])("resolves $name", ({ roles, home, expected }) => {
    const detected = detectCrewHome(decodeCrew({ ...example, roles, ...(home ? { home } : {}) }));
    expect(detected.home).toEqual(expected);
    expect(detected.diagnostics.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(detected.diagnostics.some((issue) => issue.severity === "info")).toBe(
      expected.source === "auto",
    );
  });
});

describe("project-dependent status and warnings", () => {
  it("AC 14 keeps missing role tools soft but script tools mandatory in that project", () => {
    const crew = { ...example, roles: { worker: { ...worker, tools: ["unit-tests"] } } };
    const missing = validate(crew);
    expect(missing.errors).toEqual([]);
    expect(missing.warnings.map((issue) => issue.message)).toEqual([
      'Unresolved tool "unit-tests"; role "worker" runs without it.',
    ]);
    const script = {
      ...crew,
      flow: {
        start: "work",
        steps: {
          work: { ...task, next: "test" },
          test: { type: "script", tool: "unit-tests", next: "done" },
          done: end,
        },
      },
    };
    expect(validate(script).errors.some((issue) => issue.message.includes("Script tool"))).toBe(
      true,
    );
    const present = validate(script, {
      toolbox: { repoTools: [definition("unit-tests", "/repo/.t3/tools.yaml")] },
    });
    expect(present.errors).toEqual([]);
    expect(present.warnings).toEqual([]);
  });

  it.each([
    {
      name: "role unused",
      input: { ...example, roles: { worker, unused: worker } },
      message: "never used",
    },
    {
      name: "overlapping parallel ownership",
      input: parallel({ owns: ["src/**"] }, { owns: ["src/ui/**"] }),
      message: "may overlap",
    },
    {
      name: "overlapping fanout ownership",
      input: withSteps(
        {
          work: { ...task, next: "build" },
          build: {
            ...task,
            type: "fanout",
            over: "artifacts.items",
            owns: ["src/**"],
            next: "done",
          },
          done: end,
        },
        { artifacts: { items: { type: "list", item: "string" } } },
      ),
      message: "overlapping owns",
    },
    {
      name: "editing lead with shared work",
      input: { ...example, roles: leadRoles, home: { ...leadHome, canEdit: true } },
      message: "lead can edit",
    },
    {
      name: "missing named skill",
      input: { ...example, skills: ["missing"] },
      message: 'Unresolved skill "missing"',
    },
    {
      name: "missing named MCP",
      input: { ...example, mcp: ["missing"] },
      message: 'Unresolved mcp "missing"',
    },
  ])("warns for $name without blocking", ({ input, message }) => {
    const result = validate(input);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((issue) => issue.message.includes(message))).toBe(true);
  });

  it.each([
    { name: "missing driver", snapshot: [], warned: true },
    {
      name: "missing model",
      snapshot: [{ driver: ProviderDriverKind.make("codex"), enabled: true, models: [] }],
      warned: true,
    },
    {
      name: "disabled instance",
      snapshot: [
        {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          models: [{ slug: "model", name: "Model", isCustom: false, capabilities: null }],
        },
      ],
      warned: true,
    },
    {
      name: "enabled matching model",
      snapshot: [
        {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          models: [{ slug: "model", name: "Model", isCustom: false, capabilities: null }],
        },
      ],
      warned: false,
    },
  ])("checks model hint against $name", ({ snapshot, warned }) => {
    const result = validate(
      { ...example, roles: { worker: { ...worker, model: { driver: "codex", model: "model" } } } },
      { providerSnapshot: snapshot },
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((issue) => issue.message.includes("model hint"))).toBe(warned);
  });

  it.each([
    {
      name: "disjoint directories",
      input: parallel({ owns: ["web/**"] }, { owns: ["server/**"] }),
    },
    {
      name: "serial parallel group",
      input: parallel({ owns: ["src/**"] }, { owns: ["src/**"] }, { maxParallel: 1 }),
    },
    {
      name: "serial run cap",
      input: {
        ...parallel({ owns: ["src/**"] }, { owns: ["src/**"] }, { maxParallel: 3 }),
        defaults: { maxParallel: 1 },
      },
    },
    {
      name: "serial role cap",
      input: {
        ...parallel({ owns: ["src/**"] }, { owns: ["src/**"] }),
        roles: { worker: { ...worker, maxConcurrent: 1 } },
      },
    },
    {
      name: "disjoint extensions",
      input: parallel({ owns: ["src/*.ts"] }, { owns: ["src/*.tsx"] }),
    },
    {
      name: "read-only observer",
      input: parallel({ owns: ["src/**"] }, { isolation: "read-only", owns: ["src/**"] }),
    },
    {
      name: "sequential same ownership",
      input: withSteps({
        work: { ...task, owns: ["src/**"], next: "second" },
        second: { ...task, owns: ["src/**"], next: "done" },
        done: end,
      }),
    },
    {
      name: "role ownership inheritance",
      input: {
        ...parallel({ isolation: "shared" }, { isolation: "read-only" }),
        roles: { worker: { ...worker, owns: ["src/**"] } },
      },
    },
    {
      name: "inline script",
      input: withSteps({
        work: { ...task, next: "test" },
        test: { type: "script", run: "echo {{run.branch}}", next: "done" },
        done: end,
      }),
    },
    { name: "lead is used implicitly", input: { ...example, home: leadHome, roles: leadRoles } },
  ])("accepts $name without warnings", ({ input }) => {
    const result = validate(input);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("file containment and external templates", () => {
  it.each([
    "../role.md",
    "roles/../../role.md",
    "roles\\..\\..\\role.md",
    "C:\\outside\\role.md",
    "C:role.md",
    "\\\\server\\share\\role.md",
    "/outside/role.md",
  ])("rejects escaping path %s", (instructions) => {
    expect(
      validate({ ...example, roles: { worker: { ...worker, instructions } } }).errors.some(
        (issue) => issue.message.includes("escapes"),
      ),
    ).toBe(true);
  });
  it.each(["/outside/role.md", "/crews/example-other/role.md"])(
    "rejects symlink target %s",
    (realPath) => {
      const result = validate(
        { ...example, roles: { worker: { ...worker, instructions: "role.md" } } },
        { files: { "role.md": { realPath, text: "Work" } } },
      );
      expect(result.errors.some((issue) => issue.message.includes("resolves outside"))).toBe(true);
    },
  );
  it.each(["roles/worker/role.md", "roles/worker.md"])(
    "accepts fallback instructions at %s",
    (path) => {
      const result = validate(
        { ...example, roles: { worker: { name: "Worker" } } },
        { files: { [path]: { realPath: `/crews/example/${path}`, text: "Do {{inputs.brief}}" } } },
      );
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    },
  );
  it("prefers folder instructions and validates only the chosen file", () => {
    const result = validate(
      { ...example, roles: { worker: { name: "Worker" } } },
      {
        files: {
          "roles/worker/role.md": { realPath: "/crews/example/roles/worker/role.md", text: "Work" },
          "roles/worker.md": { realPath: "/crews/example/roles/worker.md", text: "{{unknown}}" },
        },
      },
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toContain("wins");
  });
  it("uses explicit inline instructions even when both fallback files exist", () => {
    const files = Object.fromEntries(
      ["roles/worker/role.md", "roles/worker.md"].map((path) => [
        path,
        { realPath: `/crews/example/${path}`, text: "{{unknown}}" },
      ]),
    );
    expect(validate(example, { files }).warnings).toEqual([]);
    expect(validate(example, { files }).errors).toEqual([]);
  });
  it("locates an invalid template inside a prompt file", () => {
    const result = validate(
      withSteps({ work: { ...task, task: "prompts/work.md", next: "done" }, done: end }),
      {
        files: {
          "prompts/work.md": {
            realPath: "/crews/example/prompts/work.md",
            text: "Work\nUse {{inputs.missing}}",
          },
        },
      },
    );
    expect(result.errors).toEqual([
      {
        severity: "error",
        message: 'Unknown template key "inputs.missing".',
        file: "/crews/example/prompts/work.md",
        line: 2,
        column: 5,
        path: ["flow", "steps", "work", "task"],
      },
    ]);
  });
  it("normalizes contained Windows paths and dot segments", () => {
    const result = validate(
      { ...example, roles: { worker: { ...worker, instructions: "roles\\other\\..\\worker.md" } } },
      {
        crewDirectory: "C:\\Crews\\Example",
        files: {
          "roles/worker.md": { realPath: "c:\\crews\\example\\roles\\worker.md", text: "Work" },
        },
      },
    );
    expect(result.errors).toEqual([]);
  });
});
