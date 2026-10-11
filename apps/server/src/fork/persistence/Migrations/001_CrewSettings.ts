import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // project_id is '' for the environment scope: SQLite treats NULLs in a primary key as
  // distinct, which would let one role collect several environment rows.
  yield* sql`
    CREATE TABLE fork_crew_role_overrides (
      scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      crew_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      model_selection_json TEXT,
      runtime_mode TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, project_id, crew_id, role_id)
    )
  `;

  yield* sql`
    CREATE TABLE fork_crew_project_settings (
      project_id TEXT PRIMARY KEY,
      toolbox_mode TEXT NOT NULL DEFAULT 'extend',
      updated_at TEXT NOT NULL
    )
  `;
}).pipe(Effect.asVoid);
