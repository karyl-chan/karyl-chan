/**
 * behavior-deliveries.ts — the delivery log (#120): write one delivery,
 * read a behavior's recent ones, prune the rest.
 *
 * Every webhook delivery of a behavior (runWebhookAction, and a command
 * whose deferral Discord refused) leaves one row in behavior_deliveries.
 * A test-fire does not: its result goes straight back to the admin.
 *
 * Retention: the last 20 per behavior, none older than 7 days. The write
 * path only INSERTs; a background pruner (every 10 minutes, like
 * bot_events') deletes the rest, so a busy behavior may briefly hold more
 * than 20 — reads return 20 at most anyway.
 */

import { Op, col, fn, where } from "sequelize";
import { moduleLogger } from "../../logger.js";
import type { ForwardErrorCode } from "../command-system/types.js";
import { BehaviorDelivery, type DeliveryVia } from "./models/behavior-delivery.model.js";

export type { DeliveryVia };

const log = moduleLogger("behavior-deliveries");

/** The most deliveries kept, and returned, per behavior. */
export const DELIVERIES_PER_BEHAVIOR = 20;
/** The oldest delivery kept. */
export const DELIVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How often the pruner runs. */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
/** The longest `error` stored (behavior_stats.lastError keeps 500). */
export const DELIVERY_ERROR_MAX = 300;

/**
 * Why a delivery failed, as a machine code:
 *
 *   ForwardErrorCode  the forwarder's own (host policy, response_signature)
 *   http_error        the receiver answered a non-2xx status (a redirect too)
 *   invalid_reply     a 2xx whose body the bot could not use
 *   request_failed    no response: network error, timeout, undecryptable action
 *   render_failed     Discord refused the reply
 *   dm_failed         a private reply to a message author could not be DMed
 *   defer_failed      Discord refused a command's deferral; nothing was forwarded
 */
export type DeliveryErrorCode =
  | ForwardErrorCode
  | "http_error"
  | "invalid_reply"
  | "request_failed"
  | "render_failed"
  | "dm_failed"
  | "defer_failed";

export interface DeliveryInput {
  behaviorId: number;
  firedAt: Date;
  via: DeliveryVia;
  ok: boolean;
  httpStatus: number | null;
  durationMs: number | null;
  errorCode: DeliveryErrorCode | null;
  error: string | null;
  verified: "hmac" | "token" | null;
}

/** A delivery as the admin API returns it. */
export interface DeliveryRow extends Omit<DeliveryInput, "firedAt" | "errorCode"> {
  id: number;
  /** ISO 8601. */
  firedAt: string;
  errorCode: string | null;
}

/**
 * Record one delivery. Called on the relay path: a failed write is logged
 * and swallowed, never thrown — the action and its reply go on.
 */
export async function recordDelivery(input: DeliveryInput): Promise<void> {
  try {
    await BehaviorDelivery.create({
      ...input,
      error: input.error === null ? null : input.error.slice(0, DELIVERY_ERROR_MAX),
    });
  } catch (err) {
    log.warn({ err, behaviorId: input.behaviorId }, "could not record a behavior delivery");
  }
}

function rowOf(model: InstanceType<typeof BehaviorDelivery>): DeliveryRow {
  const get = <T>(key: string) => model.getDataValue(key) as T;
  return {
    id: get<number>("id"),
    behaviorId: get<number>("behaviorId"),
    firedAt: new Date(get<Date | string>("firedAt")).toISOString(),
    via: get<DeliveryVia>("via"),
    ok: Boolean(get<boolean>("ok")),
    httpStatus: get<number | null>("httpStatus") ?? null,
    durationMs: get<number | null>("durationMs") ?? null,
    errorCode: get<string | null>("errorCode") ?? null,
    error: get<string | null>("error") ?? null,
    verified: get<"hmac" | "token" | null>("verified") ?? null,
  };
}

/** A behavior's most recent deliveries, newest first. */
export async function findRecentDeliveries(
  behaviorId: number,
  limit: number = DELIVERIES_PER_BEHAVIOR,
): Promise<DeliveryRow[]> {
  const rows = await BehaviorDelivery.findAll({
    where: { behaviorId },
    order: [["id", "DESC"]],
    limit,
  });
  return rows.map(rowOf);
}

/**
 * Delete what retention no longer keeps: deliveries older than 7 days,
 * then, per behavior over the cap, everything below its 20 newest. Ids
 * grow with time, so "newest" is the highest id. Cost: one DELETE by age,
 * one grouped count over the (behaviorId, id) index, and two queries per
 * behavior over the cap — the table never holds much more than
 * 20 × behaviors rows.
 */
export async function pruneDeliveries(now: Date = new Date()): Promise<void> {
  const byAge = await BehaviorDelivery.destroy({
    where: { firedAt: { [Op.lt]: new Date(now.getTime() - DELIVERY_MAX_AGE_MS) } },
  });
  const over = (await BehaviorDelivery.findAll({
    attributes: ["behaviorId"],
    group: ["behaviorId"],
    having: where(fn("COUNT", col("id")), { [Op.gt]: DELIVERIES_PER_BEHAVIOR }),
    raw: true,
  })) as unknown as Array<{ behaviorId: number }>;
  let byCount = 0;
  for (const { behaviorId } of over) {
    const cutoff = (await BehaviorDelivery.findOne({
      attributes: ["id"],
      where: { behaviorId },
      order: [["id", "DESC"]],
      offset: DELIVERIES_PER_BEHAVIOR,
      raw: true,
    })) as unknown as { id: number } | null;
    if (!cutoff) continue;
    byCount += await BehaviorDelivery.destroy({
      where: { behaviorId, id: { [Op.lte]: cutoff.id } },
    });
  }
  if (byAge + byCount > 0) log.info({ byAge, byCount }, "pruned behavior deliveries");
}

let pruneTimer: ReturnType<typeof setInterval> | null = null;

function pruneQuietly(): void {
  pruneDeliveries().catch((err: unknown) => {
    log.error({ err }, "behavior_deliveries prune failed");
  });
}

/**
 * Start the pruner (runtime startup, after the DB is ready): once now,
 * then every 10 minutes. Idempotent; the timer is unref'd.
 */
export function startDeliveryPruner(): void {
  if (pruneTimer) return;
  pruneQuietly();
  pruneTimer = setInterval(pruneQuietly, PRUNE_INTERVAL_MS);
  pruneTimer.unref();
}
