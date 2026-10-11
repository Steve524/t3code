import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import { FORK_MIGRATIONS_TABLE, runForkMigrations } from "./ForkMigrations.ts";

const tableExists = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`;
    return rows.length === 1;
  });

describe("fork migrations", () => {
  it.effect("creates its own ledger on an empty database without creating upstream's", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* runForkMigrations(), []);
      assert.ok(yield* tableExists(FORK_MIGRATIONS_TABLE));
      assert.ok(!(yield* tableExists("effect_sql_migrations")));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("runs a fork migration whose id upstream already used, once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const upstreamLedger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      const entries = [
        [1, "Probe", Effect.asVoid(sql`CREATE TABLE fork_probe (id INTEGER PRIMARY KEY)`)],
      ] as const;
      assert.deepStrictEqual(yield* runForkMigrations(entries), [[1, "Probe"]]);
      assert.deepStrictEqual(yield* runForkMigrations(entries), []);

      assert.ok(yield* tableExists("fork_probe"));
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)}`,
        [{ migration_id: 1, name: "Probe" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        upstreamLedger,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
