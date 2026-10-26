/**
 * command-system/reply-renderer.ts
 *
 * ReplyRenderer (#140): the one place a BehaviorReply reaches Discord, for
 * both targets a behavior answers.
 *
 *   interaction — a Command Trigger. Only the invoker sees the reply unless
 *     it says `ephemeral: false`. A command that was deferred (ephemeral,
 *     while the webhook ran) is answered through the plugin defer table
 *     (`planRespond`): same visibility → fill the placeholder in place;
 *     public → follow up publicly, then delete the placeholder. Not yet
 *     acknowledged (the built-in login answers at once) → reply directly.
 *   message — a Message Trigger. In a DM with the bot `ephemeral` changes
 *     nothing; in a guild channel the reply is public by default and
 *     `ephemeral: true` DMs the author instead — never the channel, also
 *     when the DM fails.
 *
 * Mentions are never parsed (a reply comes from an external service). A
 * Discord refusal comes back as `{ ok: false }` for the caller to log and
 * count — nothing here swallows it.
 */

import {
  ChannelType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Message,
  type SendableChannels,
} from "discord.js";
import { planRespond } from "../plugin-system/plugin-defer-state.js";
import { hasVisibleReply, type BehaviorReply } from "./behavior-reply.js";

export type ReplyTarget =
  | { kind: "interaction"; interaction: ChatInputCommandInteraction }
  | { kind: "message"; message: Message };

export type RenderOutcome =
  | { ok: true; via: "interaction" | "channel" | "dm" | "none" }
  /** `dmFailed`: an ephemeral guild reply could not reach the author. */
  | { ok: false; error: string; dmFailed?: true };

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** content / embeds / components with mentions off — what every send shares. */
function messageBody(reply: BehaviorReply) {
  return {
    ...(reply.content ? { content: reply.content } : {}),
    ...(reply.embeds?.length ? { embeds: reply.embeds } : {}),
    ...(reply.components?.length ? { components: reply.components } : {}),
    allowedMentions: { parse: [] as [] },
  };
}

const withFlags = <T extends object>(body: T, flags: number) =>
  flags !== 0 ? { ...body, flags } : body;

export async function renderReply(
  reply: BehaviorReply,
  target: ReplyTarget,
): Promise<RenderOutcome> {
  try {
    return target.kind === "interaction"
      ? await renderToInteraction(reply, target.interaction)
      : await renderToMessage(reply, target.message);
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

async function renderToInteraction(
  reply: BehaviorReply,
  interaction: ChatInputCommandInteraction,
): Promise<RenderOutcome> {
  const acked = interaction.deferred || interaction.replied;
  const extraFlags = reply.flags ?? 0;

  if (!hasVisibleReply(reply)) {
    if (acked) await interaction.deleteReply();
    return { ok: true, via: "none" };
  }

  const body = messageBody(reply);
  if (!acked) {
    const ephemeral = reply.ephemeral ?? true;
    await interaction.reply(
      withFlags(body, (ephemeral ? MessageFlags.Ephemeral : 0) | extraFlags),
    );
    return { ok: true, via: "interaction" };
  }

  // Deferred: Discord fixed the placeholder's visibility at defer time.
  const plan = planRespond(
    { kind: "reply", ephemeral: interaction.ephemeral ?? true },
    reply.ephemeral,
  );
  if (plan.action === "patch-original") {
    // an edit can only carry SuppressEmbeds
    await interaction.editReply(
      withFlags(body, extraFlags & MessageFlags.SuppressEmbeds),
    );
    return { ok: true, via: "interaction" };
  }
  await interaction.followUp(
    withFlags(body, (plan.ephemeral ? MessageFlags.Ephemeral : 0) | extraFlags),
  );
  // The reply already landed; a placeholder left behind only lingers
  // until Discord expires it.
  await interaction.deleteReply().catch(() => {});
  return { ok: true, via: "interaction" };
}

async function renderToMessage(
  reply: BehaviorReply,
  message: Message,
): Promise<RenderOutcome> {
  if (!hasVisibleReply(reply)) return { ok: true, via: "none" };
  const body = withFlags(messageBody(reply), reply.flags ?? 0);
  const inBotDm = message.channel.type === ChannelType.DM;

  if (!inBotDm && reply.ephemeral === true) {
    try {
      await message.author.send(body);
    } catch (err) {
      return { ok: false, error: errorText(err), dmFailed: true };
    }
    return { ok: true, via: "dm" };
  }
  await (message.channel as SendableChannels).send(body);
  return { ok: true, via: "channel" };
}
