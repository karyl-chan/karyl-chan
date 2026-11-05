/**
 * command-system/behavior-rate-limits.ts
 *
 * How often a behavior's webhook action may run (#119) — one budget per
 * place it can be fired from, so no one can make the bot hammer a
 * webhook (or loop with a webhook that posts back):
 *
 *   guild channel  5 / 10 s per channel  (a busy channel, a reply loop)
 *   bot DM         5 / 10 s per user
 *   slash command  5 / 10 s per user
 *
 * Over the budget the action does not run and is not counted in the
 * behavior's stats; the bot event log gets one warning per key per
 * window. What the user sees is the caller's call: a message trigger
 * stays silent, a slash command must still answer the interaction.
 * Only webhook actions are limited — the system login never is.
 *
 * In-process by design: Discord sends a guild's events to one shard and
 * every DM to shard 0, so the channel and DM keys never split across
 * processes. A slash key can (one user, guilds on different shards); the
 * budget then only gets wider, never refuses wrongly.
 */

import { RateLimiter } from "../../utils/rate-limiter.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";

const LIMIT = 5;
const WINDOW_MS = 10_000;

export type BehaviorRateLimitKey =
  | { kind: "guild_channel"; channelId: string }
  | { kind: "dm_user"; userId: string }
  | { kind: "slash_user"; userId: string };

type BehaviorRateLimitKind = BehaviorRateLimitKey["kind"];

function makeLimiters(): Record<BehaviorRateLimitKind, RateLimiter> {
  const limiter = () => new RateLimiter({ max: LIMIT, windowMs: WINDOW_MS });
  return { guild_channel: limiter(), dm_user: limiter(), slash_user: limiter() };
}

let limiters = makeLimiters();

/** How a key reads in the bot event log. */
const KIND_LABEL: Record<BehaviorRateLimitKind, string> = {
  guild_channel: "guild channel",
  dm_user: "bot DM user",
  slash_user: "slash command user",
};

/**
 * Takes one run from the key's budget: true when the webhook action may
 * run, false when it is over the limit (logged once per key per window).
 */
export function takeBehaviorRun(key: BehaviorRateLimitKey): boolean {
  const id = key.kind === "guild_channel" ? key.channelId : key.userId;
  if (!limiters[key.kind].isRateLimited(id)) return true;
  if (shouldRecord(`behavior-rate-limit:${key.kind}:${id}`, WINDOW_MS)) {
    const { kind: _kind, ...context } = key;
    botEventLog.record(
      "warn",
      "bot",
      `behavior: ${KIND_LABEL[key.kind]} ${id} 觸發超過 ${LIMIT}/${WINDOW_MS / 1000}s，rate limit 丟棄`,
      context,
    );
  }
  return false;
}

/** 測試用：清空所有視窗。 */
export function __resetBehaviorRateLimitsForTests(): void {
  limiters = makeLimiters();
}
