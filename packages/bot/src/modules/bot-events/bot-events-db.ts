/**
 * Independent SQLite file for the bot event log.
 *
 * The log is a high-rate writer (plugin sends, reaction events,
 * gateway connects, heartbeat reaper, …) and SQLite is a
 * single-writer engine — at high traffic the log's INSERTs would
 * back up behind the same write lock as plugin-command upserts and
 * audit writes, raising interactive write latency for unrelated
 * paths.
 *
 * Splitting bot_events off into its own DB file gives the log its
 * own WAL + write lock — its 30-events-per-second steady-state
 * traffic stops fighting the main DB's interactive writes.
 *
 * Same dialect / driver / Sequelize abstraction as the main DB; the
 * only difference is the file path and the pool.
 */

import { Sequelize, Transaction } from "sequelize";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { config } from "../../config.js";
import { dbDialect, sequelize as mainSequelize } from "../../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __dirname in build/ is `build/modules/bot-events`; in src/ it's
// `src/modules/bot-events`. Walk two levels up to the package root,
// then into ./data. The previous calc walked one extra `dirname` and
// resolved to `/usr/src/data` (outside the container's writable app
// dir) — bot crashed on first heartbeat under a clean image.
const DEFAULT_EVENTS_DB_PATH = resolve(
  dirname(dirname(dirname(__dirname))),
  "data/bot-events.sqlite",
);

// SQLite is the case where splitting bot_events off matters: a single
// writer lock for the whole file means high-rate event log INSERTs
// fight with interactive writes. Postgres has per-row write locks +
// MVCC; the contention isn't a concern, so we collapse back to the
// main connection. Otherwise a Postgres deployment would silently
// leave bot_events on a private SQLite file (split-brain: main DB on
// Postgres, audit log invisible to other shards).
function buildBotEventsSequelize(): { seq: Sequelize; path: string } {
  if (dbDialect === "sqlite") {
    const storage = config.db.botEventsSqlitePath ?? DEFAULT_EVENTS_DB_PATH;
    return {
      path: storage,
      seq: new Sequelize({
        storage,
        dialect: "sqlite",
        logging: false,
        transactionType: Transaction.TYPES.IMMEDIATE,
        hooks: {
          afterConnect: async (connection: unknown) => {
            const conn = connection as {
              run?: (sql: string, cb?: (err: Error | null) => void) => void;
            };
            if (typeof conn.run !== "function") return;
            const exec = (sql: string) =>
              new Promise<void>((resolveHook, reject) => {
                conn.run!(sql, (err) => (err ? reject(err) : resolveHook()));
              });
            await exec("PRAGMA foreign_keys = ON;");
            await exec("PRAGMA journal_mode = WAL;");
            await exec("PRAGMA busy_timeout = 3000;");
            await exec("PRAGMA synchronous = NORMAL;");
          },
        },
      }),
    };
  }
  // Non-SQLite (Postgres today) — share the main connection. The
  // bot_events table lives alongside everything else with no write-
  // lock fight to worry about, and every shard sees the same rows.
  return { seq: mainSequelize, path: `<shared:${dbDialect}>` };
}

const built = buildBotEventsSequelize();
export const botEventsSequelize = built.seq;
/** Resolved storage path, exposed for ops / health endpoints. */
export const botEventsDbPath = built.path;
/** True when bot_events shares the main DB connection (Postgres). */
export const botEventsSharesMainDb = botEventsSequelize === mainSequelize;
