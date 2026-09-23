import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../../../persistence/Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("053_ProjectionThreadTeam", (it) => {
  it.effect("adds nullable team storage without changing existing threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project-1', 'Project', '/tmp/project', '[]',
          '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json,
          runtime_mode, interaction_mode, created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Thread',
          '{"instanceId":"codex","model":"gpt-5"}',
          'full-access', 'default',
          '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 54 });

      const rows = yield* sql<{ readonly threadId: string; readonly team: string | null }>`
        SELECT thread_id AS "threadId", team_json AS team FROM projection_threads
      `;
      assert.deepEqual(rows, [{ threadId: "thread-1", team: null }]);
    }),
  );
});
