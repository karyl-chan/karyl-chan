/**
 * Serialising behavior writes (#121).
 *
 *   - withBehaviorWriteLock：one admin write at a time in this process —
 *     a command write spans DB commit → Discord registration → (on
 *     failure) restoring the previous rows, and a second write landing in
 *     the middle would be clobbered by that restore.
 *   - behaviorTransaction：the DB part of a write in one transaction.
 *     SQLite transactions are IMMEDIATE (one writer); on Postgres a
 *     transaction-scoped advisory lock serialises these transactions
 *     across processes, so the reads INSIDE one — "the last sortOrder,
 *     then insert after it", a reorder's read-modify-write — cannot
 *     interleave with another behavior write transaction.
 *
 * What neither covers across processes: the advisory lock ends with its
 * transaction, while the write lock exists per process. Checks made
 * before the transaction (a stale ifUpdatedAt, the name namespace, the
 * tree rules on rows read outside it) and a command write's commit →
 * registerOne → restore sequence are only serialised within one process.
 * With several bot processes serving the admin API, two writes to the
 * same command can pass their checks on the same state (TOCTOU) and a
 * restore can overwrite a write another process committed in between.
 * The default deployment is a single bot process (one shard), so one
 * process serves the admin API.
 */

import type { Transaction } from "sequelize";
import { dbDialect, sequelize } from "../../db.js";

let tail: Promise<unknown> = Promise.resolve();

export function withBehaviorWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}

const ADVISORY_KEY = "karyl.behavior-writes";

export function behaviorTransaction<T>(
  fn: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  return sequelize.transaction(async (transaction) => {
    if (dbDialect === "postgres") {
      await sequelize.query("SELECT pg_advisory_xact_lock(hashtext(:key))", {
        replacements: { key: ADVISORY_KEY },
        transaction,
      });
    }
    return fn(transaction);
  });
}
