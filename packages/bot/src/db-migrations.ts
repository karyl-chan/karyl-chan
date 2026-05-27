/**
 * Umzug-backed schema migration runner.
 *
 * `sequelize.sync()` only CREATEs missing tables — it never ALTERs an
 * existing schema. Once a long-lived DB has the old shape, model
 * changes don't reach it. This module pairs `sync()` with an
 * incremental migration runner so that schema evolution is tracked
 * (`SequelizeMeta` table) and one-shot data migrations have a
 * deterministic place to live.
 *
 * Boot order: `sync()` first → `runMigrations(...)` second. The
 * baseline migration `000-migrate-legacy-expires-at` is idempotent;
 * existing deployments that already ran it via the legacy boot-time
 * call will see zero affected rows on first umzug pass and the
 * migration is recorded as applied with no data churn.
 *
 * Writing a new migration:
 *   1. Add `src/migrations/NNN-short-name.ts` (NNN = zero-padded
 *      monotonically increasing).
 *   2. Export `up(ctx)` and (optionally) `down(ctx)` where `ctx` is
 *      the QueryInterface from the target Sequelize instance.
 *   3. Keep migrations idempotent when feasible — re-running a
 *      failed migration after a fix should not double-apply changes.
 *   4. The runner picks them up on next boot. Order is filename-
 *      lexical, hence the NNN- prefix.
 *
 * Each Sequelize instance the bot uses gets its own SequelizeMeta
 * table (one for the main DB, one for the bot-events DB in SQLite
 * mode; Postgres deploys collapse to a single instance).
 */

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import type { Sequelize } from "sequelize";
import { Umzug, SequelizeStorage } from "umzug";
import { moduleLogger } from "./logger.js";

const log = moduleLogger("db-migrations");

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Build a typed Umzug instance bound to a Sequelize instance + the
 * migrations directory that sits next to this module. Tests can use
 * the returned umzug directly to run/rollback under fake clocks.
 */
export function buildUmzug(sequelize: Sequelize) {
  return new Umzug({
    // here is build/ in production and src/ in dev — both contain a
    // sibling migrations/ directory. Match both extensions so the
    // same runner works under ts-node (dev) and after tsc (prod).
    migrations: {
      glob: ["migrations/*.{js,ts}", { cwd: here }],
    },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize }),
    logger: {
      info: (msg) => log.info(msg, "umzug.info"),
      warn: (msg) => log.warn(msg, "umzug.warn"),
      error: (msg) => log.error(msg, "umzug.error"),
      debug: (msg) => log.debug(msg, "umzug.debug"),
    },
  });
}

/**
 * Apply every pending migration on the given Sequelize instance.
 * Idempotent — already-applied migrations are skipped via the
 * SequelizeMeta record.
 */
export async function runMigrations(
  sequelize: Sequelize,
  label: string,
): Promise<void> {
  const umzug = buildUmzug(sequelize);
  const applied = await umzug.up();
  if (applied.length === 0) {
    log.info({ db: label }, "no pending migrations");
  } else {
    log.info(
      { db: label, count: applied.length, names: applied.map((m) => m.name) },
      "applied migrations",
    );
  }
}
