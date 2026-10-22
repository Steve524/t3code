import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { CrewFile } from "../../../../../packages/contracts/src/fork/crews/crewFile.ts";
import {
  decodeCrew,
  end,
  task,
  withSteps,
  worker,
} from "../../../../../packages/shared/src/fork/crews/crewTestFixtures.ts";
import {
  composeCrewOrchestratorPrompt,
  CREW_REVIEWER_LINE,
  CREW_WORKER_RULES,
  type CrewOrchestratorPromptInput,
} from "./CrewPromptComposer.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

const roles = (crew: CrewFile): CrewOrchestratorPromptInput["roles"] =>
  Object.keys(crew.roles).map((id) => ({
    id,
    model: {
      selection: { instanceId: codex, model: "gpt-6.1-sol" },
      source: "crew-hint",
      warnings: [],
    },
    runtimeMode: { runtimeMode: "full-access", source: "inherit", clamped: false },
    toolbox: { items: [], diagnostics: [] },
  }));

const compose = (crew: CrewFile, extra: Partial<CrewOrchestratorPromptInput> = {}) =>
  composeCrewOrchestratorPrompt({
    crew,
    files: {},
    inputs: { brief: "add a /health route" },
    runId: "run-7",
    runFolder: "/repo/.t3/crew-runs/run-7",
    roles: roles(crew),
    tools: { tools: {} },
    providers: [
      { instanceId: codex, driver: ProviderDriverKind.make("codex"), models: ["gpt-6.1-sol"] },
    ],
    ...extra,
  });

const prompt = (crew: CrewFile, extra: Partial<CrewOrchestratorPromptInput> = {}) => {
  const result = compose(crew, extra);
  expect(result.errors).toEqual([]);
  return result.prompt;
};

/** One step's section, so assertions can't match text from another step. */
const section = (text: string, stepId: string) =>
  text.split(`### \`${stepId}\``)[1]?.split("\n### ")[0]?.split("\n## ")[0] ?? "";

const crewOf = (steps: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  decodeCrew({ ...withSteps(steps, extra), flow: { start: Object.keys(steps)[0], steps } });

const reviewLoop = (review: Record<string, unknown> = {}, work: Record<string, unknown> = {}) =>
  crewOf(
    {
      work: { ...task, next: "review", ...work },
      review: {
        ...task,
        role: "reviewer",
        review: true,
        task: "Review {{steps.work.summary}} for {{inputs.brief}}",
        outcomes: { approve: "done", changes: { to: "work", max: 3, else: "done", resetOn: [] } },
        ...review,
      },
      done: end,
    },
    { roles: { worker, reviewer: { name: "Reviewer", instructions: "You review." } } },
  );

describe("orchestrator prompt: roles and rules", () => {
  it("lists each role's model, ownership, and tools, and starts worker tasks with the role tag", () => {
    const crew = crewOf(
      { work: { ...task, next: "done" }, done: end },
      {
        roles: {
          worker: {
            ...worker,
            owns: ["src/**"],
            pool: ["codex-2"],
            interactionMode: "plan",
          },
        },
      },
    );
    const text = prompt(crew, {
      roles: [
        {
          ...roles(crew)[0]!,
          model: {
            selection: {
              instanceId: codex,
              model: "gpt-6.1-sol",
              options: [{ id: "reasoningEffort", value: "xhigh" }],
            },
            source: "crew-hint",
            warnings: [],
          },
          runtimeMode: { runtimeMode: "auto-accept-edits", source: "crew-hint", clamped: false },
          toolbox: {
            items: [
              {
                kind: "skill",
                name: "repo-map",
                path: "/skills/repo-map",
                source: "crew",
                grantedBy: [],
              },
              {
                kind: "tool",
                name: "unit-tests",
                path: ".t3/tools.yaml",
                source: "repo",
                grantedBy: [],
              },
              { kind: "mcp", name: "playwright", path: "mcp.yaml", source: "home", grantedBy: [] },
            ],
            diagnostics: [],
          },
        },
      ],
      tools: { tools: { "unit-tests": { run: "vp test" } } },
    });
    expect(text).toContain(
      '| `worker` Worker | `providerInstanceId: codex`, `model: gpt-6.1-sol`, `options: [{"id":"reasoningEffort","value":"xhigh"}]`, `runtimeMode: auto-accept-edits`, `interactionMode: plan`, if that instance fails to start, use `codex-2` | `src/**` |',
    );
    expect(text).toContain("skill `repo-map`: read `/skills/repo-map`");
    expect(text).toContain("tool `unit-tests`: run `vp test`");
    expect(text).toContain("MCP `playwright` through `crew_mcp_list_tools` and `crew_mcp_call`");
    expect(text).toContain("Every worker task starts with the line `[crew-role: <role id>]`.");
    expect(text).toContain('#### `worker`\n\n> You are the Worker of the "Example" crew.');
  });

  it("falls back to defaults.interactionMode and keeps an explicit empty options list", () => {
    const crew = crewOf(
      { work: { ...task, next: "done" }, done: end },
      { defaults: { interactionMode: "plan" } },
    );
    const [role] = roles(crew);
    const text = prompt(crew, {
      roles: [
        {
          ...role!,
          model: {
            ...role!.model,
            selection: { instanceId: codex, model: "gpt-6.1-sol", options: [] },
          },
        },
      ],
    });
    expect(text).toContain("`model: gpt-6.1-sol`, `options: []`, `interactionMode: plan` |");
  });

  it("copies the WORKER RULES verbatim, banning schedule_task", () => {
    const text = prompt(reviewLoop());
    expect(CREW_WORKER_RULES).toContain("`schedule_task`");
    expect(text).toContain(
      `### WORKER RULES (copy verbatim into every worker task)\n\n${CREW_WORKER_RULES}`,
    );
  });

  it("rejects a role model that orchestrator_capabilities does not offer", () => {
    const crew = reviewLoop();
    const [first, second] = roles(crew);
    const errors = compose(crew, {
      roles: [
        { ...first!, model: { ...first!.model, selection: { instanceId: codex, model: "gpt-0" } } },
        { ...second!, model: { ...second!.model, selection: { instanceId: claude, model: "x" } } },
      ],
    }).errors;
    expect(errors).toEqual([
      'Role "worker" uses model "gpt-0", which "codex" does not offer.',
      'Role "reviewer" uses provider "claudeAgent", which is not available.',
    ]);
    const unset = compose(crew, {
      roles: [{ ...first!, model: { ...first!.model, selection: null } }, second!],
    }).errors;
    expect(unset).toEqual(['Role "worker" has no model.']);
  });

  it("refuses a prompt larger than one message", () => {
    const crew = reviewLoop();
    const { errors } = compose(crew, {
      inputs: { brief: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS) },
    });
    expect(errors[0]).toMatch(/^The crew prompt is \d+ characters/u);
  });
});

describe("orchestrator prompt: review, ledger, and finish", () => {
  it("starts a fresh reviewer every round on the same model, and reuses the implementer", () => {
    const text = prompt(reviewLoop({}, { continue: "same-thread" }));
    expect(section(text, "review")).toContain(
      "Review step: start a fresh worker as `reviewer` with `delegate_task` every round",
    );
    expect(section(text, "work")).toContain(
      "Continue the latest `worker` worker of this run, whichever step started it",
    );
    expect(section(text, "review")).not.toContain("commit");
    expect(section(text, "review")).toContain("The reviewer creates, edits, and deletes no files.");
    expect(CREW_WORKER_RULES).toContain("The reviewer, and any read-only worker, creates, edits");
    expect(text).toContain("Never continue a reviewer with `t3_thread_send`.");
    expect(text).toContain("Use the same reviewer model every round.");
  });

  it("treats only steps marked review: true as reviews", () => {
    // An implementer retry loop is not a review, even with a limited route.
    const retry = prompt(
      crewOf({
        work: {
          ...task,
          outcomes: { done: "end", failed: { to: "work", max: 2, else: "end" } },
        },
        end,
      }),
    );
    expect(retry).not.toContain("## Review rounds");
    // A one-pass review, or one that loops back only through a user gate, still is one.
    const gated = prompt(
      crewOf({
        work: { ...task, next: "check" },
        check: { ...task, review: true, outcomes: { approve: "done", changes: "ask" } },
        ask: { type: "gate", prompt: "Fix?", outcomes: { yes: "work", no: "done" } },
        done: end,
      }),
    );
    expect(gated).toContain("Review steps: `check`.");
    expect(section(gated, "check")).toContain("Review step: start a fresh worker as `worker`");
    // The same role implements in one step and reviews in another.
    expect(section(gated, "work")).toContain("Tell the worker to commit its changes");
    expect(section(gated, "check")).toContain(
      "If the reviewer ends without a `RESULT:` line, do not message it: start one fresh reviewer",
    );
    const fanout = prompt(
      crewOf(
        {
          work: { ...task, produces: ["items"], next: "each" },
          each: {
            ...task,
            type: "fanout",
            over: "artifacts.items",
            review: true,
            owns: "{{item}}",
            next: "done",
          },
          done: end,
        },
        { artifacts: { items: { type: "list", item: "string" } } },
      ),
    );
    expect(fanout).toContain("Review steps: `each`.");
    expect(section(fanout, "each")).toContain("The reviewer creates, edits, and deletes no files.");
  });

  it("keeps review-notes.md as an issue record that never drops an open objection", () => {
    const text = prompt(reviewLoop());
    expect(text).toContain("`| id | finding | source thread | claimed fix | status | evidence |`");
    expect(text).toContain("A fix claim is not verification");
    expect(text).toContain("Never drop an open objection");
    expect(text).toContain(`"${CREW_REVIEWER_LINE}"`);
    expect(CREW_REVIEWER_LINE).toBe(
      "Check every earlier finding, then review the whole change against the original requirements and look for new regressions. Approval covers only this revision.",
    );
  });

  it("hands a worktree reviewer the change when the implementer does not commit", () => {
    const text = prompt(reviewLoop({ isolation: "worktree" }, { autoCommit: false }));
    expect(section(text, "work")).toContain("Tell the worker not to commit");
    expect(section(text, "review")).toContain('Pass `isolation: "worktree"`');
    expect(text).toContain(
      "A worktree reviewer starts from this checkout's `HEAD`, without uncommitted edits or the run folder. Before you start one, commit the change on the crew branch (a WIP commit when the implementer does not commit) and name that commit, or paste the full diff into its task.",
    );
  });

  it("restates the limits and WORKER RULES in the ledger header and gives each line a stable id", () => {
    const ledger = prompt(reviewLoop()).split("## Ledger")[1]!.split("\n## ")[0]!;
    expect(ledger).toContain(
      "# Crew ledger run-7\nLimits: 30 dispatches, 3 live workers, 4 hours.\n- `review` `changes` goes to `work` at most 3 times",
    );
    expect(ledger).toContain(`WORKER RULES:\n${CREW_WORKER_RULES}\n\`\`\``);
    expect(ledger).toContain(
      "step=<step> clientRequestId=run-7-<n> taskId=? childThreadId=? : <why>",
    );
    expect(ledger).toContain("A retry of the same dispatch reuses its line and id.");
    expect(ledger).toContain(
      "after that it goes to `done`. The count never resets.\nWORKER RULES:",
    );
    expect(ledger).toContain(
      "append `route <step> <outcome> <count>/<max>`; when its count resets, append `reset <step> <outcome>`.",
    );
  });

  it("puts the ledger and notes in the run folder and requires crew_finish", () => {
    const text = prompt(reviewLoop());
    expect(text).toContain(
      "Run folder: `/repo/.t3/crew-runs/run-7` (absolute). It holds `ledger.md`, `review-notes.md`, and `artifacts/`.",
    );
    expect(text).toContain("then call `crew_finish` with run id `run-7`");
  });
});

describe("orchestrator prompt: every crew-file field", () => {
  it("task, next, outcomes, and route max/else/resetOn shape the flow and round limits", () => {
    const text = prompt(
      crewOf({
        work: { ...task, next: "check" },
        check: {
          ...task,
          outcomes: {
            approve: "done",
            changes: { to: "work", max: 2, else: "done", resetOn: ["work"] },
          },
        },
        done: end,
      }),
    );
    expect(text).toContain("Start at `work`.");
    expect(section(text, "work")).toContain("> Work on add a /health route.");
    expect(section(text, "work")).toContain("Routes: then `check`.\nTask:");
    expect(section(text, "check")).toContain(
      "Routes: `approve` goes to `done`; `changes` goes to `work` (at most 2 times in this run, then `done`; this counter resets only when `work` finishes).",
    );
    expect(section(text, "check")).toContain("RESULT outcomes: `approve`, `changes`.");
    expect(text).toContain(
      "- `check` `changes` goes to `work` at most 2 times; after that it goes to `done`.",
    );
  });

  it("continue: fresh starts a new implementer each time", () => {
    const text = prompt(reviewLoop({}, { continue: "fresh" }));
    expect(section(text, "work")).toContain(
      "Start a new worker as `worker` with `delegate_task` each time the flow reaches this step.",
    );
  });

  it("parallel and fanout with join all/any", () => {
    const text = prompt(
      crewOf(
        {
          plan: { ...task, produces: ["tasks"], next: "build" },
          build: {
            type: "parallel",
            branches: ["a", "b"],
            join: "any",
            next: "each",
            owns: ["x/**"],
            isolation: "read-only",
          },
          a: { ...task, owns: ["a/**"], next: "a2" },
          a2: { ...task, owns: ["a/**"] },
          b: { ...task, owns: ["b/**"], isolation: "worktree" },
          each: {
            ...task,
            type: "fanout",
            over: "artifacts.tasks",
            task: "Do {{item}}",
            owns: "{{item}}/**",
            next: "done",
          },
          done: end,
        },
        { artifacts: { tasks: { type: "list", item: "string" } } },
      ),
    );
    expect(section(text, "build")).toContain(
      "Start `a`, `b` at the same time. Each branch follows its own routes until it would leave the group. Continue on the first result and cancel the others with `task_cancel`.",
    );
    expect(section(text, "build")).toContain("Workers in these branches own only: `x/**`.");
    // Every step inside a branch, not only its first, takes the group's isolation.
    expect(section(text, "a")).toContain("Read-only: omit `isolation`");
    expect(section(text, "a2")).toContain("Read-only: omit `isolation`");
    expect(section(text, "b")).toContain('Pass `isolation: "worktree"`');
    expect(section(text, "each")).toContain(
      "Fan-out over `artifacts.tasks`: start one worker per item of that list",
    );
    expect(section(text, "each")).toContain("Continue when every one has reported.");
  });

  it("maxParallel becomes the run's worker cap, and role maxConcurrent a per-role cap", () => {
    const crew = crewOf(
      {
        work: { ...task, next: "each" },
        each: {
          ...task,
          type: "fanout",
          over: "artifacts.items",
          maxParallel: 2,
          owns: "{{item}}",
          next: "done",
        },
        done: end,
      },
      {
        defaults: { maxParallel: 5 },
        roles: { worker: { ...worker, maxConcurrent: 1 } },
        artifacts: { items: { type: "list", item: "string" } },
      },
    );
    const text = prompt(crew);
    expect(text).toContain("- At most 5 workers running at once.");
    expect(text).toContain("- At most 1 `worker` workers at once.");
    expect(section(text, "each")).toContain("At most 2 of these workers run at once.");
  });

  it("limits.maxFanoutItems caps a fan-out", () => {
    const text = prompt(
      crewOf(
        {
          work: { ...task, next: "each" },
          each: {
            ...task,
            type: "fanout",
            over: "artifacts.items",
            owns: "{{item}}",
            next: "done",
          },
          done: end,
        },
        {
          limits: { maxFanoutItems: 4 },
          artifacts: { items: { type: "list", item: "string" } },
        },
      ),
    );
    expect(section(text, "each")).toContain(
      "At most 4 items: if the list is longer, start none and stop with `LIMIT: fan-out items`.",
    );
  });

  it("merge with checkOwnership and onConflict", () => {
    const merge = (step: Record<string, unknown>) =>
      section(
        prompt(
          crewOf({
            work: { ...task, next: "join" },
            join: { type: "merge", next: "done", ...step },
            done: end,
          }),
        ),
        "join",
      );
    const blocking = merge({ checkOwnership: "block", onConflict: { role: "worker" } });
    expect(blocking).toContain("with `git merge`, one at a time");
    expect(blocking).toContain("Do not merge a branch that touched files it does not own");
    expect(blocking).toContain("On a conflict, start a worker as `worker` in this checkout");
    const warning = merge({ checkOwnership: "warn" });
    expect(warning).toContain(
      "List files outside a worker's ownership in your report, then merge.",
    );
    expect(warning).toContain("ask the user how to resolve it");
  });

  it("script run and tool run in the orchestrator's shell", () => {
    const text = prompt(
      crewOf({
        work: { ...task, next: "lint" },
        lint: { type: "script", run: "vp lint {{inputs.brief}}", timeoutMinutes: 3, next: "test" },
        test: { type: "script", tool: "unit-tests", outcomes: { pass: "done", fail: "work" } },
        done: end,
      }),
      { tools: { tools: { "unit-tests": { run: "vp test" } } } },
    );
    expect(section(text, "lint")).toContain(
      "Run `vp lint add a /health route` in your own shell in this checkout.",
    );
    expect(section(text, "test")).toContain(
      "Run `vp test` in your own shell in this checkout (repo tool `unit-tests`).",
    );
    expect(section(text, "test")).toContain("Exit code 0 is `pass`, anything else `fail`");
    expect(section(text, "lint")).toContain("Stop it after 3 minutes and count that as `fail`.");
  });

  it("gate by user ends the turn; by lead the orchestrator decides", () => {
    const text = prompt(
      crewOf(
        {
          work: { ...task, next: "ask" },
          ask: {
            type: "gate",
            prompt: "Ship {{inputs.brief}}?",
            outcomes: { yes: "pick", no: "work" },
          },
          pick: { type: "gate", by: "lead", prompt: "Which?", outcomes: { a: "done" } },
          done: end,
        },
        {
          roles: { worker, lead: { name: "Lead", instructions: "Lead." } },
          home: { mode: "lead", role: "lead" },
        },
      ),
    );
    expect(section(text, "ask")).toContain(
      "End your turn and ask the user: Ship add a /health route? Route on their answer.",
    );
    expect(section(text, "pick")).toContain(
      "Decide yourself: Which? If you cannot decide, ask the user.",
    );
  });

  it("isolation worktree and read-only", () => {
    const text = prompt(
      crewOf({
        work: { ...task, isolation: "worktree", next: "look" },
        look: { ...task, isolation: "read-only", next: "done" },
        done: end,
      }),
    );
    expect(section(text, "work")).toContain(
      'Pass `isolation: "worktree"`: the worker gets its own checkout from this checkout\'s `HEAD`.',
    );
    expect(section(text, "look")).toContain(
      "Read-only: omit `isolation` and tell the worker to create, edit, and delete no files.",
    );
    expect(section(text, "look")).not.toContain("commit");
  });

  it("autoCommit tells the implementer whether to commit", () => {
    const text = prompt(
      crewOf({
        work: { ...task, next: "more" },
        more: { ...task, autoCommit: false, next: "done" },
        done: end,
      }),
    );
    expect(section(text, "work")).toContain("Tell the worker to commit its changes");
    expect(section(text, "more")).toContain("Tell the worker not to commit");
  });

  it("step timeoutMinutes waits on the worker and cancels it when it runs over", () => {
    const text = prompt(crewOf({ work: { ...task, timeoutMinutes: 20, next: "done" }, done: end }));
    expect(section(text, "work")).toContain(
      'Dispatch it with `mode: "wait"` and `timeoutMs: 1200000`. If the wait times out, cancel it with `task_cancel` and treat it as `RESULT: blocked`.',
    );
  });

  it("limits.maxHours sets the run deadline and limits.maxCards the dispatch budget", () => {
    const text = prompt(
      crewOf(
        { work: { ...task, next: "done" }, done: end },
        { limits: { maxHours: 2, maxCards: 9 } },
      ),
    );
    expect(text).toContain("- At most 9 dispatches in this run");
    expect(text).toContain("- The run ends 2 hours after it starts.");
    expect(text).toContain("`LIMIT: ...` means: dispatch nothing more and write the final report");
  });

  it("artifacts, produces, and consumes pass through files in the run folder", () => {
    const text = prompt(
      crewOf(
        {
          plan: { ...task, produces: ["plan"], next: "build" },
          build: { ...task, consumes: ["plan"], task: "Build {{artifacts.plan}}", next: "done" },
          done: end,
        },
        {
          artifacts: {
            plan: { type: "object", schema: { tasks: { type: "list", item: { id: "string" } } } },
            notes: { type: "markdown" },
          },
        },
      ),
    );
    expect(section(text, "plan")).toContain(
      "It must hand over `plan`: after its detail lines, one fenced block per artifact",
    );
    expect(text).toContain(
      '## Artifacts\n\n- `plan`: a JSON object shaped as `{"tasks":{"type":"list","item":{"id":"string"}}}`\n- `notes`: markdown text, as a JSON string',
    );
    expect(section(text, "plan")).toContain(
      "Save each to `artifacts/<name>.json` in the run folder.",
    );
    expect(section(text, "build")).toContain(
      "Paste the artifacts `plan` from the run folder into the task.",
    );
    expect(section(text, "build")).toContain("> Build {{artifacts.plan}}");
  });

  it("onNoReport sets what happens to a worker without a RESULT line", () => {
    const text = prompt(
      crewOf(
        { work: { ...task, onNoReport: "done", next: "done" }, done: end },
        { defaults: { onNoReport: "ask" } },
      ),
    );
    expect(text).toContain(
      "If a worker ends its turn without a `RESULT:` line, end your turn and ask the user what to do. A step below can override this.",
    );
    expect(section(text, "work")).toContain(
      "For this step: if a worker ends its turn without a `RESULT:` line, treat it as `RESULT: done`.",
    );
    expect(prompt(crewOf({ work: { ...task, next: "done" }, done: end }))).toContain(
      "send it one `t3_thread_send` asking for that line (a dispatch). If it still has none, ask the user.",
    );
  });

  it("home lead mode makes the orchestrator the lead, with its own ownership and tools", () => {
    const crew = crewOf(
      { work: { ...task, next: "wrap" }, wrap: { ...task, role: "lead", next: "done" }, done: end },
      {
        roles: {
          worker,
          lead: { name: "Lead", instructions: "You coordinate.", owns: ["docs/**"] },
        },
        home: { mode: "lead", role: "lead", canEdit: true, updates: "decisions" },
      },
    );
    const leadRole = roles(crew).find((role) => role.id === "lead")!;
    const text = prompt(crew, {
      roles: [
        ...roles(crew).filter((role) => role.id !== "lead"),
        {
          ...leadRole,
          toolbox: {
            items: [
              { kind: "tool", name: "lint", path: "tools.yaml", source: "repo", grantedBy: [] },
            ],
            diagnostics: [],
          },
        },
      ],
      tools: { tools: { lint: { run: "vp lint" } } },
    });
    expect(text).toContain(
      '## Your role\n\nYou are the Lead of the "Example" crew.\n\nYou coordinate.\n\nYou edit only: `docs/**`.\n\nYour tools: tool `lint`: run `vp lint`.',
    );
    expect(text).toContain("Message the user only for their decisions and the final report.");
    expect(text).toContain("You may edit this checkout for the steps you do yourself.");
    expect(section(text, "wrap")).toContain("You do this step yourself, in this thread.");
    expect(text).not.toContain("| `lead` Lead |");
    const firstStep = prompt(crewOf({ work: { ...task, next: "done" }, done: end }));
    expect(firstStep).toContain("You do not edit project files yourself.");
    expect(firstStep).not.toContain("## Your role");
  });
});
