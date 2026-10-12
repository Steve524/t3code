import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { McpServer } from "effect/ai";
import * as SqlClient from "effect/sql/SqlClient";

import type {
  CrewRunCard,
  CrewRunStartInput,
  CrewRunView,
} from "../../../../../packages/contracts/src/fork/crews/crewRun.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as CrewCatalog from "./CrewCatalog.ts";
import * as CrewRunService from "./CrewRunService.ts";
import {
  claude,
  codex,
  codexB,
  projectId,
  withCrewRuns,
  type AgentTurn,
  type CrewRunHarness,
} from "./CrewRunService.testkit.ts";

// Plan, build each task in a worktree of its own, merge the branches, then run a script on
// the result. The builder resolves merge conflicts, and a branch that strays from its paths
// is held back.
const FAN = `version: 1
id: fan
name: Fan
inputs:
  brief: { type: text, required: true }
roles:
  planner:
    name: Planner
    instructions: You plan the work.
    model: { driver: claudeAgent, model: claude-opus-5-5 }
  builder:
    name: Builder
    instructions: You build one task.
    model: { driver: codex, model: gpt-5.6-terra }
    pool: [codex, codex-b]
    tools: [branch]
artifacts:
  plan:
    type: object
    schema:
      tasks: { type: list, item: { id: string, owns: "string[]" } }
flow:
  start: plan
  steps:
    plan:
      role: planner
      task: "Plan this work: {{inputs.brief}}"
      produces: [plan]
      next: build
    build:
      type: fanout
      over: artifacts.plan.tasks
      role: builder
      task: "Build task {{item.id}}"
      owns: "{{item.owns}}"
      maxParallel: 3
      next: integrate
    integrate:
      type: merge
      onConflict: { role: builder }
      checkOwnership: block
      next: check
    check:
      type: script
      run: git rev-parse --abbrev-ref HEAD
      next: done
    done:
      type: end
`;

// Twenty tasks against the default fan-out limit of twelve, and a card budget of two.
const BUDGET = `version: 1
id: budget
name: Budget
inputs:
  brief: { type: text, required: true }
limits: { maxCards: 2 }
roles:
  planner:
    name: Planner
    instructions: You plan the work.
    model: { driver: claudeAgent, model: claude-opus-5-5 }
  builder:
    name: Builder
    instructions: You build one task.
    model: { driver: codex, model: gpt-5.6-terra }
artifacts:
  plan:
    type: object
    schema:
      tasks: { type: list, item: { id: string } }
flow:
  start: plan
  steps:
    plan:
      role: planner
      task: "Plan this work: {{inputs.brief}}"
      produces: [plan]
      next: build
    build:
      type: fanout
      over: artifacts.plan.tasks
      role: builder
      task: "Build task {{item.id}}"
      isolation: shared
      owns: "{{item.id}}.txt"
      next: done
    done:
      type: end
`;

// A silent role is asked about at once, so the test can answer with each card control.
const CONTROLS = `version: 1
id: controls
name: Controls
inputs:
  brief: { type: text, required: true }
defaults: { onNoReport: ask }
roles:
  implementer:
    name: Implementer
    instructions: You build.
    model: { driver: codex, model: gpt-5.6-terra }
  reviewer:
    name: Reviewer
    instructions: You review.
    model: { driver: codex, model: gpt-5.6-luna }
flow:
  start: build
  steps:
    build:
      role: implementer
      task: "Build this: {{inputs.brief}}"
      next: review
    review:
      role: reviewer
      task: Review the work.
      outcomes:
        approve: done
        changes: { to: fix, max: 2, else: done }
    fix:
      role: implementer
      continue: same-thread
      task: Fix the findings.
      next: review
    done:
      type: end
`;

const install = Effect.fn("install")(function* (
  harness: CrewRunHarness,
  crewId: string,
  yaml: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(harness.home, "crews", crewId);
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(path.join(directory, "crew.yaml"), yaml);
  // One quick tool that says which checkout it ran in.
  yield* fileSystem.writeFileString(
    path.join(harness.workspace, ".t3", "tools.yaml"),
    "tools:\n  branch:\n    description: Print a ref's branch name\n    run: git rev-parse --abbrev-ref\n",
  );
  const catalog = yield* CrewCatalog.CrewCatalog;
  const detail = yield* catalog.get({ projectId, crewId });
  expect(detail.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
});

const startInput = (
  crewId: string,
  clientRequestId: string,
  workspace: CrewRunStartInput["workspace"] = { mode: "new-worktree", baseRef: "main" },
): CrewRunStartInput => ({
  projectId,
  crewId,
  inputs: { brief: "add a /health route" },
  attachments: [],
  workspace,
  runtimeMode: "full-access",
  clientRequestId,
});

/** The first line of a card prompt's task, which tells the fake agent which step it is on. */
const taskOf = (turn: AgentTurn) => turn.text.split("\n")[2] ?? "";
const cardsOf = (view: CrewRunView, stepId: string) =>
  view.cards.filter((card) => card.stepId === stepId && card.stepType !== "decision");
/** The latest card of a step. */
const card = (view: CrewRunView, stepId: string) => cardsOf(view, stepId).at(-1);
const agentOf = (target: CrewRunCard) => ({
  threadId: target.threadId ?? ThreadId.make("missing"),
  instanceId: target.modelSelection?.instanceId ?? codex,
});

/** A planner that hands over `tasks`, and builders whose turns stay open for the test to end. */
const planThenWait = (harness: CrewRunHarness, tasks: ReadonlyArray<Record<string, unknown>>) => {
  harness.agent.script = (turn) =>
    taskOf(turn).startsWith("Plan this work")
      ? harness
          .tool(turn, "crew_report", {
            outcome: "done",
            summary: `${tasks.length} tasks.`,
            artifacts: { plan: { tasks } },
          })
          .pipe(Effect.as("Planned."))
      : Effect.succeed(null);
};

/** What a builder does in its worktree: writes files, reports, and ends its turn. */
const build = Effect.fn("build")(function* (
  harness: CrewRunHarness,
  target: CrewRunCard,
  files: Readonly<Record<string, string>>,
  summary: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [name, text] of Object.entries(files)) {
    yield* fileSystem.writeFileString(path.join(target.worktreePath!, name), text);
  }
  const reported = yield* harness.tool(agentOf(target), "crew_report", {
    outcome: "done",
    summary,
  });
  expect(reported.ok).toBe(true);
  yield* harness.finish(agentOf(target).threadId, "Built.");
});

describe("crew runs in git", () => {
  it.live("builds a fan-out in worktrees three at a time, commits each card and merges them", () =>
    withCrewRuns(McpServer.McpServer, (harness) =>
      Effect.gen(function* () {
        yield* install(harness, "fan", FAN);
        const runs = yield* CrewRunService.CrewRunService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const ids = ["a", "b", "c", "d"];
        planThenWait(
          harness,
          ids.map((id) => ({ id, owns: [`${id}.txt`] })),
        );

        const run = yield* runs.start(startInput("fan", "fan-out"));
        const short = run.runId.slice(-8);
        const started = yield* harness.until(
          run.runId,
          (view) =>
            cardsOf(view, "build").filter((built) => built.state === "working").length === 3,
        );
        const integration = started.integrationWorktree ?? "";
        const working = cardsOf(started, "build");
        expect(working.map((built) => built.lane)).toEqual([
          "working",
          "working",
          "working",
          "queued",
        ]);
        // Each working card has its own worktree and branch, cut from the integration head.
        const head = yield* harness.git(integration, "rev-parse", "HEAD");
        expect(working.map((built) => built.branch)).toEqual([
          `crew/${short}/build-1-0`,
          `crew/${short}/build-1-1`,
          `crew/${short}/build-1-2`,
          null,
        ]);
        const worktrees = working.slice(0, 3).map((built) => built.worktreePath ?? "");
        expect(new Set([...worktrees, integration]).size).toBe(4);
        for (const built of working.slice(0, 3)) {
          expect(yield* harness.git(harness.workspace, "rev-parse", built.branch ?? "")).toBe(head);
          expect(yield* harness.git(built.worktreePath ?? "", "rev-parse", "HEAD")).toBe(head);
        }
        // The role's pool spreads the cards over both Codex accounts.
        expect(working.map((built) => built.modelSelection?.instanceId)).toEqual([
          codex,
          codexB,
          codex,
          codexB,
        ]);

        // A role's tool runs in the card's own checkout, with plain arguments only.
        const first = working[0]!;
        expect(yield* harness.tool(agentOf(first), "crew_tool_list")).toMatchObject({
          ok: true,
          value: { tools: [{ name: "branch", source: "repo", run: "git rev-parse --abbrev-ref" }] },
        });
        expect(
          yield* harness.tool(agentOf(first), "crew_tool_run", { name: "branch", args: ["HEAD"] }),
        ).toMatchObject({
          ok: true,
          value: { exitCode: 0, timedOut: false, output: expect.stringContaining(first.branch!) },
        });
        expect(
          yield* harness.tool(agentOf(first), "crew_tool_run", { name: "branch", args: ["$(id)"] }),
        ).toMatchObject({ ok: false, value: { _tag: "CrewMcpFailure", code: "not_allowed" } });
        expect(
          yield* harness.tool(agentOf(first), "crew_tool_run", { name: "unit-tests" }),
        ).toMatchObject({ ok: false, value: { _tag: "CrewMcpFailure", code: "not_allowed" } });

        // One card finishes: its work is committed on its branch, and the queued card starts.
        yield* build(harness, first, { "a.txt": "a\n" }, "Add a\n\nWith details.");
        const next = yield* harness.until(
          run.runId,
          (view) =>
            cardsOf(view, "build")[0]?.lane === "done" &&
            cardsOf(view, "build")[3]?.state === "working",
        );
        const message = yield* harness.git(
          harness.workspace,
          "log",
          "-1",
          "--format=%B",
          first.branch!,
        );
        expect(message.split("\n")).toEqual([
          "crew(build): Add a",
          "",
          `Crew-Run: ${short}`,
          "Crew-Step: build#1 (visit 1, attempt 1)",
          "Crew-Role: builder",
          "Crew-Model: codex/gpt-5.6-terra",
        ]);
        // Git reads them as trailers, not as body text.
        expect(
          yield* harness.git(
            harness.workspace,
            "log",
            "-1",
            "--format=%(trailers:key=Crew-Role,valueonly)",
            first.branch!,
          ),
        ).toBe("builder");
        expect(cardsOf(next, "build")[3]?.branch).toBe(`crew/${short}/build-1-3`);

        for (const [index, built] of cardsOf(next, "build").entries()) {
          if (index > 0) {
            yield* build(harness, built, { [`${ids[index]}.txt`]: "x\n" }, `Add ${ids[index]}`);
          }
        }
        const done = yield* harness.until(run.runId, (view) => view.status === "completed");
        expect(card(done, "integrate")).toMatchObject({ stepType: "merge", lane: "done" });
        // The script ran in the integration checkout, after the merge.
        expect(card(done, "check")).toMatchObject({
          stepType: "script",
          lane: "done",
          outcome: "pass",
          summary: expect.stringContaining(`crew/fan/${short}`),
        });
        for (const id of ids) {
          expect(yield* fileSystem.exists(path.join(integration, `${id}.txt`))).toBe(true);
        }
        expect(
          yield* harness.git(
            harness.workspace,
            "log",
            "-1",
            "--format=%(trailers:key=Crew-Model,valueonly)",
            `crew/${short}/build-1-1`,
          ),
        ).toBe("codex-b/gpt-5.6-terra");
        // Each card's turn ran on the account its card was given, and was told of the role's tools.
        const turns = yield* Ref.get(harness.turns);
        const asked = cardsOf(done, "build").map((target) =>
          turns.find((turn) => turn.threadId === target.threadId),
        );
        expect(asked.map((turn) => turn?.instanceId)).toEqual([codex, codexB, codex, codexB]);
        expect(asked[0]?.text).toContain("## Tools\n\n- branch: Print a ref's branch name");
        // A plan, four builds and a script used the card budget. The merge is the crew's own.
        expect(done.budget.cards.used).toBe(6);

        // With the run over, the card worktrees are gone and their branches are kept.
        yield* runs.drain;
        for (const built of cardsOf(done, "build")) {
          expect(yield* fileSystem.exists(built.worktreePath ?? "")).toBe(false);
        }
        expect(yield* fileSystem.exists(integration)).toBe(true);
        const branches = yield* harness.git(harness.workspace, "branch", "--list", "crew/*");
        expect(branches.split("\n")).toHaveLength(5);
      }),
    ),
  );

  it.live("sends a merge conflict to the resolver role and commits what it resolved", () =>
    withCrewRuns(McpServer.McpServer, (harness) =>
      Effect.gen(function* () {
        yield* install(harness, "fan", FAN);
        const runs = yield* CrewRunService.CrewRunService;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        planThenWait(harness, [
          { id: "a", owns: ["README.md"] },
          { id: "b", owns: ["README.md"] },
        ]);
        const run = yield* runs.start(startInput("fan", "conflict"));
        const started = yield* harness.until(
          run.runId,
          (view) =>
            cardsOf(view, "build").filter((built) => built.state === "working").length === 2,
        );
        const integration = started.integrationWorktree ?? "";

        // The resolver edits the conflicted file in the shared checkout and leaves the commit. A
        // builder's turn can still be starting, so every other turn keeps its script.
        const resolving: Array<AgentTurn> = [];
        let conflicted = "";
        const builders = harness.agent.script;
        harness.agent.script = (turn) =>
          turn.text.includes("stopped on conflicts in:")
            ? Effect.gen(function* () {
                resolving.push(turn);
                const readme = path.join(integration, "README.md");
                conflicted = yield* fileSystem.readFileString(readme);
                yield* fileSystem.writeFileString(readme, "from a and b\n");
                yield* harness.tool(turn, "crew_report", {
                  outcome: "done",
                  summary: "Kept both lines.",
                });
                return "Resolved.";
              }).pipe(Effect.orDie)
            : builders(turn);

        // Both cards change the same line.
        const [first, second] = cardsOf(started, "build");
        yield* build(harness, first!, { "README.md": "from a\n" }, "Write a");
        yield* build(harness, second!, { "README.md": "from b\n" }, "Write b");
        const done = yield* harness.until(run.runId, (view) => view.status === "completed");

        const merge = done.cards.find((candidate) => candidate.stepType === "merge");
        const resolver = done.cards.find(
          (candidate) => candidate.sourceCardId === merge?.cardId && candidate.stepType === "task",
        );
        expect(merge).toMatchObject({ lane: "done", outcome: "done" });
        expect(resolver).toMatchObject({
          stepId: "integrate",
          roleId: "builder",
          lane: "done",
          summary: "Kept both lines.",
        });
        // It was dispatched once, in the integration checkout, with the conflicted path.
        expect(resolving).toHaveLength(1);
        expect(resolving[0]?.threadId).toBe(resolver?.threadId);
        expect(resolving[0]?.text).toContain("stopped on conflicts in:\n\n- README.md");
        expect(conflicted).toContain("<<<<<<< ");
        expect(conflicted).toContain("from a");
        expect(conflicted).toContain("from b");
        const shell = yield* threads.getThreadShell(resolver?.threadId ?? ThreadId.make("missing"));
        expect(shell?.worktreePath).toBe(integration);

        // Nothing is left unmerged, and the merge commit carries the resolver's name.
        expect(yield* harness.git(integration, "diff", "--name-only", "--diff-filter=U")).toBe("");
        expect(yield* harness.git(integration, "status", "--porcelain")).toBe("");
        expect(yield* fileSystem.readFileString(path.join(integration, "README.md"))).toBe(
          "from a and b\n",
        );
        const message = yield* harness.git(integration, "log", "-1", "--format=%B");
        expect(message.split("\n")).toEqual([
          "crew(integrate): Kept both lines.",
          "",
          `Crew-Run: ${run.runId.slice(-8)}`,
          "Crew-Step: integrate (visit 1, attempt 1)",
          "Crew-Role: builder",
          "Crew-Model: codex/gpt-5.6-terra",
        ]);
        const parents = yield* harness.git(integration, "rev-list", "--parents", "-n", "1", "HEAD");
        expect(parents.split(" ")).toHaveLength(3);
        expect(
          yield* harness.git(
            integration,
            "branch",
            "--no-merged",
            "HEAD",
            "--list",
            "crew/*",
            "--format=%(refname:short)",
          ),
        ).toBe("");
      }),
    ),
  );

  it.live("holds back a branch that changed paths its card does not own, and asks the user", () =>
    withCrewRuns(McpServer.McpServer, (harness) =>
      Effect.gen(function* () {
        yield* install(harness, "fan", FAN);
        const runs = yield* CrewRunService.CrewRunService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        planThenWait(harness, [
          { id: "a", owns: ["a.txt"] },
          { id: "b", owns: ["b.txt"] },
        ]);
        const run = yield* runs.start(startInput("fan", "ownership"));
        const started = yield* harness.until(
          run.runId,
          (view) =>
            cardsOf(view, "build").filter((built) => built.state === "working").length === 2,
        );
        const integration = started.integrationWorktree ?? "";
        const [first, second] = cardsOf(started, "build");
        yield* build(harness, first!, { "a.txt": "a\n" }, "Add a");
        yield* build(harness, second!, { "b.txt": "b\n", "other.txt": "stray\n" }, "Add b");

        const held = yield* harness.until(
          run.runId,
          (view) => card(view, "integrate")?.lane === "needs_you",
        );
        expect(held.status).toBe("waiting");
        expect(card(held, "integrate")?.gate).toEqual({
          by: "user",
          outcomes: ["done"],
          prompt: `Not merged: ${second?.branch} changed paths it does not own (other.txt).`,
        });
        expect(cardsOf(held, "build").map((built) => built.ownershipViolations)).toEqual([
          [],
          ["other.txt"],
        ]);
        // The card that kept to its paths is merged; the other is not.
        expect(yield* fileSystem.exists(path.join(integration, "a.txt"))).toBe(true);
        expect(yield* fileSystem.exists(path.join(integration, "b.txt"))).toBe(false);
        expect(yield* fileSystem.exists(path.join(integration, "other.txt"))).toBe(false);
        expect(
          yield* harness.git(
            integration,
            "branch",
            "--no-merged",
            "HEAD",
            "--list",
            "crew/*",
            "--format=%(refname:short)",
          ),
        ).toBe(second?.branch);
        expect(yield* runs.list({ projectId })).toMatchObject([{ runId: run.runId, needsYou: 1 }]);

        // The user lets the flow carry on without that branch.
        yield* runs.resolveGate({
          runId: run.runId,
          cardId: card(held, "integrate")?.cardId ?? "",
          outcome: "done",
        });
        const done = yield* harness.until(run.runId, (view) => view.status === "completed");
        expect(card(done, "integrate")).toMatchObject({ lane: "done", decidedBy: "user" });
        expect(yield* fileSystem.exists(path.join(integration, "b.txt"))).toBe(false);
      }),
    ),
  );

  it.live("stops at the fan-out limit and at the card budget until the user answers", () =>
    withCrewRuns(McpServer.McpServer, (harness) =>
      Effect.gen(function* () {
        yield* install(harness, "budget", BUDGET);
        const runs = yield* CrewRunService.CrewRunService;
        const tasks = Array.from({ length: 20 }, (_, index) => ({ id: `t${index}` }));
        harness.agent.script = (turn) =>
          harness
            .tool(
              turn,
              "crew_report",
              taskOf(turn).startsWith("Plan this work")
                ? { outcome: "done", summary: "Twenty tasks.", artifacts: { plan: { tasks } } }
                : { outcome: "done", summary: "Built." },
            )
            .pipe(Effect.as("Turn finished."));

        const run = yield* runs.start(
          startInput("budget", "budgets", { mode: "current-checkout" }),
        );
        // Twenty items against a limit of twelve: nothing launches, and the user is asked.
        const tooMany = yield* harness.until(run.runId, (view) => view.budget.gate !== null);
        expect(tooMany.status).toBe("waiting");
        expect(tooMany.budget).toMatchObject({
          fanoutItems: 12,
          gate: { kind: "maxFanoutItems", choices: ["all", "first", "stop"], total: 20 },
        });
        expect(cardsOf(tooMany, "build")).toEqual([]);
        yield* runs.drain;
        expect(yield* Ref.get(harness.turns)).toHaveLength(1);

        // The first two items run, and the second would be the run's third card of two.
        yield* runs.selectFanout({ runId: run.runId, choice: "first", count: 2 });
        const spent = yield* harness.until(
          run.runId,
          (view) => view.budget.gate?.kind === "maxCards",
        );
        expect(spent.status).toBe("waiting");
        expect(spent.budget).toMatchObject({
          cards: { used: 2, limit: 2 },
          gate: { kind: "maxCards", choices: ["extend", "stop"], total: null },
        });
        // The card that was running finished; the next one was not dispatched.
        expect(cardsOf(spent, "build").map((built) => built.lane)).toEqual(["done", "queued"]);
        yield* runs.drain;
        expect(yield* Ref.get(harness.turns)).toHaveLength(2);

        // Extending the budget resumes dispatch.
        yield* runs.extendBudget({ runId: run.runId, kind: "maxCards", by: 20 });
        const done = yield* harness.until(run.runId, (view) => view.status === "completed");
        expect(done.budget).toMatchObject({ cards: { used: 3, limit: 22 }, gate: null });
        expect(cardsOf(done, "build").map((built) => built.lane)).toEqual(["done", "done"]);
        expect(yield* Ref.get(harness.turns)).toHaveLength(3);

        // With no fan-out waiting, there is nothing to choose.
        expect(
          yield* Effect.flip(runs.selectFanout({ runId: run.runId, choice: "all" })),
        ).toMatchObject({ reason: "invalid_request" });
      }),
    ),
  );

  it.live("retries, skips and forces cards, changes a role's model and resets a route", () =>
    withCrewRuns(McpServer.McpServer, (harness) =>
      Effect.gen(function* () {
        yield* install(harness, "controls", CONTROLS);
        const runs = yield* CrewRunService.CrewRunService;
        const sql = yield* SqlClient.SqlClient;
        let builds = 0;
        let reviews = 0;
        harness.agent.script = (turn) =>
          Effect.gen(function* () {
            const task = taskOf(turn);
            const report = (outcome: string, summary: string) =>
              harness.tool(turn, "crew_report", { outcome, summary });
            if (task.startsWith("Build this")) {
              builds += 1;
              // The first attempt ends without a report.
              if (builds === 1) return "I am done.";
              yield* report("done", "Built.");
            } else if (task.startsWith("Review the work")) {
              reviews += 1;
              if (reviews === 2) return "No verdict.";
              yield* report("changes", "Tighten it.");
            } else if (task.startsWith("Fix the findings")) {
              yield* report("done", "Fixed.");
            }
            return "Turn finished.";
          });
        const waitingOn = (view: CrewRunView, stepId: string, visit: number) =>
          card(view, stepId)?.visit === visit &&
          view.cards.some(
            (candidate) =>
              candidate.stepType === "decision" &&
              candidate.lane === "needs_you" &&
              candidate.sourceCardId === card(view, stepId)?.cardId,
          );

        const run = yield* runs.start(
          startInput("controls", "controls", { mode: "current-checkout" }),
        );
        const silent = yield* harness.until(run.runId, (view) => waitingOn(view, "build", 1));
        const builder = card(silent, "build")!;
        expect(builder).toMatchObject({ state: "blocked", attempt: 1, outcome: "no_report" });

        // The reviewer moves to Claude before any of its cards is dispatched.
        const reviewer = silent.roles.find((role) => role.id === "reviewer")!;
        yield* runs.setRoleModel({
          runId: run.runId,
          roleId: "reviewer",
          selection: { ...reviewer.modelSelection, instanceId: claude, model: "claude-opus-5-5" },
        });
        expect(
          (yield* runs.get(run.runId)).roles.find((role) => role.id === "reviewer")?.modelSelection,
        ).toMatchObject({ instanceId: claude, model: "claude-opus-5-5" });

        // Retry: a second attempt of the same card, in its own thread, and the question is dropped.
        yield* runs.retryCard({ runId: run.runId, cardId: builder.cardId });
        const unsure = yield* harness.until(run.runId, (view) => waitingOn(view, "review", 2));
        expect(card(unsure, "build")).toMatchObject({
          cardId: builder.cardId,
          threadId: builder.threadId,
          attempt: 2,
          lane: "done",
          outcome: "done",
        });
        expect(
          unsure.cards.find((candidate) => candidate.sourceCardId === builder.cardId)?.lane,
        ).toBe("skipped");
        const turns = yield* Ref.get(harness.turns);
        expect(turns.map((turn) => turn.instanceId)).toEqual([codex, codex, claude, codex, claude]);
        expect(cardsOf(unsure, "review")[0]?.modelSelection).toMatchObject({ instanceId: claude });

        // The reviewer sent the work back once; a reset gives that send-back back.
        expect(unsure.routes).toMatchObject([{ used: 1, max: 2 }]);
        yield* runs.resetRoute({ runId: run.runId, routeId: unsure.routes[0]?.id ?? "" });
        expect((yield* runs.get(run.runId)).routes).toMatchObject([{ used: 0, max: 2 }]);

        // Skip: the step has no route for `skipped`, so the user is asked again.
        const review = card(unsure, "review")!;
        yield* runs.skipCard({ runId: run.runId, cardId: review.cardId });
        const skipped = yield* runs.get(run.runId);
        expect(card(skipped, "review")).toMatchObject({ state: "blocked", outcome: "skipped" });
        expect(
          skipped.cards
            .filter((candidate) => candidate.sourceCardId === review.cardId)
            .map((candidate) => candidate.lane),
        ).toEqual(["skipped", "needs_you"]);

        // Force: the card counts as having reported the chosen outcome, and the flow follows it.
        yield* runs.forceOutcome({ runId: run.runId, cardId: review.cardId, outcome: "approve" });
        const done = yield* runs.get(run.runId);
        expect(done.status).toBe("completed");
        expect(card(done, "review")).toMatchObject({ lane: "done", outcome: "approve" });
        expect(yield* Ref.get(harness.turns)).toHaveLength(5);

        // A card that already moved on takes none of these.
        expect(
          yield* Effect.flip(runs.retryCard({ runId: run.runId, cardId: review.cardId })),
        ).toMatchObject({ reason: "invalid_request" });
        const inputs = yield* sql<{ readonly type: string }>`
          SELECT DISTINCT type AS "type" FROM fork_crew_events WHERE run_id = ${run.runId}
        `;
        expect(inputs.map((input) => input.type)).toEqual(
          expect.arrayContaining([
            "user.card_action",
            "user.role_model_changed",
            "route.counters_reset",
          ]),
        );
      }),
    ),
  );
});
