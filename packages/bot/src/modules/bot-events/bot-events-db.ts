/**
 * Independent SQLite file for the bot event log (Phase 0.7).
 *
 * Pre-0.7, `bot_events` lived in the same SQLite database as every
 * other table. The log is a high-rate writer (plugin sends, reaction
 * events, gateway connects, heartbeat reaper, …) and SQLite is a
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
 * only difference is the file path and the pool. The Phase 1+ Redis
 * migration leaves this layer alone — Postgres / Redis swap targets
 * the main DB (Phase 2.1) and the in-memory stores (Phase 1).
 */

import { Sequelize, Transaction } from "sequelize";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { config } from "../../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_EVENTS_DB_PATH = resolve(
  dirname(dirname(dirname(__dirname))),
  "../data/bot-events.sqlite",
);

const storage =
  config.db.botEventsSqlitePath ?? DEFAULT_EVENTS_DB_PATH;

export const botEventsSequelize = new Sequelize({
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
      // foreign_keys is moot here (the log has no FKs) but stays on for
      // consistency with the main DB. journal_mode + busy_timeout are
      // the load-bearing pragmas.
      await exec("PRAGMA foreign_keys = ON;");
      await exec("PRAGMA journal_mode = WAL;");
      await exec("PRAGMA busy_timeout = 3000;");
      await exec("PRAGMA synchronous = NORMAL;");
    },
  },
});

/** Resolved storage path, exposed for ops / health endpoints. */
export const botEventsDbPath = storage;
