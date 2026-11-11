/**
 * behavior-pruner.ts — the background pruner the behavior logs share (the
 * delivery log, #120; the DM log, #157): run once at startup, then every
 * 10 minutes, on an unref'd timer. A failed prune is logged, never thrown.
 */

import type { Logger } from "pino";

const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

const started = new Set<string>();

/**
 * Start `prune` under `table`'s name (runtime startup, after the DB is
 * ready). Idempotent per table.
 */
export function startPruner(table: string, prune: () => Promise<unknown>, log: Logger): void {
  if (started.has(table)) return;
  started.add(table);
  const pruneQuietly = () => {
    prune().catch((err: unknown) => {
      log.error({ err }, `${table} prune failed`);
    });
  };
  pruneQuietly();
  setInterval(pruneQuietly, PRUNE_INTERVAL_MS).unref();
}
