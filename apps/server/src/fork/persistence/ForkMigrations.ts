/**
 * Fork migration runner.
 *
 * Fork migrations are recorded in their own `fork_migrations` table, so their
 * ids are numbered independently of upstream's `effect_sql_migrations` and
 * never collide with upstream's next migration.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export const FORK_MIGRATIONS_TABLE = "fork_migrations";

export type ForkMigrationEntry = readonly [
  id: number,
  name: string,
  migration: Effect.Effect<void, SqlError, SqlClient.SqlClient>,
];

/**
 * Every fork migration, in order. Ids start at 1 and are never reused.
 * Migration files live in `./Migrations/`.
 */
const forkMigrationEntries: ReadonlyArray<ForkMigrationEntry> = [];

const run = Migrator.make({});

/**
 * Run pending fork migrations. Returns the [id, name] tuples that ran.
 * Must run after upstream's `runMigrations`, since fork tables may reference
 * upstream ones.
 */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* (
  entries: ReadonlyArray<ForkMigrationEntry> = forkMigrationEntries,
) {
  const executed = yield* run({
    table: FORK_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(entries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
    ),
  });
  if (executed.length > 0) {
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});

export const layer = Layer.effectDiscard(runForkMigrations());
