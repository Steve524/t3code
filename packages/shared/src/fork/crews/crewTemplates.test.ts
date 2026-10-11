import { describe, expect, it } from "vite-plus/test";

import {
  decodeCrew,
  end,
  example,
  task,
  validationContext,
  withSteps,
  worker,
} from "./crewTestFixtures.ts";
import { crewTemplateKeyExists } from "./crewTemplates.ts";
import { validateCrew } from "./validateCrew.ts";

const artifacts = {
  note: { type: "text" },
  plan: {
    type: "object",
    schema: {
      title: "string",
      tasks: {
        type: "list",
        item: { id: "string", owns: "string[]", meta: { enabled: "boolean" } },
      },
      paths: "string[]",
    },
  },
  items: { type: "list", item: "string" },
};
const crew = decodeCrew({ ...example, artifacts });
const fanout = decodeCrew(
  withSteps(
    { work: { ...task, type: "fanout", over: "artifacts.plan.tasks", next: "done" }, done: end },
    { artifacts },
  ),
).flow.steps.work!;

describe("template key validation", () => {
  it.each([
    ["inputs.brief", true],
    ["inputs.missing", false],
    ["inputs.brief.child", false],
    ["artifacts.note", true],
    ["artifacts.note.title", false],
    ["artifacts.plan", true],
    ["artifacts.plan.title", true],
    ["artifacts.plan.tasks", true],
    ["artifacts.plan.tasks.0.id", true],
    ["artifacts.plan.paths.0", true],
    ["artifacts.plan.tasks.id", false],
    ["artifacts.missing", false],
    ["steps.work.summary", true],
    ["steps.work.outcome", true],
    ["steps.work.title", false],
    ["steps.missing.summary", false],
    ["steps.work.summary.extra", false],
    ["run.branch", true],
    ["run.id", false],
    ["run.branch.extra", false],
    ["item", true],
    ["item.id", true],
    ["item.owns", true],
    ["item.meta.enabled", true],
    ["item.missing", false],
    ["item.id.child", false],
    ["item.owns.0", true],
    ["#if inputs.brief", false],
    ["/if", false],
    [">partial", false],
    ["inputs", false],
    ["artifacts", false],
    ["", false],
    ["inputs.toString", false],
  ])("%s exists=%s in fanout", (key, expected) => {
    expect(crewTemplateKeyExists(crew, key, fanout)).toBe(expected);
  });

  it.each(["item", "item.id", "item.owns"])("rejects %s outside fanout", (key) => {
    expect(crewTemplateKeyExists(crew, key, crew.flow.steps.work)).toBe(false);
  });

  it.each([
    {
      name: "inline task",
      input: withSteps({ work: { ...task, task: "{{unknown}}", next: "done" }, done: end }),
    },
    {
      name: "role instructions",
      input: { ...example, roles: { worker: { ...worker, instructions: "{{unknown}}" } } },
    },
    {
      name: "persona identity",
      input: { ...example, roles: { worker: { ...worker, persona: { identity: "{{unknown}}" } } } },
    },
    {
      name: "persona principle",
      input: {
        ...example,
        roles: { worker: { ...worker, persona: { principles: ["{{unknown}}"] } } },
      },
    },
    {
      name: "inline fact",
      input: { ...example, roles: { worker: { ...worker, persona: { facts: ["{{unknown}}"] } } } },
    },
    {
      name: "gate prompt",
      input: withSteps({
        work: { ...task, next: "gate" },
        gate: { type: "gate", prompt: "{{unknown}}", outcomes: { go: "done" } },
        done: end,
      }),
    },
    {
      name: "script run",
      input: withSteps({
        work: { ...task, next: "script" },
        script: { type: "script", run: "echo {{unknown}}", next: "done" },
        done: end,
      }),
    },
    {
      name: "ownership",
      input: withSteps({ work: { ...task, owns: "{{unknown}}", next: "done" }, done: end }),
    },
  ])("checks $name", ({ input }) => {
    expect(
      validateCrew(input, validationContext).errors.some(
        (issue) => issue.message === 'Unknown template key "unknown".',
      ),
    ).toBe(true);
  });

  it.each(["artifacts.items", "artifacts.plan.tasks", "artifacts.plan.paths"])(
    "accepts fanout over %s",
    (over) => {
      const input = withSteps(
        {
          work: { ...task, next: "build" },
          build: {
            ...task,
            type: "fanout",
            over,
            task: "Process {{ item }} on {{run.branch}}",
            next: "done",
          },
          done: end,
        },
        { artifacts },
      );
      expect(validateCrew(input, validationContext).errors).toEqual([]);
    },
  );

  it.each(["{{item.owns}}", "{{ item.owns }}"])(
    "validates fanout ownership template %s",
    (ownership) => {
      const input = withSteps(
        {
          work: { ...task, next: "build" },
          build: {
            ...task,
            type: "fanout",
            over: "artifacts.plan.tasks",
            task: "Work on {{item.id}}",
            owns: ownership,
            next: "done",
          },
          done: end,
        },
        { artifacts },
      );
      const result = validateCrew(input, validationContext);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    },
  );
});
