import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import projectionThreadTeam from "./053_ProjectionThreadTeam.ts";

for (const history of ["fresh", "team", "upstream"] as const) {
  it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
    `reconcile ${history} database`,
    (it) => {
      it.effect("preserves existing data, creates both schemas, and runs only once", () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: history === "upstream" ? 53 : 52 });
          if (history === "team") {
            yield* projectionThreadTeam;
            yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (53, 'ProjectionThreadTeam')`;
          }
          yield* sql`INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES ('p', 'Project', '/tmp/project', '[]', '2026-09-20', '2026-09-20')`;
          yield* sql`INSERT INTO projection_threads
          (thread_id, project_id, title, model_selection_json, runtime_mode,
           interaction_mode, created_at, updated_at)
          VALUES ('t', 'p', 'Thread', '{}', 'full-access', 'default', '2026-09-20', '2026-09-20')`;
          if (history === "team") {
            yield* sql`UPDATE projection_threads SET team_json = '{"role":"worker"}' WHERE thread_id = 't'`;
          }
          if (history === "upstream") {
            yield* sql`INSERT INTO pull_request_files_viewed
            (provider, host, repository, number, viewer, path, revision, viewed_at)
            VALUES ('github', 'github.com', 'owner/repo', 1, 'user', 'file.ts', 'abc', '2026-09-20')`;
          }
          yield* runMigrations();
          const threads = yield* sql<{ team: string | null }>`
          SELECT team_json AS team FROM projection_threads WHERE thread_id = 't'`;
          assert.deepEqual(threads, [{ team: history === "team" ? '{"role":"worker"}' : null }]);
          const viewed = yield* sql<{
            revision: string;
          }>`SELECT revision FROM pull_request_files_viewed`;
          assert.deepEqual(viewed, history === "upstream" ? [{ revision: "abc" }] : []);
          assert.deepEqual(yield* runMigrations(), []);
        }),
      );
    },
  );
}
