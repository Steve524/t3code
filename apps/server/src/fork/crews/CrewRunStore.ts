/**
 * CrewRunStore - the SQL behind crew runs. `commit` is the one write path for
 * engine state: an input event, the rows it changes and the effects it asks
 * for, written by the caller's transaction.
 *
 * Card ids here are the engine's run-local ids; the tables hold them prefixed
 * with the run id.
 *
 * @module CrewRunStore
 */
import {
  type ModelSelection,
  type ProjectId,
  ProviderInstanceId,
  type RunId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { CrewFile } from "../../../../../packages/contracts/src/fork/crews/crewFile.ts";
import type {
  CrewRunCard,
  CrewRunStartInput,
  CrewRunStatus,
  CrewRunToolbox,
} from "../../../../../packages/contracts/src/fork/crews/crewRun.ts";
import type { ToolboxMode } from "../../../../../packages/contracts/src/fork/crews/crewToolbox.ts";
import { compileCrewFlow } from "../../../../../packages/shared/src/fork/crews/compileCrewFlow.ts";
import type { CrewCard, CrewEffect, CrewEvent, CrewFact, CrewSnapshot } from "./engine/types.ts";

export interface CrewRunRole {
  readonly name: string;
  readonly modelSelection: ModelSelection;
  /** Picks the role's prompt overlay; null when the instance is no longer known. */
  readonly driver: string | null;
  readonly runtimeMode: RuntimeMode;
}

/** A run as its effects and readers need it. Everything but `snapshot` is frozen at start. */
export interface CrewRunRecord {
  readonly runId: string;
  readonly projectId: ProjectId;
  readonly crewId: string;
  readonly crew: CrewFile;
  readonly files: Readonly<Record<string, string>>;
  /** The tools the crew's script steps run, as the repo defined them at start. */
  readonly scriptTools: Readonly<Record<string, CrewRunToolbox["tools"][number]>>;
  readonly start: CrewRunStartInput;
  readonly inputs: Readonly<Record<string, string | boolean>>;
  readonly roles: Readonly<Record<string, CrewRunRole>>;
  readonly toolboxes: Readonly<Record<string, CrewRunToolbox>>;
  readonly toolboxMode: ToolboxMode;
  readonly homeThreadId: ThreadId | null;
  readonly integrationWorktree: string | null;
  readonly integrationBranch: string | null;
  readonly snapshot: CrewSnapshot;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CrewRunInsert = Omit<CrewRunRecord, "homeThreadId" | "integrationWorktree"> & {
  readonly crewHash: string;
};

export interface CrewThreadEntry {
  readonly runId: string;
  readonly cardId: string;
  readonly attempt: number;
  readonly orchestrationRunId: string | null;
}

/** Where a card with its own worktree works, and what it may change there. */
export interface CrewCardWorkspace {
  /** The engine's run-local card id. */
  readonly cardId: string;
  readonly worktreePath: string;
  readonly branch: string;
  /** The integration head the branch started from. Null for a follow-up in an earlier card's worktree. */
  readonly baseSha: string | null;
  readonly owns: ReadonlyArray<string>;
  readonly ownershipViolations: ReadonlyArray<string>;
}

/** The model a card runs on: the user's mid-run pick, else the role's, on the card's own instance. */
export function crewCardModel(run: CrewRunRecord, card: CrewCard): ModelSelection | null {
  const role = card.roleId === null ? undefined : run.roles[card.roleId];
  if (card.roleId === null || role === undefined) return null;
  const picked = run.snapshot.roleModels[card.roleId];
  if (picked !== undefined) return picked;
  const instanceId = card.instanceId ?? role.modelSelection.instanceId;
  return instanceId === role.modelSelection.instanceId
    ? role.modelSelection
    : { ...role.modelSelection, instanceId: ProviderInstanceId.make(instanceId) };
}

/** A card row without the board's derived lane and column. */
export type CrewCardRow = Omit<CrewRunCard, "lane" | "column">;

interface RunRow {
  readonly run_id: string;
  readonly project_id: ProjectId;
  readonly crew_id: string;
  readonly crew_snapshot_json: string;
  readonly start_json: string;
  readonly inputs_json: string;
  readonly resolved_models_json: string;
  readonly toolbox_mode: ToolboxMode;
  readonly resolved_toolbox_json: string;
  readonly home_thread_id: ThreadId | null;
  readonly integration_worktree: string | null;
  readonly integration_branch: string | null;
  readonly machine_snapshot_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

// Every JSON column is written by this module, so it reads back as what was written.
const parse = <T>(text: string) => JSON.parse(text) as T;
const orNull = <T>(text: string | null) => (text === null ? null : parse<T>(text));
const json = (value: unknown) => JSON.stringify(value);
const iso = (millis: number | null) =>
  millis === null ? null : DateTime.formatIso(DateTime.makeUnsafe(millis));

/** The engine state without the definition it was built from, which the run already stores. */
const runtime = ({ crew: _crew, flow: _flow, ...state }: CrewSnapshot) => state;

function toRecord(row: RunRow): CrewRunRecord {
  const { crew, files, scriptTools } = parse<Pick<CrewRunRecord, "crew" | "files" | "scriptTools">>(
    row.crew_snapshot_json,
  );
  return {
    runId: row.run_id,
    projectId: row.project_id,
    crewId: row.crew_id,
    crew,
    files,
    scriptTools,
    start: parse(row.start_json),
    inputs: parse(row.inputs_json),
    roles: parse(row.resolved_models_json),
    toolboxes: parse(row.resolved_toolbox_json),
    toolboxMode: row.toolbox_mode,
    homeThreadId: row.home_thread_id,
    integrationWorktree: row.integration_worktree,
    integrationBranch: row.integration_branch,
    snapshot: {
      ...parse<ReturnType<typeof runtime>>(row.machine_snapshot_json),
      crew,
      flow: compileCrewFlow(crew),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const budgetJson = (snapshot: CrewSnapshot) =>
  json({ ...snapshot.budget, gate: snapshot.budgetGate });
/** The milestones waiting for the lead to go idle, mirrored from the engine for readers. */
const digestJson = (snapshot: CrewSnapshot) =>
  snapshot.lead?.digest.length ? json(snapshot.lead.digest) : null;

export function makeCrewRunStore(sql: SqlClient.SqlClient) {
  const cardKey = (runId: string, cardId: string) => `${runId}:${cardId}`;

  const getRun = (runId: string) =>
    sql<RunRow>`SELECT * FROM fork_crew_runs WHERE run_id = ${runId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toRecord(rows[0]))),
    );

  const insertRun = (run: CrewRunInsert) =>
    sql`
      INSERT INTO fork_crew_runs (
        run_id, project_id, crew_id, crew_snapshot_json, crew_hash, start_json, inputs_json,
        resolved_models_json, toolbox_mode, resolved_toolbox_json, home_mode, lead_role_id,
        route_counters_json, budget_json, integration_branch, status, machine_snapshot_json,
        last_event_seq, created_at, updated_at
      )
      VALUES (
        ${run.runId}, ${run.projectId}, ${run.crewId},
        ${json({ crew: run.crew, files: run.files, scriptTools: run.scriptTools })},
        ${run.crewHash}, ${json(run.start)},
        ${json(run.inputs)}, ${json(run.roles)}, ${run.toolboxMode}, ${json(run.toolboxes)},
        ${run.snapshot.homeMode}, ${run.snapshot.lead?.roleId ?? null},
        ${json(run.snapshot.routeCounters)},
        ${budgetJson(run.snapshot)}, ${run.integrationBranch}, ${run.snapshot.status},
        ${json(runtime(run.snapshot))}, ${run.snapshot.lastEventSeq}, ${run.createdAt},
        ${run.updatedAt}
      )
    `.pipe(Effect.asVoid);

  const upsertCard = (run: CrewRunRecord, card: CrewCard, at: string) => {
    const started = card.state === "working" || card.state === "reported" ? at : null;
    const finished = ["done", "skipped", "cancelled"].includes(card.state) ? at : null;
    // Stored only while an attempt waits to be dispatched: a model the user picks later is for
    // later attempts, not the one already running.
    const model = crewCardModel(run, card);
    return sql`
      INSERT INTO fork_crew_cards (
        card_id, run_id, step_id, step_type, visit, item_index, item_json, role_id,
        model_selection_json, thread_id, orchestration_run_id, workspace_mode, decided_by,
        source_card_id, attempt, reminder_sent, state, outcome, summary, report_json,
        started_at, finished_at, updated_at
      )
      VALUES (
        ${cardKey(run.runId, card.id)}, ${run.runId}, ${card.stepId}, ${card.type},
        ${card.visit}, ${card.itemIndex}, ${card.item === null ? null : json(card.item)},
        ${card.roleId}, ${model === null ? null : json(model)}, ${card.threadId},
        ${card.orchestrationRunId}, ${card.isolation}, ${card.decidedBy},
        ${card.sourceCardId === null ? null : cardKey(run.runId, card.sourceCardId)},
        ${card.attempt}, ${card.reminderSent ? 1 : 0}, ${card.state}, ${card.outcome},
        ${card.report?.summary ?? card.note}, ${card.report === null ? null : json(card.report)},
        ${started}, ${finished}, ${at}
      )
      ON CONFLICT (card_id) DO UPDATE SET
        model_selection_json = CASE
          WHEN excluded.state IN ('queued', 'dispatching') THEN excluded.model_selection_json
          ELSE fork_crew_cards.model_selection_json
        END,
        thread_id = excluded.thread_id,
        orchestration_run_id = excluded.orchestration_run_id,
        workspace_mode = excluded.workspace_mode,
        decided_by = excluded.decided_by,
        attempt = excluded.attempt,
        reminder_sent = excluded.reminder_sent,
        state = excluded.state,
        outcome = excluded.outcome,
        summary = excluded.summary,
        report_json = excluded.report_json,
        started_at = COALESCE(fork_crew_cards.started_at, excluded.started_at),
        finished_at = CASE
          WHEN excluded.finished_at IS NULL THEN NULL
          ELSE COALESCE(fork_crew_cards.finished_at, excluded.finished_at)
        END,
        updated_at = excluded.updated_at
    `;
  };

  /**
   * Records one engine step. Run it inside the caller's transaction, so the event, the rows it
   * changed and the effects it asked for land together. Returns the ids of those effects.
   */
  const commit = Effect.fn("CrewRunStore.commit")(function* (input: {
    readonly run: CrewRunRecord;
    readonly event: CrewEvent;
    readonly snapshot: CrewSnapshot;
    readonly events: ReadonlyArray<CrewFact>;
    readonly effects: ReadonlyArray<CrewEffect>;
    readonly at: string;
  }) {
    const { run, event, snapshot, at } = input;
    // The payload keeps the event's own time, which replaying it needs.
    const { seq, type, ...payload } = event;
    yield* sql`
      INSERT INTO fork_crew_events (run_id, seq, type, payload_json, facts_json, created_at)
      VALUES (${run.runId}, ${seq}, ${type}, ${json(payload)}, ${json(input.events)}, ${at})
    `;
    yield* sql`
      UPDATE fork_crew_runs SET
        status = ${snapshot.status},
        machine_snapshot_json = ${json(runtime(snapshot))},
        last_event_seq = ${snapshot.lastEventSeq},
        route_counters_json = ${json(snapshot.routeCounters)},
        lead_digest_json = ${digestJson(snapshot)},
        budget_json = ${budgetJson(snapshot)},
        active_since = ${iso(snapshot.activeSince)},
        updated_at = ${at}
      WHERE run_id = ${run.runId}
    `;
    const before = new Map(run.snapshot.cards.map((card) => [card.id, json(card)]));
    for (const card of snapshot.cards) {
      if (before.get(card.id) !== json(card)) yield* upsertCard(run, card, at);
    }
    for (const fact of input.events) {
      if (fact.type !== "gate.opened") continue;
      const gate = { prompt: fact.prompt, outcomes: fact.outcomes, by: fact.by };
      yield* sql`
        UPDATE fork_crew_cards SET gate_json = ${json(gate)}
        WHERE card_id = ${cardKey(run.runId, fact.cardId)}
      `;
    }
    for (const [name, value] of Object.entries(snapshot.artifacts)) {
      if (json(run.snapshot.artifacts[name]) === json(value)) continue;
      yield* sql`
        INSERT INTO fork_crew_artifacts (run_id, name, value_json, updated_at)
        VALUES (${run.runId}, ${name}, ${json(value)}, ${at})
        ON CONFLICT (run_id, name)
        DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `;
    }
    const effectIds: Array<string> = [];
    for (const [index, effect] of input.effects.entries()) {
      const effectId = `${run.runId}:${seq}:${index}`;
      effectIds.push(effectId);
      yield* sql`
        INSERT INTO fork_crew_outbox (
          effect_id, run_id, kind, payload_json, status, created_at, updated_at
        )
        VALUES (${effectId}, ${run.runId}, ${effect.type}, ${json(effect)}, 'pending', ${at}, ${at})
      `;
    }
    return effectIds;
  });

  return {
    getRun,
    insertRun,
    commit,

    listRuns: (projectId: ProjectId, status: CrewRunStatus | undefined) =>
      sql<{
        readonly runId: string;
        readonly projectId: ProjectId;
        readonly crewId: string;
        readonly crewName: string;
        readonly status: CrewRunStatus;
        readonly homeThreadId: ThreadId | null;
        readonly needsYou: number;
        readonly createdAt: string;
        readonly updatedAt: string;
      }>`
        SELECT
          run_id AS "runId",
          project_id AS "projectId",
          crew_id AS "crewId",
          json_extract(crew_snapshot_json, '$.crew.name') AS "crewName",
          status AS "status",
          home_thread_id AS "homeThreadId",
          (
            SELECT COUNT(*) FROM fork_crew_cards
            WHERE fork_crew_cards.run_id = fork_crew_runs.run_id AND state = 'needs_you'
          ) AS "needsYou",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM fork_crew_runs
        WHERE project_id = ${projectId}
          AND (${status ?? null} IS NULL OR status = ${status ?? null})
        ORDER BY created_at DESC
      `,

    /** The run's cards in the order the flow created them. */
    listCards: (runId: string) =>
      sql<{
        readonly cardId: string;
        readonly stepId: string;
        readonly stepType: CrewRunCard["stepType"];
        readonly visit: number;
        readonly itemIndex: number | null;
        readonly roleId: string | null;
        readonly modelSelection: string | null;
        readonly threadId: ThreadId | null;
        readonly state: string;
        readonly attempt: number;
        readonly outcome: string | null;
        readonly summary: string | null;
        readonly gate: string | null;
        readonly decidedBy: CrewRunCard["decidedBy"];
        readonly sourceCardId: string | null;
        readonly branch: string | null;
        readonly worktreePath: string | null;
        readonly ownershipViolations: string | null;
        readonly startedAt: string | null;
        readonly finishedAt: string | null;
        readonly updatedAt: string;
      }>`
        SELECT
          card_id AS "cardId",
          step_id AS "stepId",
          step_type AS "stepType",
          visit AS "visit",
          item_index AS "itemIndex",
          role_id AS "roleId",
          model_selection_json AS "modelSelection",
          thread_id AS "threadId",
          state AS "state",
          attempt AS "attempt",
          outcome AS "outcome",
          summary AS "summary",
          gate_json AS "gate",
          decided_by AS "decidedBy",
          source_card_id AS "sourceCardId",
          branch AS "branch",
          worktree_path AS "worktreePath",
          ownership_violations_json AS "ownershipViolations",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt"
        FROM fork_crew_cards
        WHERE run_id = ${runId}
        ORDER BY rowid
      `.pipe(
        Effect.map((rows) =>
          rows.map((row): CrewCardRow => ({
            ...row,
            modelSelection: orNull(row.modelSelection),
            gate: orNull(row.gate),
            ownershipViolations: orNull<Array<string>>(row.ownershipViolations) ?? [],
          })),
        ),
      ),

    /** Records the worktree a card's thread works in. A follow-up there keeps the base. */
    setCardWorkspace: (runId: string, workspace: Omit<CrewCardWorkspace, "ownershipViolations">) =>
      sql`
        UPDATE fork_crew_cards SET
          worktree_path = ${workspace.worktreePath},
          branch = ${workspace.branch},
          base_sha = COALESCE(${workspace.baseSha}, base_sha),
          owns_json = ${json(workspace.owns)}
        WHERE card_id = ${cardKey(runId, workspace.cardId)}
      `.pipe(Effect.asVoid),

    /** What a merge found a card's branch changed, and which of it the card does not own. */
    setCardOwnership: (
      runId: string,
      cardId: string,
      changedPaths: ReadonlyArray<string>,
      violations: ReadonlyArray<string>,
    ) =>
      sql`
        UPDATE fork_crew_cards SET
          changed_paths_json = ${json(changedPaths)},
          ownership_violations_json = ${json(violations)}
        WHERE card_id = ${cardKey(runId, cardId)}
      `.pipe(Effect.asVoid),

    /** Every card that works in a worktree of its own, in the order the cards finished. */
    listCardWorkspaces: (runId: string) =>
      sql<{
        readonly cardId: string;
        readonly worktreePath: string;
        readonly branch: string;
        readonly baseSha: string | null;
        readonly owns: string | null;
        readonly ownershipViolations: string | null;
      }>`
        SELECT
          card_id AS "cardId",
          worktree_path AS "worktreePath",
          branch AS "branch",
          base_sha AS "baseSha",
          owns_json AS "owns",
          ownership_violations_json AS "ownershipViolations"
        FROM fork_crew_cards
        WHERE run_id = ${runId} AND worktree_path IS NOT NULL AND branch IS NOT NULL
        ORDER BY finished_at IS NULL, finished_at, rowid
      `.pipe(
        Effect.map((rows) =>
          rows.map((row): CrewCardWorkspace => ({
            ...row,
            cardId: row.cardId.slice(runId.length + 1),
            owns: orNull<Array<string>>(row.owns) ?? [],
            ownershipViolations: orNull<Array<string>>(row.ownershipViolations) ?? [],
          })),
        ),
      ),

    /** Records where the run lives once its home thread is known. */
    setHome: (
      runId: string,
      home: {
        readonly threadId: ThreadId;
        readonly worktree: string | null;
        readonly branch: string | null;
      },
    ) =>
      sql`
        UPDATE fork_crew_runs SET
          home_thread_id = ${home.threadId},
          integration_worktree = COALESCE(${home.worktree}, integration_worktree),
          integration_branch = COALESCE(${home.branch}, integration_branch)
        WHERE run_id = ${runId}
      `.pipe(Effect.asVoid),

    /** Takes a pending effect for running. Null when it already ran or is running. */
    claimEffect: (effectId: string, at: string) =>
      sql<{ readonly runId: string; readonly payload: string; readonly createdAt: string }>`
        UPDATE fork_crew_outbox
        SET status = 'running', attempts = attempts + 1, updated_at = ${at}
        WHERE effect_id = ${effectId} AND status = 'pending'
        RETURNING run_id AS "runId", payload_json AS "payload", created_at AS "createdAt"
      `.pipe(
        Effect.map((rows) =>
          rows[0] === undefined
            ? null
            : {
                runId: rows[0].runId,
                effect: parse<CrewEffect>(rows[0].payload),
                createdAt: rows[0].createdAt,
              },
        ),
      ),

    /**
     * Puts every effect a shutdown cut off back to pending and returns all pending ones, oldest
     * first. Only for startup, when nothing can be running yet.
     */
    reclaimEffects: (at: string) =>
      sql`
        UPDATE fork_crew_outbox SET status = 'pending', updated_at = ${at}
        WHERE status = 'running'
      `.pipe(
        Effect.andThen(
          sql<{ readonly effectId: string }>`
            SELECT effect_id AS "effectId" FROM fork_crew_outbox
            WHERE status = 'pending'
            ORDER BY created_at, rowid
          `,
        ),
        Effect.map((rows) => rows.map((row) => row.effectId)),
      ),

    /** The turns unfinished runs wait on, each with the thread it runs in. */
    listWatchedTurns: () =>
      sql<{ readonly threadId: ThreadId; readonly orchestrationRunId: RunId }>`
        SELECT
          fork_crew_thread_index.thread_id AS "threadId",
          fork_crew_thread_index.orchestration_run_id AS "orchestrationRunId"
        FROM fork_crew_thread_index
        JOIN fork_crew_runs ON fork_crew_runs.run_id = fork_crew_thread_index.run_id
        WHERE fork_crew_thread_index.orchestration_run_id IS NOT NULL
          AND fork_crew_runs.status NOT IN ('completed', 'failed', 'cancelled')
      `,

    /** Decision requests the lead of an unfinished run was sent, with when each was asked. */
    listDecisionRequests: () =>
      sql<{ readonly runId: string; readonly payload: string; readonly createdAt: string }>`
        SELECT
          fork_crew_outbox.run_id AS "runId",
          fork_crew_outbox.payload_json AS "payload",
          fork_crew_outbox.created_at AS "createdAt"
        FROM fork_crew_outbox
        JOIN fork_crew_runs ON fork_crew_runs.run_id = fork_crew_outbox.run_id
        WHERE fork_crew_outbox.kind = 'send_decision_request'
          AND fork_crew_outbox.status = 'done'
          AND fork_crew_runs.status NOT IN ('completed', 'failed', 'cancelled')
      `.pipe(
        Effect.map((rows) =>
          rows.flatMap((row) => {
            const effect = parse<CrewEffect>(row.payload);
            return effect.type === "send_decision_request" && !effect.reminder
              ? [{ runId: row.runId, cardId: effect.cardId, askedAt: row.createdAt }]
              : [];
          }),
        ),
      ),

    finishEffect: (effectId: string, error: string | null, at: string) =>
      sql`
        UPDATE fork_crew_outbox
        SET status = ${error === null ? "done" : "failed"}, last_error = ${error}, updated_at = ${at}
        WHERE effect_id = ${effectId}
      `.pipe(Effect.asVoid),

    /** Points a thread at the card it now works for. Its turn is recorded once it is known. */
    indexThread: (threadId: ThreadId, entry: Omit<CrewThreadEntry, "orchestrationRunId">) =>
      sql`
        INSERT INTO fork_crew_thread_index (thread_id, run_id, card_id, attempt)
        VALUES (${threadId}, ${entry.runId}, ${entry.cardId}, ${entry.attempt})
        ON CONFLICT (thread_id) DO UPDATE SET
          card_id = excluded.card_id,
          attempt = excluded.attempt,
          orchestration_run_id = NULL
      `.pipe(Effect.asVoid),

    setThreadTurn: (threadId: ThreadId, orchestrationRunId: string) =>
      sql`
        UPDATE fork_crew_thread_index SET orchestration_run_id = ${orchestrationRunId}
        WHERE thread_id = ${threadId}
      `.pipe(Effect.asVoid),

    findThread: (threadId: ThreadId) =>
      sql<CrewThreadEntry>`
        SELECT
          run_id AS "runId",
          card_id AS "cardId",
          attempt AS "attempt",
          orchestration_run_id AS "orchestrationRunId"
        FROM fork_crew_thread_index
        WHERE thread_id = ${threadId}
      `.pipe(Effect.map((rows) => rows[0] ?? null)),

    readArtifact: (runId: string, name: string) =>
      sql<{ readonly value: string }>`
        SELECT value_json AS "value" FROM fork_crew_artifacts
        WHERE run_id = ${runId} AND name = ${name}
      `.pipe(
        Effect.map((rows) =>
          rows[0] === undefined ? null : { value: parse<unknown>(rows[0].value) },
        ),
      ),

    listArtifacts: (runId: string) =>
      sql<{ readonly name: string }>`
        SELECT name AS "name" FROM fork_crew_artifacts WHERE run_id = ${runId} ORDER BY name
      `.pipe(Effect.map((rows) => rows.map((row) => row.name))),

    /** Hands over an artifact ahead of the card's report, which then carries it into the run. */
    writeArtifact: (runId: string, cardId: string, name: string, value: unknown, at: string) =>
      sql`
        INSERT INTO fork_crew_artifacts (run_id, name, value_json, written_by_card_id, updated_at)
        VALUES (${runId}, ${name}, ${json(value)}, ${cardKey(runId, cardId)}, ${at})
        ON CONFLICT (run_id, name) DO UPDATE SET
          value_json = excluded.value_json,
          written_by_card_id = excluded.written_by_card_id,
          updated_at = excluded.updated_at
      `.pipe(Effect.asVoid),

    artifactsWrittenBy: (runId: string, cardId: string) =>
      sql<{ readonly name: string; readonly value: string }>`
        SELECT name AS "name", value_json AS "value" FROM fork_crew_artifacts
        WHERE run_id = ${runId} AND written_by_card_id = ${cardKey(runId, cardId)}
      `.pipe(
        Effect.map((rows) =>
          Object.fromEntries(rows.map((row) => [row.name, parse<unknown>(row.value)])),
        ),
      ),

    insertNote: (note: {
      readonly noteId: string;
      readonly runId: string;
      readonly fromCardId: string;
      readonly toRoleId: string | null;
      readonly toCardId: string | null;
      readonly text: string;
      readonly at: string;
    }) =>
      sql`
        INSERT INTO fork_crew_notes (
          note_id, run_id, from_card_id, to_role_id, to_card_id, text, created_at
        )
        VALUES (
          ${note.noteId}, ${note.runId}, ${cardKey(note.runId, note.fromCardId)},
          ${note.toRoleId},
          ${note.toCardId === null ? null : cardKey(note.runId, note.toCardId)},
          ${note.text}, ${note.at}
        )
      `.pipe(Effect.asVoid),

    /** The notes waiting for a role or card, marked delivered: each reaches one prompt. */
    takeNotes: (runId: string, roleId: string | null, cardId: string, at: string) =>
      sql<{ readonly text: string }>`
        UPDATE fork_crew_notes SET delivered_at = ${at}
        WHERE run_id = ${runId}
          AND delivered_at IS NULL
          AND (to_role_id = ${roleId} OR to_card_id = ${cardKey(runId, cardId)})
        RETURNING text AS "text"
      `.pipe(Effect.map((rows) => rows.map((row) => row.text))),
  };
}

export type CrewRunStore = ReturnType<typeof makeCrewRunStore>;
