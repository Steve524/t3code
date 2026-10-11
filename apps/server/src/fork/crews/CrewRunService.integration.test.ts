import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpServer } from "effect/ai";
import * as SqlClient from "effect/sql/SqlClient";

import type {
  CrewRunStartInput,
  CrewRunView,
} from "../../../../../packages/contracts/src/fork/crews/crewRun.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as CrewCatalog from "./CrewCatalog.ts";
import * as CrewRunService from "./CrewRunService.ts";
import {
  claude,
  codex,
  projectId,
  withCrewRuns,
  type AgentTurn,
  type CrewRunHarness,
} from "./CrewRunService.testkit.ts";

// A crew with nothing parallel in it: plan, build, then review with a fix loop and the
// user's approval. The fixer continues in the builder's thread.
const PLAN_REVIEW = `version: 1
id: plan-review
name: Plan review
inputs:
  brief: { type: text, required: true }
roles:
  planner:
    name: Planner
    instructions: You plan the work.
    model: { driver: claudeAgent, model: claude-opus-5-5 }
  implementer:
    name: Implementer
    model: { driver: codex, model: gpt-5.6-terra }
  reviewer:
    name: Reviewer
    instructions: You review the work.
    model: { driver: codex, model: gpt-5.6-luna }
artifacts:
  plan: { type: object, schema: { tasks: "string[]" } }
flow:
  start: plan
  steps:
    plan:
      role: planner
      task: "Plan this work: {{inputs.brief}}"
      produces: [plan]
      next: build
    build:
      role: implementer
      task: Build the plan.
      consumes: [plan]
      next: review
    review:
      role: reviewer
      task: Review the work.
      outcomes:
        approve: approval
        changes: { to: fix, max: 2, else: approval }
    fix:
      role: implementer
      continue: same-thread
      task: "Address the review findings: {{steps.review.summary}}"
      next: review
    approval:
      type: gate
      prompt: Approve the changes?
      outcomes: { approve: done, reject: fix }
    done:
      type: end
`;

/** Installs `plan-review` in T3 home, with a skill only its implementer has. */
const installPlanReview = Effect.fn("installPlanReview")(function* (harness: CrewRunHarness) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const implementer = path.join(harness.home, "crews", "plan-review", "roles", "implementer");
  const skill = path.join(implementer, "skills", "build-guide");
  yield* fileSystem.makeDirectory(skill, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(harness.home, "crews", "plan-review", "crew.yaml"),
    PLAN_REVIEW,
  );
  yield* fileSystem.writeFileString(
    path.join(implementer, "role.md"),
    "You build what the plan asks for.",
  );
  yield* fileSystem.writeFileString(
    path.join(skill, "SKILL.md"),
    "---\nname: build-guide\ndescription: How this crew builds.\n---\n\nRun the tests before you report.\n",
  );
  const catalog = yield* CrewCatalog.CrewCatalog;
  const detail = yield* catalog.get({ projectId, crewId: "plan-review" });
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

/** The latest card of a step. */
const card = (view: CrewRunView, stepId: string) =>
  view.cards.findLast(
    (candidate) => candidate.stepId === stepId && candidate.stepType !== "decision",
  );

/** The first line of a card prompt's task, which tells the fake agent which step it is on. */
const taskOf = (turn: AgentTurn) => turn.text.split("\n")[2] ?? "";

describe("crew runs", () => {
  it.live("starts a first-step crew in the home thread, and stops it on cancel", () =>
    withCrewRuns(McpServer.McpServer, (harness) =>
      Effect.gen(function* () {
        const runs = yield* CrewRunService.CrewRunService;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const planning = yield* Deferred.make<{
          readonly turn: AgentTurn;
          readonly refused: unknown;
        }>();
        // The planner reports a plan whose second task has no `owns`, then keeps its turn open.
        harness.agent.script = (turn) =>
          Effect.gen(function* () {
            const refused = yield* harness.tool(turn, "crew_report", {
              outcome: "done",
              summary: "Two tasks.",
              artifacts: {
                plan: {
                  tasks: [
                    { id: "a", title: "Route", brief: "Add it.", owns: ["src/health.ts"] },
                    { id: "b", title: "Test", brief: "Test it." },
                  ],
                },
              },
            });
            yield* Deferred.succeed(planning, { turn, refused });
            return null;
          });

        const run = yield* runs.start(startInput("feature-trio", "home"));
        const homeThreadId = run.homeThreadId ?? ThreadId.make("missing");
        const home = yield* threads.getThreadProjection(homeThreadId);
        expect(home.thread.branch).toMatch(/^crew\/feature-trio\/[0-9a-f]{8}$/u);
        expect(home.thread.modelSelection).toMatchObject({
          instanceId: claude,
          model: "claude-opus-5-5",
        });
        expect(home.thread.interactionMode).toBe("plan");
        const prompt = home.messages[0]?.text ?? "";
        expect(prompt).toContain("add a /health route");
        expect(prompt).toContain("You turn a brief into a short plan");
        expect(prompt).toContain("Required artifact `plan`");
        expect(prompt).toContain("Call `crew_report` once");

        const { turn, refused } = yield* Deferred.await(planning);
        expect(turn).toMatchObject({ instanceId: claude, threadId: homeThreadId });
        expect(turn.text).toContain("add a /health route");
        // The refusal names the field, and the card took nothing from it.
        expect(refused).toMatchObject({
          ok: false,
          value: {
            _tag: "CrewMcpFailure",
            code: "invalid_report",
            message: expect.stringContaining("plan.tasks[1].owns is required."),
          },
        });
        const board = yield* runs.get(run.runId);
        expect(board).toMatchObject({
          status: "running",
          crewName: "Feature trio",
          homeMode: "first-step",
          homeThreadId,
          integrationBranch: home.thread.branch,
        });
        expect(card(board, "plan")).toMatchObject({
          cardId: `${run.runId}:plan:1`,
          roleId: "planner",
          threadId: homeThreadId,
          state: "working",
          lane: "working",
          column: "plan",
          outcome: null,
        });

        // The same request finds the same run and launches nothing more.
        expect(yield* runs.start(startInput("feature-trio", "home"))).toEqual(run);
        expect(yield* Ref.get(harness.turns)).toHaveLength(1);

        const byThread = yield* runs.subscribeByThread(homeThreadId).pipe(Stream.runHead);
        expect(Option.getOrThrow(byThread)?.runId).toBe(run.runId);
        const unrelated = yield* runs
          .subscribeByThread(ThreadId.make("thread:unrelated"))
          .pipe(Stream.runHead);
        expect(unrelated).toEqual(Option.some(null));

        yield* runs.pause(run.runId);
        expect((yield* runs.get(run.runId)).status).toBe("paused");
        yield* runs.resume(run.runId);
        expect((yield* runs.get(run.runId)).status).toBe("running");

        yield* runs.cancel(run.runId);
        expect((yield* runs.get(run.runId)).status).toBe("cancelled");
        const stopped = yield* threads.waitForThread({
          projectId,
          threadId: homeThreadId,
          timeoutMs: 60_000,
        });
        expect(stopped.timedOut).toBe(false);
        expect(["interrupted", "cancelled"]).toContain(stopped.run?.status);
        yield* runs.drain;
        expect(yield* Ref.get(harness.turns)).toHaveLength(1);
        expect(card(yield* runs.get(run.runId), "plan")?.lane).toBe("skipped");
      }),
    ),
  );

  it.live("runs plan, build, review, fix, review and approval to completion", () =>
    withCrewRuns(McpServer.McpServer, (harness) =>
      Effect.gen(function* () {
        yield* installPlanReview(harness);
        const runs = yield* CrewRunService.CrewRunService;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const sql = yield* SqlClient.SqlClient;
        const reports: Array<{ readonly instanceId: string; readonly ok: boolean }> = [];
        const skills: Record<string, unknown> = {};
        let reviews = 0;
        harness.agent.script = (turn) =>
          Effect.gen(function* () {
            const task = taskOf(turn);
            const report = (input: Record<string, unknown>) =>
              harness.tool(turn, "crew_report", input).pipe(
                Effect.map((result) => {
                  reports.push({ instanceId: turn.instanceId, ok: result.ok });
                }),
              );
            if (task.startsWith("Plan this work")) {
              yield* report({
                outcome: "done",
                summary: "One task.",
                artifacts: { plan: { tasks: ["health route"] } },
              });
            } else if (task.startsWith("Build the plan")) {
              skills.implementer = yield* harness.tool(turn, "crew_skill_get", {
                name: "build-guide",
              });
              yield* report({ outcome: "done", summary: "Built the route." });
            } else if (task.startsWith("Review the work")) {
              reviews += 1;
              if (reviews === 1) {
                skills.reviewer = yield* harness.tool(turn, "crew_skill_get", {
                  name: "build-guide",
                });
                yield* report({ outcome: "changes", summary: "Handle the 404." });
              } else yield* report({ outcome: "approve", summary: "Good to ship." });
            } else if (task.startsWith("Address the review findings")) {
              yield* report({ outcome: "done", summary: "Handled the 404." });
            }
            return "Turn finished.";
          });

        const run = yield* runs.start(startInput("plan-review", "sequential"));
        const gate = yield* harness.until(
          run.runId,
          (view) => card(view, "approval")?.lane === "needs_you",
        );
        expect(gate.cards.map((candidate) => `${candidate.stepId}:${candidate.visit}`)).toEqual([
          "plan:1",
          "build:1",
          "review:1",
          "fix:1",
          "review:2",
          "approval:1",
        ]);
        expect(gate.status).toBe("waiting");
        expect(card(gate, "approval")?.gate).toEqual({
          prompt: "Approve the changes?",
          outcomes: ["approve", "reject"],
          by: "user",
        });
        // The reviewer sent the work back once, and five agent turns ran.
        expect(gate.routes).toEqual([
          { id: "review/outcome/changes", label: "review changes", used: 1, max: 2 },
        ]);
        expect(gate.budget.cards.used).toBe(5);

        // A role on Claude and roles on Codex report through the same tool.
        expect(reports).toEqual([
          { instanceId: claude, ok: true },
          { instanceId: codex, ok: true },
          { instanceId: codex, ok: true },
          { instanceId: codex, ok: true },
          { instanceId: codex, ok: true },
        ]);

        // The fix is a follow-up in the builder's thread, carrying the review's findings.
        const turns = yield* Ref.get(harness.turns);
        const [plan, build, , fix] = turns;
        expect(turns).toHaveLength(5);
        expect(plan?.threadId).toBe(run.homeThreadId);
        expect(fix?.threadId).toBe(build?.threadId);
        expect(fix?.text).toContain("Address the review findings: Handle the 404.");
        expect(new Set(turns.map((turn) => turn.threadId)).size).toBe(4);
        expect(card(gate, "fix")?.threadId).toBe(card(gate, "build")?.threadId);
        const builder = yield* threads.getThreadProjection(
          build?.threadId ?? ThreadId.make("missing"),
        );
        expect(builder.messages.filter((message) => message.role === "user")).toHaveLength(2);

        // A skill in the implementer's own folder is the implementer's alone.
        expect(skills.implementer).toMatchObject({
          ok: true,
          value: {
            name: "build-guide",
            content: expect.stringContaining("Run the tests before you report."),
          },
        });
        expect(skills.reviewer).toMatchObject({
          ok: false,
          value: { _tag: "CrewMcpFailure", code: "not_allowed" },
        });

        yield* runs.resolveGate({
          runId: run.runId,
          cardId: card(gate, "approval")?.cardId ?? "",
          outcome: "approve",
          note: "Ship it.",
        });
        const done = yield* runs.get(run.runId);
        expect(done.status).toBe("completed");
        expect(card(done, "approval")).toMatchObject({
          lane: "done",
          outcome: "approve",
          decidedBy: "user",
          summary: "Ship it.",
        });
        // The user's decision gave the reviewer its send-backs back.
        expect(done.routes[0]?.used).toBe(0);
        expect(yield* runs.list({ projectId })).toMatchObject([
          { runId: run.runId, crewName: "Plan review", status: "completed", needsYou: 0 },
        ]);

        // Only inputs are stored as events; what the engine derived from each sits beside it.
        yield* runs.drain;
        const events = yield* sql<{ readonly type: string; readonly facts: string }>`
          SELECT type AS "type", facts_json AS "facts" FROM fork_crew_events
          WHERE run_id = ${run.runId} ORDER BY seq
        `;
        const inputs = new Set(events.map((event) => event.type));
        expect([...inputs].toSorted()).toEqual([
          "card.dispatched",
          "card.reported",
          "card.turn_finished",
          "gate.resolved",
          "run.created",
        ]);
        const facts = events.flatMap((event) =>
          (JSON.parse(event.facts) as ReadonlyArray<{ readonly type: string }>).map(
            (fact) => fact.type,
          ),
        );
        expect(facts).toEqual(
          expect.arrayContaining([
            "step.entered",
            "card.created",
            "card.completed",
            "gate.opened",
            "route.counters_reset",
            "run.completed",
          ]),
        );
        expect(facts.filter((fact) => inputs.has(fact))).toEqual([]);

        // Everything the run persisted or sent to the orchestrator carries the run's id.
        const ids = yield* sql<{ readonly id: string }>`
          SELECT card_id AS "id" FROM fork_crew_cards WHERE run_id = ${run.runId}
          UNION ALL SELECT effect_id FROM fork_crew_outbox WHERE run_id = ${run.runId}
          UNION ALL SELECT thread_id FROM fork_crew_thread_index WHERE run_id = ${run.runId}
        `;
        expect(ids.length).toBeGreaterThan(10);
        expect(ids.filter(({ id }) => !id.includes(run.runId))).toEqual([]);
        const unfinished = yield* sql`
          SELECT effect_id FROM fork_crew_outbox
          WHERE run_id = ${run.runId} AND status <> 'done'
        `;
        expect(unfinished).toEqual([]);
      }),
    ),
  );

  it.live("takes a crew-report block, reminds a silent role once, then asks the user", () =>
    withCrewRuns(McpServer.McpServer, (harness) =>
      Effect.gen(function* () {
        yield* installPlanReview(harness);
        const runs = yield* CrewRunService.CrewRunService;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const reviewing = yield* Deferred.make<AgentTurn>();
        harness.agent.script = (turn) => {
          const task = taskOf(turn);
          // The planner has no tools, so it ends its message with the block.
          if (task.startsWith("Plan this work")) {
            const report = {
              outcome: "done",
              summary: "Planned by block.",
              artifacts: { plan: { tasks: ["health route"] } },
            };
            return Effect.succeed(
              `Here is the plan.\n\n\`\`\`crew-report\n${JSON.stringify(report)}\n\`\`\`\n`,
            );
          }
          // The reviewer keeps its turn open, so the run has a card to stop.
          if (task.startsWith("Review the work")) {
            return Deferred.succeed(reviewing, turn).pipe(Effect.as(null));
          }
          // The builder never reports, not even when reminded.
          return Effect.succeed("I am done.");
        };

        const run = yield* runs.start(
          startInput("plan-review", "silent", { mode: "current-checkout" }),
        );
        const asked = yield* harness.until(run.runId, (view) =>
          view.cards.some(
            (candidate) => candidate.stepType === "decision" && candidate.lane === "needs_you",
          ),
        );
        expect(card(asked, "plan")).toMatchObject({
          lane: "done",
          outcome: "done",
          summary: "Planned by block.",
        });

        // One reminder in the builder's own thread, and a second attempt on the same card.
        const build = card(asked, "build");
        const buildTurns = (yield* Ref.get(harness.turns)).filter(
          (turn) => turn.threadId === build?.threadId,
        );
        expect(buildTurns).toHaveLength(2);
        expect(buildTurns[0]?.text).toContain("## Task\n\nBuild the plan.");
        expect(buildTurns[1]?.text).toContain(
          "You ended your turn without `crew_report`. Report now with one of: done, failed.",
        );
        expect(build).toMatchObject({
          state: "blocked",
          lane: "needs_you",
          attempt: 2,
          outcome: "no_report",
        });
        // The reminder ran an agent, so it counts as a card; no route was taken for it.
        expect(asked.budget.cards.used).toBe(3);
        expect(asked.routes.map((route) => route.used)).toEqual([0]);

        // In a first-step run the decision is the user's.
        const decision = asked.cards.find((candidate) => candidate.stepType === "decision");
        expect(decision).toMatchObject({
          lane: "needs_you",
          sourceCardId: build?.cardId,
          gate: { by: "user", outcomes: ["done"] },
        });
        yield* runs.resolveGate({
          runId: run.runId,
          cardId: decision?.cardId ?? "",
          outcome: "done",
        });

        // Cancelling stops the one running card and launches nothing after it.
        const review = yield* Deferred.await(reviewing);
        yield* runs.cancel(run.runId);
        const stopped = yield* threads.waitForThread({
          projectId,
          threadId: review.threadId,
          timeoutMs: 60_000,
        });
        expect(stopped.timedOut).toBe(false);
        expect(["interrupted", "cancelled"]).toContain(stopped.run?.status);
        yield* runs.drain;
        expect((yield* runs.get(run.runId)).status).toBe("cancelled");
        expect(yield* Ref.get(harness.turns)).toHaveLength(4);
      }),
    ),
  );

  it.live("keeps a run's toolbox as it was when the run started", () =>
    withCrewRuns(McpServer.McpServer, (harness) =>
      Effect.gen(function* () {
        const runs = yield* CrewRunService.CrewRunService;
        const catalog = yield* CrewCatalog.CrewCatalog;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        harness.agent.script = () => Effect.succeed(null);
        const storybook = (args: string) => ({
          name: "storybook",
          source: "repo",
          command: "npx",
          args: [args],
          env: {},
        });
        const toolbox = (view: CrewRunView, roleId: string) =>
          view.roles.find((role) => role.id === roleId)?.toolbox;

        const first = yield* runs.start(
          startInput("feature-trio", "frozen-1", { mode: "current-checkout" }),
        );
        const planner = {
          threadId: first.homeThreadId ?? ThreadId.make("missing"),
          instanceId: claude,
        };
        const before = yield* runs.get(first.runId);
        expect(before.toolboxMode).toBe("extend");
        expect(toolbox(before, "implementer")?.mcp).toEqual(
          expect.arrayContaining([
            {
              name: "playwright",
              source: "home",
              command: "npx",
              args: ["@playwright/mcp@latest"],
              env: {},
            },
            storybook("storybook-mcp"),
          ]),
        );
        const contextBefore = yield* harness.tool(planner, "crew_context");
        expect(contextBefore).toMatchObject({
          ok: true,
          value: { runId: first.runId, role: { id: "planner" }, outcomes: ["done"] },
        });
        const skill = yield* harness.tool(planner, "crew_skill_get", { name: "repo-conventions" });
        expect(skill).toMatchObject({ ok: true });
        expect(skill.value).not.toHaveProperty("warning");

        // The project switches who wins a name collision, and edits its servers and a skill.
        yield* catalog.setToolboxMode({ projectId, mode: "override" });
        const mcpFile = path.join(harness.workspace, ".t3", "mcp.yaml");
        yield* fileSystem.writeFileString(
          mcpFile,
          (yield* fileSystem.readFileString(mcpFile)).replace(
            "storybook-mcp",
            "storybook-mcp-next",
          ),
        );
        yield* fileSystem.writeFileString(
          path.join(harness.workspace, ".t3", "skills", "repo-conventions", "SKILL.md"),
          "---\nname: repo-conventions\ndescription: Changed.\n---\n\nNew conventions.\n",
        );

        const after = yield* runs.get(first.runId);
        expect(after.toolboxMode).toBe("extend");
        expect(after.roles).toEqual(before.roles);
        expect(yield* harness.tool(planner, "crew_context")).toEqual(contextBefore);
        // A skill is read when used, so the run sees the new text and is told it changed.
        expect(
          yield* harness.tool(planner, "crew_skill_get", { name: "repo-conventions" }),
        ).toMatchObject({
          ok: true,
          value: {
            content: expect.stringContaining("New conventions."),
            warning: expect.stringContaining("changed on disk"),
          },
        });

        // The next run starts from the project's toolbox as it is now.
        const second = yield* runs.start(
          startInput("feature-trio", "frozen-2", { mode: "current-checkout" }),
        );
        const next = yield* runs.get(second.runId);
        expect(next.toolboxMode).toBe("override");
        expect(toolbox(next, "implementer")?.mcp).toContainEqual(storybook("storybook-mcp-next"));
      }),
    ),
  );
});
