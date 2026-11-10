/**
 * behavior-dm-log.ts — the DM log (#157): write one direct message's
 * outcome, read a behavior's recent ones, prune the old ones.
 *
 * Retention: 30 days. The write path only INSERTs; a background pruner
 * (every 10 minutes, like the delivery log's) deletes older rows.
 */

import { Op, type Transaction } from "sequelize";
import { moduleLogger } from "../../logger.js";
import { startPruner } from "./behavior-pruner.js";
import { BehaviorDmLog, type DmOutcome } from "./models/behavior-dm-log.model.js";

export type { DmOutcome };

const log = moduleLogger("behavior-dm-log");

/** The oldest row kept. */
export const DM_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** The most rows the admin API returns per behavior. */
export const DM_LOG_PAGE = 50;

export interface DmLogInput {
  behaviorId: number;
  recipientUserId: string;
  triggererUserId: string;
  outcome: DmOutcome;
  at?: Date;
}

/** A row as the admin API returns it (its behavior is the one asked for). */
export interface DmLogRow {
  id: number;
  recipientUserId: string;
  triggererUserId: string;
  outcome: DmOutcome;
  /** ISO 8601. */
  at: string;
}

/** Record one direct message. Best-effort: a failed write is logged, never thrown. */
export async function recordDmLog(input: DmLogInput): Promise<void> {
  try {
    await BehaviorDmLog.create({ ...input, at: input.at ?? new Date() });
  } catch (err) {
    log.warn({ err, behaviorId: input.behaviorId }, "could not record a behavior DM");
  }
}

/** A behavior's most recent direct messages, newest first. */
export async function findRecentDmLog(behaviorId: number, limit = DM_LOG_PAGE): Promise<DmLogRow[]> {
  const rows = await BehaviorDmLog.findAll({ where: { behaviorId }, order: [["id", "DESC"]], limit });
  return rows.map((m) => ({
    id: m.getDataValue("id") as number,
    recipientUserId: m.getDataValue("recipientUserId") as string,
    triggererUserId: m.getDataValue("triggererUserId") as string,
    outcome: m.getDataValue("outcome") as DmOutcome,
    at: new Date(m.getDataValue("at") as Date | string).toISOString(),
  }));
}

/** Delete rows older than 30 days. */
export async function pruneDmLog(now: Date = new Date()): Promise<number> {
  const removed = await BehaviorDmLog.destroy({
    where: { at: { [Op.lt]: new Date(now.getTime() - DM_LOG_MAX_AGE_MS) } },
  });
  if (removed > 0) log.info({ removed }, "pruned behavior DM log");
  return removed;
}

/** Remove deleted behaviors' rows (SQLite may run without FK enforcement). */
export async function destroyDmLog(behaviorIds: number | number[], transaction: Transaction): Promise<void> {
  await BehaviorDmLog.destroy({ where: { behaviorId: behaviorIds }, transaction });
}

/**
 * Start the pruner (runtime startup, after the DB is ready): once now,
 * then every 10 minutes (behavior-pruner.ts). Idempotent.
 */
export function startDmLogPruner(): void {
  startPruner("behavior_dm_log", () => pruneDmLog(), log);
}
