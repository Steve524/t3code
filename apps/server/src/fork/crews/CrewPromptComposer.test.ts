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
  composeCrewConflictPrompt,
  composeCrewLeadKickoff,
  crewDecisionPrompt,
  crewLeadUpdatePrompt,
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

  it("lists the role's tools and how to run one", () => {
    const tools = [
      { name: "unit-tests", source: "repo" as const, description: "Run the tests", run: "vp test" },
      { name: "lint", source: "repo" as const, run: "vp lint" },
    ];
    const prompt = composeCrewCardPrompt(
      input("plan", { toolbox: { skills: [], mcp: [], tools } }),
    );
    expect(prompt).toContain("## Tools\n\n- unit-tests: Run the tests\n- lint\n\nRun one with");
    expect(prompt.indexOf("## Tools")).toBeLessThan(prompt.indexOf("## Protocol"));
    expect(composeCrewCardPrompt(input("plan"))).not.toContain("## Tools");
  });

  it("lists each MCP server once, the way the role's provider reaches it", () => {
    const mcp = [
      { name: "playwright", source: "home" as const, command: "npx", args: [], env: {} },
      {
        name: "figma",
        source: "repo" as const,
        command: "figma-mcp",
        args: [],
        env: { TOKEN: "${secret:FIGMA}" },
      },
    ];
    const tools = (driver: string) =>
      composeCrewCardPrompt(input("plan", { driver, toolbox: { skills: [], mcp, tools: [] } }))
        .split("## Tools\n\n")[1]
        ?.split("\n\n## ")[0];
    const gateway = "MCP servers you reach through `crew_mcp_list_tools` and `crew_mcp_call`";
    expect(tools("codex")).toBe("MCP servers whose tools you have directly: playwright, figma.");
    expect(tools("opencode")).toBe(`${gateway}: playwright, figma.`);
    // Cursor gets a server with a secret through the gateway only.
    expect(tools("cursor")).toBe(
      `MCP servers whose tools you have directly: playwright.\n\n${gateway}: figma.`,
    );
  });

  it("tells a conflict resolver which files to fix and to leave the commit to the crew", () => {
    const prompt = composeCrewConflictPrompt({
      crew: definition,
      files,
      roleId: "reviewer",
      driver: "codex",
      branch: "crew/example/abc12345",
      paths: ["src/a.ts", "README.md"],
    });
    expect(prompt).toContain(
      "into `crew/example/abc12345` stopped on conflicts in:\n\n- src/a.ts\n- README.md",
    );
    expect(prompt).toContain("## Your role\n\nYou are the Reviewer");
    expect(prompt).toContain("Prefer short answers.");
    expect(prompt).toContain("Do not commit, abort the merge");
    expect(prompt).toContain("outcome `done`");
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

describe("lead prompts", () => {
  const led = decodeCrew({
    ...withSteps(
      {},
      {
        home: { mode: "lead", role: "lead" },
        roles: {
          lead: { name: "Lead", instructions: "You coordinate." },
          builder: { name: "Builder", description: "Writes the code" },
        },
      },
    ),
    flow: {
      start: "build",
      steps: {
        build: { ...task, role: "builder", next: "review" },
        review: {
          ...task,
          role: "builder",
          outcomes: { approve: "wrap", changes: { to: "triage", max: 2, else: "wrap" } },
        },
        triage: {
          type: "gate",
          by: "lead",
          prompt: "Who fixes it?",
          outcomes: { builder: "build", accept: "wrap" },
        },
        wrap: { ...task, role: "lead", next: "done" },
        done: end,
      },
    },
  });
  const kickoff = (canEdit: boolean) =>
    composeCrewLeadKickoff({
      crew: led,
      files: {},
      driver: null,
      inputs: { brief: "add a /health route" },
      roleId: "lead",
      models: { lead: "claudeAgent/claude-opus-5-5", builder: "codex/gpt-5.6-terra" },
      canEdit,
      updates: "milestones",
    });

  it("opens the home thread with the brief, the roster, the flow and how to decide", () => {
    const prompt = kickoff(false);
    expect(prompt.startsWith("## Brief\n\nbrief: add a /health route")).toBe(true);
    expect(prompt).toContain("## Your role\n\nYou are the Lead");
    expect(prompt).toContain("- Lead (`lead`), on claudeAgent/claude-opus-5-5 (you)");
    expect(prompt).toContain("- Builder (`builder`): Writes the code, on codex/gpt-5.6-terra");
    expect(prompt).toContain("It starts at `build` when this turn of yours ends.");
    expect(prompt).toContain("- `build`: Builder works on it; then `review`.");
    expect(prompt).toContain(
      "- `review`: Builder works on it; `approve` goes to `wrap`, `changes` goes to `triage` (at most 2 times, then `wrap`).",
    );
    expect(prompt).toContain(
      "- `triage`: you decide: Who fixes it?; `builder` goes to `build`, `accept` goes to `wrap`.",
    );
    expect(prompt).toContain("- `wrap`: you work on it; then `done`.");
    expect(prompt).toContain("- `done`: the run ends.");
    expect(prompt).toContain("Answer it with `crew_decide`");
    expect(prompt).toContain("You read the checkout but do not change it");
    expect(kickoff(true)).toContain("You may edit the shared checkout.");
  });

  it("batches what the lead missed into one message", () => {
    expect(crewLeadUpdatePrompt(["Merge `integrate` finished."])).toBe(
      "## Crew update\n\n- Merge `integrate` finished.\n\nNo answer is needed.",
    );
    expect(crewLeadUpdatePrompt(["one", "two"])).toContain(
      "## While you were working\n\n- one\n- two\n",
    );
  });

  it("asks for a decision with its id, the outcomes and the block to answer with", () => {
    const ask = (reminder: boolean) =>
      crewDecisionPrompt({
        decisionId: "run:triage:1",
        prompt: "Who fixes it?",
        outcomes: ["builder", "accept"],
        context: ["`review` (Builder) finished with `changes`: Missing a route."],
        reminder,
      });
    expect(ask(false)).toContain(
      "## Decision needed\n\nWho fixes it?\n\n- `review` (Builder) finished with `changes`: Missing a route.",
    );
    expect(ask(false)).toContain("Decision id: `run:triage:1`");
    expect(ask(false)).toContain(
      "Allowed outcomes: builder, accept, or `escalate` to hand the decision to the user.",
    );
    expect(ask(false)).toContain(
      '```crew-decision\n{ "decisionId": "run:triage:1", "outcome": "<outcome>", "note": "<why>" }\n```',
    );
    expect(ask(false)).not.toContain("without deciding");
    expect(ask(true)).toContain("You ended your turn without deciding. Decide now.");
  });
});
