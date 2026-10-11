import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeCrew,
  end,
  task,
  withSteps,
} from "../../../../../packages/shared/src/fork/crews/crewTestFixtures.ts";
import {
  composeCrewCardPrompt,
  crewPromptFiles,
  crewReminderPrompt,
  renderCrewTemplate,
  type CrewPromptInput,
} from "./CrewPromptComposer.ts";

const steps = {
  plan: { ...task, role: "planner", task: "prompts/plan.md", produces: ["plan"], next: "review" },
  review: {
    ...task,
    role: "reviewer",
    task: "Review {{run.branch}} against:\n{{steps.plan.summary}}",
    consumes: ["plan"],
    outcomes: { approve: "done", changes: "plan" },
  },
  done: end,
};
const definition = decodeCrew({
  ...withSteps(steps, {
    roles: {
      planner: { name: "Planner", instructions: "roles/planner.md" },
      reviewer: {
        name: "Reviewer",
        persona: { identity: "A careful reader.", principles: ["Cite the line."] },
      },
    },
    artifacts: { plan: { type: "object", schema: { tasks: "string[]" } } },
  }),
  flow: { start: "plan", steps },
});

const files = {
  "prompts/plan.md": "Plan this:\n\n{{inputs.brief}}",
  "roles/planner.md": "---\nname: planner\nmodel: opus\n---\nYou plan the work.",
  "roles/reviewer/role.md": "You review the work.",
  "overlays/gpt.md": "Prefer short answers.",
  "templates/unused.md": "Not referenced.",
};

const input = (stepId: string, extra: Partial<CrewPromptInput> = {}): CrewPromptInput => ({
  crew: definition,
  files,
  stepId,
  inputs: { brief: "add a /health route" },
  artifacts: {},
  steps: {},
  previousSteps: [],
  item: null,
  branch: "crew/example/abc12345",
  driver: null,
  toolbox: { skills: [], mcp: [], tools: [] },
  notes: [],
  ...extra,
});

describe("crew prompt", () => {
  it("leads with the rendered task, then the role, and ends with how to report", () => {
    const prompt = composeCrewCardPrompt(input("plan"));
    expect(prompt.startsWith("## Task\n\nPlan this:\n\nadd a /health route")).toBe(true);
    expect(prompt).toContain("## Your role\n\nYou are the Planner");
    expect(prompt).toContain("You plan the work.");
    expect(prompt).toContain("Allowed outcomes: done.");
    expect(prompt).toContain("Required artifact `plan`");
    expect(prompt).toContain("Call `crew_report` once");
    expect(prompt).toContain("```crew-report");
    expect(prompt.indexOf("## Your role")).toBeLessThan(prompt.indexOf("## Protocol"));
  });

  it("drops a role file's frontmatter", () => {
    expect(composeCrewCardPrompt(input("plan"))).not.toContain("model: opus");
  });

  it("falls back to the role folder's file, and adds persona and the model family's overlay", () => {
    const prompt = composeCrewCardPrompt(input("review", { driver: "codex" }));
    expect(prompt).toContain("You review the work.");
    expect(prompt).toContain("Identity: A careful reader.");
    expect(prompt).toContain("Principles:\n- Cite the line.");
    expect(prompt).toContain("Prefer short answers.");
    expect(composeCrewCardPrompt(input("review", { driver: "claudeAgent" }))).not.toContain(
      "Prefer short answers.",
    );
  });

  it("gives the reviewer the branch, the previous step's result, its artifacts and its notes", () => {
    const prompt = composeCrewCardPrompt(
      input("review", {
        artifacts: { plan: { tasks: ["route", "test"] } },
        steps: { plan: { summary: "Two tasks.", outcome: "done" } },
        previousSteps: ["plan"],
        notes: ["Check the status code."],
      }),
    );
    expect(prompt).toContain("Review crew/example/abc12345 against:\nTwo tasks.");
    expect(prompt).toContain("Step `plan` finished with `done`:\nTwo tasks.");
    expect(prompt).toContain('Artifact `plan`:\n{\n  "tasks": [');
    expect(prompt).toContain("Note from a teammate:\nCheck the status code.");
    expect(prompt).toContain("Allowed outcomes: approve, changes.");
  });

  it("lists the role's skills by name and description", () => {
    const prompt = composeCrewCardPrompt(
      input("plan", {
        toolbox: {
          skills: [
            {
              name: "repo-map",
              path: "/x/SKILL.md",
              source: "crew",
              hash: "h",
              description: "Where things live.",
            },
          ],
          mcp: [],
          tools: [],
        },
      }),
    );
    expect(prompt).toContain("## Skills\n\n- repo-map: Where things live.");
    expect(prompt).toContain("crew_skill_get");
  });

  it("names an artifact too large to paste, and never exceeds the provider limit", () => {
    const big = { tasks: ["x".repeat(10_000)] };
    expect(composeCrewCardPrompt(input("review", { artifacts: { plan: big } }))).toContain(
      "Artifact `plan`: read it with `crew_artifact_read`.",
    );
    const long = { brief: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS) };
    expect(composeCrewCardPrompt(input("plan", { inputs: long })).length).toBe(
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    );
  });

  it("renders a missing template key as nothing and an object as JSON", () => {
    expect(renderCrewTemplate("a{{ missing.key }}b", {})).toBe("ab");
    expect(renderCrewTemplate("{{item.owns}}", { item: { owns: ["a", "b"] } })).toBe(
      '[\n  "a",\n  "b"\n]',
    );
    expect(renderCrewTemplate("{{item.owns.1}}", { item: { owns: ["a", "b"] } })).toBe("b");
  });

  it("freezes only the files a prompt can read", () => {
    expect(Object.keys(crewPromptFiles(definition, files)).toSorted()).toEqual([
      "overlays/gpt.md",
      "prompts/plan.md",
      "roles/planner.md",
      "roles/reviewer/role.md",
    ]);
  });

  it("reminds a silent role of the outcomes it may report", () => {
    expect(crewReminderPrompt(definition, "review")).toContain(
      "Report now with one of: approve, changes, failed.",
    );
  });
});
