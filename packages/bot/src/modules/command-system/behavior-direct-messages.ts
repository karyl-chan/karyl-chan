/**
 * command-system/behavior-direct-messages.ts
 *
 * A reply's `direct_messages` (#157): DMs to users other than (or besides)
 * the one who triggered the behavior. Sent after the reply itself was
 * shown — by the synchronous answer (runWebhookAction) or a callback
 * `respond` / `followup` (behavior-callback.ts) — one at a time, each with
 * its own outcome; none of them can fail the reply.
 *
 * Who may be DMed, per behavior:
 *   - with a DM allowlist (behavior_dm_allowlists): its user ids and the
 *     members of its behavior groups, nobody else;
 *   - without one: a member of the guild the behavior was triggered in;
 *     for a trigger in a DM with the bot (no guild), a member of any guild
 *     the bot is in — asked guild by guild (the member cache, else REST),
 *     stopping at the first that has them.
 *
 * Then, in order: at most BEHAVIOR_DMS_PER_MINUTE per behavior (an
 * allowed recipient past it is `rate_limited`), the message's attachments
 * downloaded from the run's webhook origin like the reply's
 * (`attachment_failed`), and Discord's answer (`sent` / `failed`). Every
 * message leaves one behavior_dm_log row (behavior-dm-log.ts) — the only
 * place a recipient's id is kept; behavior_deliveries stays without user
 * ids. Never throws.
 */

import type { Client, Guild } from "discord.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";
import { recordDmLog, type DmOutcome } from "../behavior/behavior-dm-log.js";
import { findDmAllowlist } from "../behavior/models/behavior-dm-allowlist.model.js";
import { BehaviorGroupMember } from "../behavior/models/behavior-group-member.model.js";
import { RateLimiter } from "../../utils/rate-limiter.js";
import type { DirectMessage } from "./behavior-reply.js";
import { readyToRender, type ReplyFileFetcher } from "./reply-files.js";
import { sendDirectMessage, type ReplyTarget } from "./reply-renderer.js";

/** How many direct messages one behavior may send a minute. */
export const BEHAVIOR_DMS_PER_MINUTE = 10;

const makeLimiter = () => new RateLimiter({ windowMs: 60_000, max: BEHAVIOR_DMS_PER_MINUTE });
let limiter = makeLimiter();

/** Tests only. */
export function __resetBehaviorDmRateLimitForTests(): void {
  limiter = makeLimiter();
}

/** One run's DMs: whose, triggered how, and where its attachments come from. */
export interface DirectMessageRun {
  behaviorId: number;
  target: ReplyTarget;
  fetchFiles?: ReplyFileFetcher;
}

/** What came of one requested DM, in the order asked. */
export interface DirectMessageResult {
  user_id: string;
  outcome: DmOutcome;
}

function clientOf(target: ReplyTarget): Client {
  return target.kind === "interaction"
    ? target.interaction.client
    : (target.message.channel as unknown as { client: Client }).client;
}

const triggererOf = (target: ReplyTarget): string =>
  target.kind === "interaction" ? target.interaction.user.id : target.message.author.id;

const guildIdOf = (target: ReplyTarget): string | null =>
  (target.kind === "interaction" ? target.interaction.guildId : target.message.guildId) ?? null;

/** Whether `userId` is a member of `guild`: its member cache, else REST. */
async function isMember(guild: Guild, userId: string): Promise<boolean> {
  try {
    return Boolean(await guild.members.fetch(userId));
  } catch {
    return false;
  }
}

/** Who this run may DM, asked once per recipient. */
async function recipientRule(run: DirectMessageRun): Promise<(userId: string) => Promise<boolean>> {
  const allowlist = await findDmAllowlist(run.behaviorId);
  if (allowlist) {
    const members = allowlist.groupNames.length
      ? await BehaviorGroupMember.findAll({ where: { groupName: allowlist.groupNames } })
      : [];
    const allowed = new Set([
      ...allowlist.userIds,
      ...members.map((m) => m.getDataValue("userId") as string),
    ]);
    return async (userId) => allowed.has(userId);
  }
  const client = clientOf(run.target);
  const guildId = guildIdOf(run.target);
  if (guildId !== null) {
    return async (userId) => {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      return guild ? isMember(guild, userId) : false;
    };
  }
  // a DM with the bot: any guild the bot is in, the first that has them
  return async (userId) => {
    for (const guild of client.guilds.cache.values()) {
      if (await isMember(guild, userId)) return true;
    }
    return false;
  };
}

async function sendOne(
  run: DirectMessageRun,
  may: (userId: string) => Promise<boolean>,
  { user_id: userId, ...message }: DirectMessage,
): Promise<DmOutcome> {
  if (!(await may(userId))) return "not_allowed";
  if (limiter.isRateLimited(`behavior:${run.behaviorId}`)) return "rate_limited";
  const ready = await readyToRender(message, run.fetchFiles);
  if (!ready.ok) return "attachment_failed";
  const sent = await sendDirectMessage(clientOf(run.target), userId, ready.reply);
  return sent.ok ? "sent" : "failed";
}

/**
 * Send a reply's direct messages, one at a time, and log each. A message
 * the rule refuses, past the rate limit, or that fails is that message's
 * outcome only. Never throws.
 */
export async function sendDirectMessages(
  run: DirectMessageRun,
  messages: readonly DirectMessage[] | undefined,
): Promise<DirectMessageResult[]> {
  if (!messages?.length) return [];
  const triggererUserId = triggererOf(run.target);
  let may: (userId: string) => Promise<boolean>;
  try {
    may = await recipientRule(run);
  } catch {
    // the rule could not be read: nobody may be DMed
    may = async () => false;
  }
  const results: DirectMessageResult[] = [];
  for (const message of messages) {
    let outcome: DmOutcome;
    try {
      outcome = await sendOne(run, may, message);
    } catch {
      outcome = "failed";
    }
    results.push({ user_id: message.user_id, outcome });
    await recordDmLog({
      behaviorId: run.behaviorId,
      recipientUserId: message.user_id,
      triggererUserId,
      outcome,
    });
  }
  const missed = results.filter((r) => r.outcome !== "sent");
  if (missed.length > 0 && shouldRecord(`behavior-dm-missed:${run.behaviorId}`)) {
    botEventLog.record(
      "warn",
      "bot",
      `behavior ${run.behaviorId}: ${missed.length} of ${results.length} direct message(s) not sent (${[
        ...new Set(missed.map((r) => r.outcome)),
      ].join(", ")}) — see its DM log`,
      { behaviorId: run.behaviorId },
    );
  }
  return results;
}
