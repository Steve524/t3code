import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `start_json` keeps the request the run was started with, for the home thread's launch.
  yield* sql`
    CREATE TABLE fork_crew_runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      crew_id TEXT NOT NULL,
      crew_snapshot_json TEXT NOT NULL,
      crew_hash TEXT NOT NULL,
      start_json TEXT NOT NULL,
      inputs_json TEXT NOT NULL,
      resolved_models_json TEXT NOT NULL,
      toolbox_mode TEXT NOT NULL,
      resolved_toolbox_json TEXT NOT NULL,
      home_thread_id TEXT,
      home_mode TEXT NOT NULL,
      lead_role_id TEXT,
      lead_digest_json TEXT,
      route_counters_json TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      active_since TEXT,
      integration_worktree TEXT,
      integration_branch TEXT,
      base_sha TEXT,
      status TEXT NOT NULL,
      machine_snapshot_json TEXT NOT NULL,
      last_event_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX fork_crew_runs_project ON fork_crew_runs (project_id, created_at)`;

  // `card_id` is the engine's run-local card id prefixed with the run id.
  yield* sql`
    CREATE TABLE fork_crew_cards (
      card_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      step_type TEXT NOT NULL,
      visit INTEGER NOT NULL,
      item_index INTEGER,
      item_json TEXT,
      role_id TEXT,
      model_selection_json TEXT,
      thread_id TEXT,
      orchestration_run_id TEXT,
      workspace_mode TEXT NOT NULL,
      worktree_path TEXT,
      branch TEXT,
      base_sha TEXT,
      owns_json TEXT,
      decided_by TEXT,
      source_card_id TEXT,
      gate_json TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      reminder_sent INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      outcome TEXT,
      summary TEXT,
      report_json TEXT,
      changed_paths_json TEXT,
      ownership_violations_json TEXT,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX fork_crew_cards_run ON fork_crew_cards (run_id)`;

  yield* sql`
    CREATE TABLE fork_crew_artifacts (
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      value_json TEXT NOT NULL,
      written_by_card_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, name)
    )
  `;

  yield* sql`
    CREATE TABLE fork_crew_notes (
      note_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      from_card_id TEXT NOT NULL,
      to_role_id TEXT,
      to_card_id TEXT,
      text TEXT NOT NULL,
      delivered_at TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX fork_crew_notes_run ON fork_crew_notes (run_id, delivered_at)`;

  // One row per input the engine was stepped with. `facts_json` holds what it derived from that
  // input; replay folds `type` and `payload_json` only, so a derived fact is never fed back in.
  yield* sql`
    CREATE TABLE fork_crew_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    )
  `;

  yield* sql`
    CREATE TABLE fork_crew_outbox (
      effect_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX fork_crew_outbox_status ON fork_crew_outbox (status)`;

  // The card a thread is working for right now, and the turn that card is waiting on.
  yield* sql`
    CREATE TABLE fork_crew_thread_index (
      thread_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      orchestration_run_id TEXT
    )
  `;
  yield* sql`CREATE INDEX fork_crew_thread_index_run ON fork_crew_thread_index (run_id)`;
}).pipe(Effect.asVoid);
