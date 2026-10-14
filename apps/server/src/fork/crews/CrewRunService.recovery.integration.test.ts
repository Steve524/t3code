import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import { McpServer } from "effect/ai";
import * as SqlClient from "effect/sql/SqlClient";

import type {
  CrewRunCard,
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

// After a first step, two readers work at once, then a script waits for a `release` file the
// test writes.
const RESTART = `version: 1
id: restart
name: Restart
inputs:
  brief: { type: text, required: true }
roles:
  reader:
    name: Reader
    instructions: You read.
    model: { driver: codex, model: gpt-5.6-terra }
flow:
  start: ready
  steps:
    ready:
      role: reader
      task: Get ready.
      next: both
    both:
      type: parallel
      branches: [left, right]
      next: check
    left:
      role: reader
      task: Read the left half.
      isolation: read-only
    right:
      role: reader
      task: Read the right half.
      isolation: read-only
    check:
      type: script
      run: node wait.mjs
      next: done
    done:
      type: end
`;

// A lead that has half an hour to decide.
const TIMED = `version: 1
id: timed
name: Timed
home: { mode: lead, role: lead, updates: decisions, decisionTimeoutMinutes: 30 }
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
        yes: done
        no: done
    done:
      type: end
`;

// Exits once `release` exists in its folder; the poll is the child's, not the test's.
const WAIT_SCRIPT = `import { existsSync } from "node:fs";
const timer = setInterval(() => {
  if (existsSync("release")) clearInterval(timer);
}, 20);
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
  const detail = yield* (yield* CrewCatalog.CrewCatalog).get({ projectId, crewId });
  expect(detail.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
});

const start = (crewId: string) => ({
  projectId,
  crewId,
  inputs: { brief: "add a /health route" },
  attachments: [],
  workspace: { mode: "current-checkout" as const },
  runtimeMode: "full-access" as const,
  clientRequestId: crewId,
});

const card = (view: CrewRunView, stepId: string) =>
  view.cards.findLast((candidate) => candidate.stepId === stepId);
const threadOf = (target: CrewRunCard | undefined) => target?.threadId ?? ThreadId.make("missing");
const report = (summary: string) =>
  ["```crew-report", JSON.stringify({ outcome: "done", summary }), "```"].join("\n");

/** How many times each input event type was recorded for a card. */
const eventsFor = Effect.fn("eventsFor")(function* (runId: string, cardId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly type: string; readonly payload: string }>`
    SELECT type AS "type", payload_json AS "payload" FROM fork_crew_events WHERE run_id = ${runId}
  `;
  return rows.filter((row) => row.payload.includes(`"cardId":"${cardId}"`)).map((row) => row.type);
});

describe("crew run recovery", () => {
  it.live(
    "picks a run up after a restart: a turn that ended while down counts once, a cut-off script runs again",
    () =>
      withCrewRuns(McpServer.McpServer, (harness) =>
        Effect.gen(function* () {
          yield* install(harness, "restart", RESTART);
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sql = yield* SqlClient.SqlClient;
          const threads = yield* ThreadManagementService.ThreadManagementService;
          yield* fileSystem.writeFileString(path.join(harness.workspace, "wait.mjs"), WAIT_SCRIPT);
          const runs = yield* CrewRunService.CrewRunService;
          harness.agent.script = (turn) =>
            Effect.succeed(turn.text.startsWith("## Task\n\nGet ready.") ? report("Ready.") : null);
          const run = yield* runs.start(start("restart"));
          const both = yield* harness.until(
            run.runId,
            (view) =>
              card(view, "left")?.state === "working" && card(view, "right")?.state === "working",
          );
          const left = threadOf(card(both, "left"));
          const right = threadOf(card(both, "right"));

          // The left reader finishes while the crew is down.
          yield* harness.stop;
          yield* harness.finish(left, report("Read left."));
          const ended = yield* threads.waitForThread({
            projectId,
            threadId: left,
            timeoutMs: 60_000,
          });
          expect(ended.run?.status).toBe("completed");

          yield* harness.restart(Effect.void);
          // Both cards are still tracked: the one that ended is handled, the other still works.
          const recovered = yield* harness.until(
            run.runId,
            (view) => card(view, "left")?.state === "done",
          );
          expect(card(recovered, "left")).toMatchObject({ summary: "Read left." });
          expect(card(recovered, "right")?.state).toBe("working");

          // The script is cut off by a second restart, with its effect still in the outbox.
          yield* harness.finish(right, report("Read right."));
          yield* harness.until(run.runId, (view) => card(view, "check")?.state === "dispatching");
          yield* harness.stop;
          const inFlight = yield* sql<{ readonly status: string }>`
            SELECT status AS "status" FROM fork_crew_outbox
            WHERE run_id = ${run.runId} AND kind = 'run_script'
          `;
          expect(inFlight.map((row) => row.status)).toEqual([
            expect.stringMatching(/^(pending|running)$/u),
          ]);
          yield* fileSystem.writeFileString(path.join(harness.workspace, "release"), "");
          yield* harness.restart(Effect.void);
          const done = yield* harness.until(run.runId, (view) => view.status === "completed");
          expect(card(done, "check")).toMatchObject({ state: "done", outcome: "pass" });

          const leftCard = `${card(done, "left")?.cardId.slice(run.runId.length + 1)}`;
          const checkCard = `${card(done, "check")?.cardId.slice(run.runId.length + 1)}`;
          expect(
            (yield* eventsFor(run.runId, leftCard)).filter((type) => type === "card.turn_finished"),
          ).toHaveLength(1);
          expect(
            (yield* eventsFor(run.runId, checkCard)).filter((type) => type === "script.finished"),
          ).toHaveLength(1);
        }),
      ),
  );

  it.live("times out a lead decision from when it was asked, across a restart", () =>
    withCrewRuns(McpServer.McpServer, (harness) =>
      Effect.gen(function* () {
        yield* install(harness, "timed", TIMED);
        const sql = yield* SqlClient.SqlClient;
        const runs = yield* CrewRunService.CrewRunService;
        // The lead's turns come to the test; the worker's stay open for it to end.
        const leadTurns = yield* Queue.unbounded<AgentTurn>();
        harness.agent.script = (turn) =>
          turn.instanceId === claude
            ? Queue.offer(leadTurns, turn).pipe(Effect.as(null))
            : Effect.succeed(null);
        const run = yield* runs.start(start("timed"));
        const home = run.homeThreadId ?? ThreadId.make("missing");
        yield* Queue.take(leadTurns);
        yield* harness.finish(home, "Go.");
        const building = yield* harness.until(
          run.runId,
          (view) => card(view, "build")?.state === "working",
        );
        const builder = { threadId: threadOf(card(building, "build")), instanceId: codex };
        expect(
          yield* harness.tool(builder, "crew_report", { outcome: "done", summary: "Built." }),
        ).toMatchObject({ ok: true });
        yield* harness.finish(builder.threadId, "Done.");
        yield* Queue.take(leadTurns);
        yield* runs.drain;

        // The server is down past the decision's half hour.
        yield* harness.stop;
        yield* sql`
          UPDATE fork_crew_outbox SET created_at = '2000-01-01T00:00:00.000Z'
          WHERE run_id = ${run.runId} AND kind = 'send_decision_request'
        `;
        yield* harness.restart(Effect.void);
        const escalated = yield* harness.until(
          run.runId,
          (view) => card(view, "check")?.state === "needs_you",
        );
        expect(card(escalated, "check")).toMatchObject({
          lane: "needs_you",
          summary: "The lead did not decide within 30 minutes.",
        });
      }),
    ),
  );
});
