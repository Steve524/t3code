import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { McpServer } from "effect/ai";
import * as SqlClient from "effect/sql/SqlClient";

import type {
  CrewRunCard,
  CrewRunStartInput,
  CrewRunView,
} from "../../../../../packages/contracts/src/fork/crews/crewRun.ts";
import { CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
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

// The full-stack team of spec 1 §5.7: an orchestrator leads from the home thread, two roles
// build in worktrees of their own, and the orchestrator decides who fixes what review finds.
// Only the orchestrator runs on Claude, which is how the fake agent knows the lead's turns.
const STACK = `version: 1
id: stack
name: Full-stack team
home:
  mode: lead
  role: orchestrator
inputs:
  brief: { type: text, required: true }
roles:
  orchestrator:
    name: Orchestrator
    instructions: You coordinate the team.
    model: { driver: claudeAgent, model: claude-opus-5-5 }
  architect:
    name: Architect
    instructions: You design the change.
    model: { driver: codex, model: gpt-5.6-terra }
  frontend:
    name: Frontend
    description: UI and components
    instructions: You build the UI.
    model: { driver: codex, model: gpt-5.6-terra }
  backend:
    name: Backend
    instructions: You build the API.
    model: { driver: codex, model: gpt-5.6-terra }
  qa:
    name: QA
    instructions: You review.
    model: { driver: codex, model: gpt-5.6-luna }
flow:
  start: design
  steps:
    design:
      role: architect
      task: "Design this: {{inputs.brief}}"
      next: build
    build:
      type: parallel
      branches: [ui, api]
      next: integrate
    ui:
      role: frontend
      task: Build the UI.
      isolation: worktree
      owns: ["web/**"]
    api:
      role: backend
      task: Build the API.
      isolation: worktree
      owns: ["server/**"]
    integrate:
      type: merge
      onConflict: { role: backend }
      next: review
    review:
      role: qa
      task: Review the merged work.
      outcomes:
        approve: ship
        changes: { to: triage, max: 3, else: ship }
    triage:
      type: gate
      by: lead
      prompt: Review asked for changes. Who fixes them?
      outcomes: { frontend: fix_ui, backend: fix_api, accept: ship }
    fix_ui:
      role: frontend
      continue: same-thread
      task: "Fix the UI:\\n{{steps.review.summary}}"
      next: integrate
    fix_api:
      role: backend
      continue: same-thread
      task: "Fix the API:\\n{{steps.review.summary}}"
      next: integrate
    ship:
      type: gate
      prompt: Approve the integrated changes?
      outcomes: { approve: done, reject: triage }
    done:
      type: end
`;

// A lead that may edit, hears of decisions only, and has a step of its own.
const led = (id: string, home: string) => `version: 1
id: ${id}
name: Led
home: { mode: lead, role: lead, updates: decisions${home} }
inputs:
  brief: { type: text, required: true }
roles:
  lead:
    name: Lead
    instructions: You lead.
    model: { driver: claudeAgent, model: claude-opus-5-5 }
  worker:
    name: Worker
    instructions: You build.
    model: { driver: codex, model: gpt-5.6-terra }
flow:
  start: build
  steps:
    build:
      role: worker
      task: "Build this: {{inputs.brief}}"
      next: check
    check:
      type: gate
      by: lead
      prompt: Is the work good?
      outcomes:
        yes: wrap
        no: { to: build, max: 2, else: wrap }
    wrap:
      role: lead
      task: Write the release note.
      next: done
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
  const catalog = yield* CrewCatalog.CrewCatalog;
  const detail = yield* catalog.get({ projectId, crewId });
  expect(detail.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
});

const startInput = (crewId: string, clientRequestId: string): CrewRunStartInput => ({
  projectId,
  crewId,
  inputs: { brief: "add a /health route" },
  attachments: [],
  workspace: { mode: "new-worktree", baseRef: "main" },
  runtimeMode: "full-access",
  clientRequestId,
});

const cardsOf = (view: CrewRunView, stepId: string) =>
  view.cards.filter((card) => card.stepId === stepId && card.stepType !== "decision");
/** The latest card of a step. */
const card = (view: CrewRunView, stepId: string) => cardsOf(view, stepId).at(-1);
const agentOf = (target: CrewRunCard) => ({
  threadId: target.threadId ?? ThreadId.make("missing"),
  instanceId: target.modelSelection?.instanceId ?? codex,
});
const isUpdate = (turn: AgentTurn) => /^## (Crew update|While you were working)/u.test(turn.text);

/**
 * Leaves every role's turn open for the test to end. The lead's turns are handed to the test
 * one at a time through `next`; while `hold` is off it acknowledges updates by itself.
 */
const scriptLead = Effect.fn("scriptLead")(function* (harness: CrewRunHarness) {
  const turns = yield* Queue.unbounded<AgentTurn>();
  const lead = { hold: true, next: Queue.take(turns), waiting: Queue.size(turns) };
  harness.agent.script = (turn) =>
    turn.instanceId !== claude
      ? Effect.succeed(null)
      : isUpdate(turn) && !lead.hold
        ? Effect.succeed("Noted.")
        : Queue.offer(turns, turn).pipe(Effect.as(null));
  return lead;
});

/** What a role does on its card: writes files in the card's worktree, reports, ends its turn. */
const work = Effect.fn("work")(function* (
  harness: CrewRunHarness,
  target: CrewRunCard,
  report: { readonly outcome: string; readonly summary: string },
  files: Readonly<Record<string, string>> = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(target.worktreePath ?? "", name);
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, text);
  }
  expect(yield* harness.tool(agentOf(target), "crew_report", report)).toMatchObject({ ok: true });
  yield* harness.finish(agentOf(target).threadId, "Done.");
});

describe("crew runs with a lead", () => {
  it.live(
    "AC 13-17: kicks off in the home thread, batches updates, and routes on the lead's decisions",
    () =>
      withCrewRuns(McpServer.McpServer, (harness) =>
        Effect.gen(function* () {
          yield* install(harness, "stack", STACK);
          const runs = yield* CrewRunService.CrewRunService;
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sql = yield* SqlClient.SqlClient;
          const lead = yield* scriptLead(harness);

          // AC 13: the home thread runs the orchestrator's kickoff on its model, in plan mode.
          const run = yield* runs.start(startInput("stack", "lead"));
          const home = run.homeThreadId ?? ThreadId.make("missing");
          const branch = `crew/stack/${run.runId.slice(-8)}`;
          const kickoff = yield* lead.next;
          expect(kickoff).toMatchObject({ threadId: home, instanceId: claude });
          expect(kickoff.text).toContain("## Brief\n\nbrief: add a /health route");
          expect(kickoff.text).toContain("You coordinate the team.");
          expect(kickoff.text).toContain("- Architect (`architect`), on codex/gpt-5.6-terra");
          expect(kickoff.text).toContain("It starts at `design` when this turn of yours ends.");
          expect(kickoff.text).toContain(
            "- `triage`: you decide: Review asked for changes. Who fixes them?",
          );
          const homeThread = yield* threads.getThreadProjection(home);
          expect(homeThread.thread).toMatchObject({
            branch,
            modelSelection: { instanceId: claude, model: "claude-opus-5-5" },
            interactionMode: "plan",
            runtimeMode: "approval-required",
          });
          expect(homeThread.messages[0]?.text).toContain("## The flow");
          // Nothing of the flow runs while the kickoff turn is open.
          expect(yield* runs.get(run.runId)).toMatchObject({
            status: "running",
            homeMode: "lead",
            leadRoleId: "orchestrator",
            homeThreadId: home,
            cards: [],
          });
          expect(yield* Ref.get(harness.turns)).toHaveLength(1);
          // During kickoff the lead reads the board and leaves a note for a role.
          expect(yield* harness.tool(kickoff, "crew_context")).toMatchObject({
            ok: true,
            value: {
              cardId: `${run.runId}:@lead`,
              role: { id: "orchestrator", name: "Orchestrator" },
              board: { runId: run.runId, cards: [] },
            },
          });
          expect(
            yield* harness.tool(kickoff, "crew_note", {
              toRole: "architect",
              text: "Keep it small.",
            }),
          ).toMatchObject({ ok: true });
          expect(
            yield* harness.tool(kickoff, "crew_report", { outcome: "done", summary: "x" }),
          ).toMatchObject({ ok: false, value: { code: "not_allowed" } });

          // `design` goes to the architect only once that turn has ended.
          yield* harness.finish(home, "Ready.");
          const designing = yield* harness.until(
            run.runId,
            (view) => card(view, "design")?.state === "working",
          );
          const design = card(designing, "design")!;
          expect(design).toMatchObject({
            roleId: "architect",
            modelSelection: { instanceId: codex, model: "gpt-5.6-terra" },
          });
          expect(design.threadId).not.toBe(home);
          const designPrompt =
            (yield* threads.getThreadProjection(agentOf(design).threadId)).messages[0]?.text ?? "";
          expect(designPrompt).toContain("Design this: add a /health route");
          expect(designPrompt).toContain("Note from a teammate:\nKeep it small.");

          // A finished step is a milestone: the lead gets it as a turn, which the test leaves open.
          yield* work(harness, design, { outcome: "done", summary: "Two parts: UI and API." });
          const first = yield* lead.next;
          expect(first.text).toContain("## Crew update");
          expect(first.text).toContain(
            `\`design\` (Architect) finished with \`done\`: Two parts: UI and API. [Architect](t3-thread://v1/${design.threadId})`,
          );

          // AC 14: `ui` and `api` finish and merge while the lead is on that turn.
          const building = yield* harness.until(run.runId, (view) =>
            ["ui", "api"].every((stepId) => card(view, stepId)?.state === "working"),
          );
          // The run keeps its own branch when its cards get theirs.
          expect(building.integrationBranch).toBe(branch);
          yield* work(
            harness,
            card(building, "ui")!,
            { outcome: "done", summary: "Built the page." },
            { "web/page.txt": "page\n" },
          );
          yield* work(
            harness,
            card(building, "api")!,
            { outcome: "done", summary: "Built the API." },
            { "server/api.txt": "v1\n" },
          );
          const reviewing = yield* harness.until(
            run.runId,
            (view) => card(view, "review")?.state === "working",
          );
          // Both milestones wait in the run's digest, and nothing more was sent to the lead.
          const digest = yield* sql<{ readonly digest: string | null }>`
            SELECT lead_digest_json AS "digest" FROM fork_crew_runs WHERE run_id = ${run.runId}
          `;
          expect(JSON.parse(digest[0]?.digest ?? "[]")).toHaveLength(2);
          expect(yield* lead.waiting).toBe(0);
          // Idle again, it gets one message that covers both.
          yield* harness.finish(home, "Noted.");
          const batched = yield* lead.next;
          expect(batched.text).toContain("## While you were working");
          expect(batched.text).toContain("`build` joined:");
          expect(batched.text).toContain("`ui` (Frontend) finished with `done`: Built the page.");
          expect(batched.text).toContain("`api` (Backend) finished with `done`: Built the API.");
          expect(batched.text).toContain("Merge `integrate` finished.");
          expect(yield* lead.waiting).toBe(0);
          lead.hold = false;
          yield* harness.finish(home, "Noted.");

          // AC 15: review asks for changes, and `triage` is the lead's to decide.
          const review = card(reviewing, "review")!;
          yield* work(harness, review, {
            outcome: "changes",
            summary: "The API misses a route.",
          });
          const asked = yield* lead.next;
          const decisionId = `${run.runId}:triage:1`;
          expect(asked.text).toContain(
            "## Decision needed\n\nReview asked for changes. Who fixes them?",
          );
          expect(asked.text).toContain("`review` (QA) finished with `changes`: The API misses");
          expect(asked.text).toContain(`Decision id: \`${decisionId}\``);
          expect(asked.text).toContain(
            "Allowed outcomes: frontend, backend, accept, or `escalate`",
          );
          expect(card(yield* runs.get(run.runId), "triage")).toMatchObject({
            state: "waiting_lead",
            lane: "waiting_lead",
            gate: { by: "lead", outcomes: ["frontend", "backend", "accept"] },
          });
          // AC 17: a read-only Claude lead has `crew_decide` pre-approved, and no tool that runs
          // a command.
          expect(homeThread.thread.interactionMode).toBe("plan");
          expect(CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS).toContain("mcp__t3-code__crew_decide");
          expect(CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS).not.toContain(
            "mcp__t3-code__crew_tool_run",
          );
          expect(yield* harness.tool(asked, "crew_tool_run", { name: "branch" })).toMatchObject({
            ok: false,
            value: { code: "not_allowed" },
          });
          // It decides only with an outcome of the decision.
          expect(
            yield* harness.tool(asked, "crew_decide", { decisionId, outcome: "nobody" }),
          ).toMatchObject({
            ok: false,
            value: {
              code: "invalid_report",
              message: expect.stringContaining("frontend, backend, accept, escalate"),
            },
          });
          expect(
            yield* harness.tool(asked, "crew_decide", {
              decisionId,
              outcome: "backend",
              note: "It is an API bug.",
            }),
          ).toMatchObject({ ok: true, value: { decided: true, outcome: "backend" } });

          // `fix_api` is a follow-up in the backend card's own thread and worktree.
          const fixing = yield* harness.until(
            run.runId,
            (view) => card(view, "fix_api")?.state === "working",
          );
          const api = card(fixing, "api")!;
          const fix = card(fixing, "fix_api")!;
          expect(fix).toMatchObject({
            threadId: api.threadId,
            worktreePath: api.worktreePath,
            branch: api.branch,
          });
          expect(card(fixing, "triage")).toMatchObject({
            state: "done",
            outcome: "backend",
            decidedBy: "lead",
            summary: "It is an API bug.",
          });
          // The lead's answer leaves the send-back counter alone.
          expect(fixing.routes).toMatchObject([{ id: "review/outcome/changes", used: 1, max: 3 }]);
          // A role is not the lead, so it decides nothing.
          expect(
            yield* harness.tool(agentOf(fix), "crew_decide", { decisionId, outcome: "accept" }),
          ).toMatchObject({ ok: false, value: { _tag: "CrewMcpFailure", code: "not_allowed" } });
          yield* harness.finish(home, "Backend fixes it.");
          yield* work(
            harness,
            fix,
            { outcome: "done", summary: "Added the route." },
            { "server/api.txt": "v2\n" },
          );
          // The next merge takes the new commit on that branch.
          const again = yield* harness.until(
            run.runId,
            (view) =>
              cardsOf(view, "review").length === 2 && card(view, "review")?.state === "working",
          );
          expect(cardsOf(again, "integrate").map((merge) => merge.lane)).toEqual(["done", "done"]);
          const integration = again.integrationWorktree ?? "";
          expect(yield* fileSystem.readFileString(path.join(integration, "server/api.txt"))).toBe(
            "v2\n",
          );
          expect(yield* harness.git(integration, "log", "--format=%s", "-5")).toContain(
            "crew(fix_api): Added the route.",
          );

          // AC 16: the lead escalates the next decision, with a note for the user.
          yield* work(harness, card(again, "review")!, {
            outcome: "changes",
            summary: "Still one nit.",
          });
          const second = yield* lead.next;
          const secondId = `${run.runId}:triage:2`;
          expect(second.text).toContain(`Decision id: \`${secondId}\``);
          expect(
            yield* harness.tool(second, "crew_decide", {
              decisionId: secondId,
              outcome: "escalate",
              note: "Your call: ship with a nit?",
            }),
          ).toMatchObject({ ok: true });
          const escalated = yield* harness.until(
            run.runId,
            (view) => card(view, "triage")?.state === "needs_you",
          );
          expect(card(escalated, "triage")).toMatchObject({
            cardId: secondId,
            lane: "needs_you",
            summary: "Your call: ship with a nit?",
          });
          expect(escalated.routes).toMatchObject([{ used: 2 }]);
          // It is the user's now.
          expect(
            yield* harness.tool(second, "crew_decide", { decisionId: secondId, outcome: "accept" }),
          ).toMatchObject({
            ok: false,
            value: { code: "not_allowed", message: expect.stringContaining("taken this decision") },
          });
          // The user resolves it on the board: the run continues, and the lead is told.
          lead.hold = true;
          yield* runs.resolveGate({
            runId: run.runId,
            cardId: secondId,
            outcome: "accept",
            note: "Ship it.",
          });
          const shipping = yield* harness.until(
            run.runId,
            (view) => card(view, "ship")?.state === "needs_you",
          );
          expect(card(shipping, "triage")).toMatchObject({
            state: "done",
            outcome: "accept",
            decidedBy: "user",
          });
          // The user's answer counts as their gate, so the send-backs start over.
          expect(shipping.routes).toMatchObject([{ used: 0 }]);
          yield* harness.finish(home, "Escalated.");
          const told = yield* lead.next;
          expect(told.text).toContain("The user answered `accept` at `triage`: Ship it.");
          expect(told.text).toContain(
            "The user is being asked at `ship`: Approve the integrated changes?",
          );

          // The run's end reaches the lead even while it is on a turn.
          yield* runs.resolveGate({
            runId: run.runId,
            cardId: card(shipping, "ship")!.cardId,
            outcome: "approve",
          });
          expect(
            (yield* harness.until(run.runId, (view) => view.status === "completed")).status,
          ).toBe("completed");
          yield* harness.finish(home, "Understood.");
          const last = yield* lead.next;
          expect(last.text).toContain("The run completed.");
          yield* harness.finish(home, "Thanks.");
          yield* runs.drain;

          // The lead's turns come back as one input; what they meant is a fact beside it.
          const events = yield* sql<{ readonly type: string; readonly facts: string }>`
            SELECT type AS "type", facts_json AS "facts" FROM fork_crew_events
            WHERE run_id = ${run.runId} ORDER BY seq
          `;
          const inputs = new Set(events.map((event) => event.type));
          const facts = new Set(
            events.flatMap((event) =>
              (JSON.parse(event.facts) as ReadonlyArray<{ readonly type: string }>).map(
                (fact) => fact.type,
              ),
            ),
          );
          expect(inputs.has("lead.turn_finished")).toBe(true);
          for (const fact of [
            "lead.kickoff_finished",
            "lead.update_queued",
            "lead.update_delivered",
          ]) {
            expect(inputs.has(fact)).toBe(false);
            expect(facts.has(fact)).toBe(true);
          }
        }),
      ),
  );

  it.live(
    "reminds a silent lead once, reads its decision block, and runs its own step in the home thread",
    () =>
      withCrewRuns(McpServer.McpServer, (harness) =>
        Effect.gen(function* () {
          yield* install(harness, "led", led("led", ", canEdit: true"));
          const runs = yield* CrewRunService.CrewRunService;
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const lead = yield* scriptLead(harness);

          // A lead that may edit runs at its role's own modes.
          const run = yield* runs.start(startInput("led", "led"));
          const home = run.homeThreadId ?? ThreadId.make("missing");
          const kickoff = yield* lead.next;
          expect(kickoff.text).toContain("You may edit the shared checkout.");
          expect((yield* threads.getThreadProjection(home)).thread).toMatchObject({
            interactionMode: "default",
            runtimeMode: "full-access",
          });
          yield* harness.finish(home, "Go.");
          const building = yield* harness.until(
            run.runId,
            (view) => card(view, "build")?.state === "working",
          );
          yield* work(harness, card(building, "build")!, { outcome: "done", summary: "Built." });

          // The lead ends its turn without deciding: one reminder.
          const asked = yield* lead.next;
          const decisionId = `${run.runId}:check:1`;
          expect(asked.text).toContain("## Decision needed\n\nIs the work good?");
          expect(asked.text).not.toContain("without deciding");
          yield* harness.finish(home, "Let me think.");
          const reminded = yield* lead.next;
          expect(reminded.text).toContain("You ended your turn without deciding. Decide now.");
          expect(reminded.text).toContain(`Decision id: \`${decisionId}\``);
          expect(card(yield* runs.get(run.runId), "check")?.state).toBe("waiting_lead");
          // Without tools, it answers with a block at the end of its message.
          yield* harness.finish(
            home,
            `Not yet.\n\n\`\`\`crew-decision\n{ "decisionId": "${decisionId}", "outcome": "no", "note": "Needs tests." }\n\`\`\``,
          );
          const rebuilding = yield* harness.until(
            run.runId,
            (view) =>
              cardsOf(view, "build").length === 2 && card(view, "build")?.state === "working",
          );
          expect(cardsOf(rebuilding, "check")[0]).toMatchObject({
            state: "done",
            outcome: "no",
            decidedBy: "lead",
            summary: "Needs tests.",
          });
          yield* work(harness, card(rebuilding, "build")!, { outcome: "done", summary: "Tested." });

          // Silent through the reminder too: the decision goes to the user.
          yield* lead.next;
          yield* harness.finish(home, "Hm.");
          yield* lead.next;
          yield* harness.finish(home, "Still thinking.");
          const escalated = yield* harness.until(
            run.runId,
            (view) => card(view, "check")?.state === "needs_you",
          );
          expect(card(escalated, "check")).toMatchObject({
            cardId: `${run.runId}:check:2`,
            lane: "needs_you",
            summary: "The lead ended its turn twice without deciding.",
          });
          // Kickoff, then a request and one reminder for each decision.
          const leadTurns = () =>
            Effect.map(Ref.get(harness.turns), (turns) =>
              turns.filter((turn) => turn.instanceId === claude),
            );
          expect(yield* leadTurns()).toHaveLength(5);
          yield* runs.resolveGate({
            runId: run.runId,
            cardId: `${run.runId}:check:2`,
            outcome: "yes",
          });

          // The lead's own step is a follow-up in the home thread, not a thread of its own.
          const wrapTurn = yield* lead.next;
          expect(wrapTurn.threadId).toBe(home);
          expect(wrapTurn.text).toContain("## Task\n\nWrite the release note.");
          expect(wrapTurn.text).toContain("You are the Lead");
          const wrapping = yield* harness.until(
            run.runId,
            (view) => card(view, "wrap")?.state === "working",
          );
          expect(card(wrapping, "wrap")).toMatchObject({ roleId: "lead", threadId: home });
          // It may edit, so its work in the shared checkout is committed like a shared card's.
          const integration = wrapping.integrationWorktree ?? "";
          yield* fileSystem.writeFileString(path.join(integration, "NOTES.md"), "Released.\n");
          expect(
            yield* harness.tool(wrapTurn, "crew_report", {
              outcome: "done",
              summary: "Wrote the note.",
            }),
          ).toMatchObject({ ok: true });
          yield* harness.finish(home, "Done.");
          const done = yield* harness.until(run.runId, (view) => view.status === "completed");
          expect(yield* harness.git(integration, "log", "-1", "--format=%s")).toBe(
            "crew(wrap): Wrote the note.",
          );
          // The home thread and one thread per build: the lead's step added none.
          expect(new Set(done.cards.flatMap((entry) => entry.threadId ?? [])).size).toBe(3);
          expect(yield* leadTurns()).toHaveLength(6);
          yield* runs.drain;
        }),
      ),
  );

  it.live("hands a decision to the user when the lead takes longer than the crew allows", () =>
    withCrewRuns(
      McpServer.McpServer,
      (harness) =>
        Effect.gen(function* () {
          yield* install(harness, "timed", led("timed", ", decisionTimeoutMinutes: 1"));
          const runs = yield* CrewRunService.CrewRunService;
          const lead = yield* scriptLead(harness);
          const run = yield* runs.start(startInput("timed", "timed"));
          const home = run.homeThreadId ?? ThreadId.make("missing");
          yield* lead.next;
          yield* harness.finish(home, "Go.");
          const building = yield* harness.until(
            run.runId,
            (view) => card(view, "build")?.state === "working",
          );
          yield* work(harness, card(building, "build")!, { outcome: "done", summary: "Built." });

          // The lead's turn stays open past the timeout.
          const asked = yield* lead.next;
          const escalated = yield* harness.until(
            run.runId,
            (view) => card(view, "check")?.state === "needs_you",
          );
          expect(card(escalated, "check")).toMatchObject({
            lane: "needs_you",
            summary: "The lead did not decide within 1 minute.",
          });
          expect(
            yield* harness.tool(asked, "crew_decide", {
              decisionId: `${run.runId}:check:1`,
              outcome: "yes",
            }),
          ).toMatchObject({ ok: false, value: { code: "not_allowed" } });
          yield* runs.cancel(run.runId);
          expect((yield* runs.get(run.runId)).status).toBe("cancelled");
        }),
      // One of the crew's minutes passes in a moment, so the test waits on the escalation.
    ).pipe(Effect.provideService(CrewRunService.CrewDecisionMinute, Duration.millis(20))),
  );
});
