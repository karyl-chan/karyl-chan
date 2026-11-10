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
 *     A behavior callback (#113) passes the message that holds the reply
 *     now (`replyMessage`), so a later answer edits or replaces that one.
 *   message — a Message Trigger. In a DM with the bot `ephemeral` changes
 *     nothing; in a guild channel the reply is public by default and
 *     `ephemeral: true` DMs the author instead — never the channel, also
 *     when the DM fails.
 *
 * A behavior callback (#113) also follows up — on a command, or as a new
 * message for a message trigger, placed like its reply — and edits or
 * deletes those follow-ups (renderFollowup / editFollowup / deleteFollowup).
 * For a message trigger the bot has no placeholder: a callback's first
 * answer sends the reply, later ones edit the message it sent.
 *
 * Mentions are never parsed (a reply comes from an external service). A
 * Discord refusal comes back as `{ ok: false }` for the caller to log and
 * count — nothing here swallows it.
 *
 * renderFailure is what the end user sees when an action fails (#114): a
 * generic localized line, never the receiver's error text — that goes to
 * the log and the behavior's stats only — and never in a guild channel.
 */

import {
  ChannelType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Message,
  type MessageCreateOptions,
  type SendableChannels,
} from "discord.js";
import { planRespond } from "../plugin-system/plugin-defer-state.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { resolveLocale, t } from "../../i18n/index.js";
import { hasVisibleReply, type BehaviorReply } from "./behavior-reply.js";
import type { ReplyVisibility } from "../behavior/models/behavior-definition.model.js";

/**
 * What answering a message trigger needs of its message: where it was and
 * who sent it. Long-lived cache objects only, so a callback token (#200)
 * that keeps a target for 15 minutes keeps no message of its own.
 */
export type TriggerMessage = Pick<Message, "channel" | "author" | "guild">;

export type ReplyTarget =
  | { kind: "interaction"; interaction: ChatInputCommandInteraction }
  | { kind: "message"; message: Message };

/** What the renderer answers: a ReplyTarget, or a message trigger kept as its TriggerMessage. */
export type RenderTarget =
  | { kind: "interaction"; interaction: ChatInputCommandInteraction }
  | { kind: "message"; message: TriggerMessage };

/** A channel the bot sent into, whose messages it can edit and delete by id. */
type SentChannel = Message["channel"];

/**
 * The message that holds a reply (or a callback follow-up), with what it
 * takes to edit or delete it. A command's is `@original` (the placeholder,
 * or the direct reply) or a follow-up id; `ephemeral`: only the invoker
 * sees it (fixed when the message was made). A message trigger's is a
 * message the bot sent; `ephemeral`: it went to the author's DM instead of
 * the guild channel.
 */
export type ReplySlot =
  | { kind: "interaction"; interaction: ChatInputCommandInteraction; messageId: string; ephemeral: boolean }
  | { kind: "message"; channel: SentChannel; messageId: string; ephemeral: boolean };

export type RenderOutcome =
  | {
      ok: true;
      via: "interaction" | "channel" | "dm" | "none";
      /** The reply message after the render; null: there is none. */
      replyMessage?: ReplySlot | null;
    }
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

/** The body of an edit: only the fields the reply has, and of its flags only SuppressEmbeds. */
const editBody = (reply: BehaviorReply) =>
  withFlags(messageBody(reply), (reply.flags ?? 0) & MessageFlags.SuppressEmbeds);

/** The `@original` reply of a command. */
const originalOf = (interaction: ChatInputCommandInteraction, ephemeral: boolean): ReplySlot => ({
  kind: "interaction",
  interaction,
  messageId: "@original",
  ephemeral,
});

/** A command's slot for a message it sent, when Discord said which. */
function interactionSlotOf(
  interaction: ChatInputCommandInteraction,
  sent: unknown,
  ephemeral: boolean,
): ReplySlot | null {
  const id = (sent as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? { kind: "interaction", interaction, messageId: id, ephemeral } : null;
}

/** A message trigger's slot for a message the bot sent, when it is one. */
function messageSlotOf(sent: Message, ephemeral: boolean): ReplySlot | null {
  return typeof sent?.id === "string" && sent.channel
    ? { kind: "message", channel: sent.channel, messageId: sent.id, ephemeral }
    : null;
}

async function editSlot(slot: ReplySlot, body: ReturnType<typeof editBody>): Promise<void> {
  if (slot.kind === "message") {
    await slot.channel.messages.edit(slot.messageId, body);
  } else {
    const { interaction, messageId } = slot;
    await interaction.editReply(messageId === "@original" ? body : { ...body, message: messageId });
  }
}

async function deleteSlot(slot: ReplySlot): Promise<void> {
  if (slot.kind === "message") await slot.channel.messages.delete(slot.messageId);
  else if (slot.messageId === "@original") await slot.interaction.deleteReply();
  else await slot.interaction.deleteReply(slot.messageId);
}

export interface RenderOptions {
  /**
   * The behavior's stored default (replyVisibility): used when the reply
   * itself does not say `ephemeral`; null = the target's own default.
   */
  visibility?: ReplyVisibility | null;
  /**
   * The message holding the reply now (a behavior callback keeps track of
   * it, #113); null = none (any more). Unset: a command's own placeholder,
   * when it was acknowledged; nothing for a message trigger.
   */
  replyMessage?: ReplySlot | null;
}

/**
 * Who the reply is for: the response's `ephemeral` first, then the stored
 * default (`private` = ephemeral), then the target's own default (left
 * undefined).
 */
export function effectiveEphemeral(
  reply: BehaviorReply,
  visibility: ReplyVisibility | null | undefined,
): boolean | undefined {
  if (reply.ephemeral !== undefined) return reply.ephemeral;
  return visibility ? visibility === "private" : undefined;
}

export async function renderReply(
  reply: BehaviorReply,
  target: RenderTarget,
  opts: RenderOptions = {},
): Promise<RenderOutcome> {
  const resolved: BehaviorReply = { ...reply, ephemeral: effectiveEphemeral(reply, opts.visibility) };
  if (resolved.ephemeral === undefined) delete resolved.ephemeral;
  try {
    return target.kind === "interaction"
      ? await renderToInteraction(resolved, target.interaction, opts.replyMessage)
      : await renderToMessage(resolved, target.message, opts.replyMessage ?? null);
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

async function renderToInteraction(
  reply: BehaviorReply,
  interaction: ChatInputCommandInteraction,
  current: ReplySlot | null | undefined,
): Promise<RenderOutcome> {
  const acked = interaction.deferred || interaction.replied;
  const extraFlags = reply.flags ?? 0;
  const slot =
    current !== undefined
      ? current
      : acked
        ? originalOf(interaction, interaction.ephemeral ?? true)
        : null;

  if (!hasVisibleReply(reply)) {
    if (slot) await deleteSlot(slot);
    return { ok: true, via: "none", replyMessage: null };
  }

  const body = messageBody(reply);
  if (!acked) {
    const ephemeral = reply.ephemeral ?? true;
    await interaction.reply(
      withFlags(body, (ephemeral ? MessageFlags.Ephemeral : 0) | extraFlags),
    );
    return { ok: true, via: "interaction", replyMessage: originalOf(interaction, ephemeral) };
  }

  if (!slot) {
    // the reply message is gone (an empty answer deleted it): a new one
    const ephemeral = reply.ephemeral ?? true;
    const sent = await interaction.followUp(
      withFlags(body, (ephemeral ? MessageFlags.Ephemeral : 0) | extraFlags),
    );
    return { ok: true, via: "interaction", replyMessage: interactionSlotOf(interaction, sent, ephemeral) };
  }

  // Discord fixed the message's visibility when it was made.
  const plan = planRespond({ kind: "reply", ephemeral: slot.ephemeral }, reply.ephemeral);
  if (plan.action === "patch-original") {
    await editSlot(slot, editBody(reply));
    return { ok: true, via: "interaction", replyMessage: slot };
  }
  const sent = await interaction.followUp(
    withFlags(body, (plan.ephemeral ? MessageFlags.Ephemeral : 0) | extraFlags),
  );
  // The reply already landed; a message left behind only lingers
  // until Discord expires it.
  await deleteSlot(slot).catch(() => {});
  return { ok: true, via: "interaction", replyMessage: interactionSlotOf(interaction, sent, plan.ephemeral) };
}

/** A behavior callback's outcome for one follow-up operation. */
export type FollowupOutcome<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; dmFailed?: true };

/**
 * A new message (a behavior callback's `followup`): a command's follow-up,
 * or for a message trigger a message placed like its reply. Who sees it:
 * the reply's `ephemeral`, then the stored visibility, then the target's
 * default — a command's invoker only, a guild message's channel.
 */
export async function renderFollowup(
  reply: BehaviorReply,
  target: RenderTarget,
  opts: RenderOptions = {},
): Promise<FollowupOutcome<{ sent: ReplySlot }>> {
  const wanted = effectiveEphemeral(reply, opts.visibility);
  const flags = reply.flags ?? 0;
  let slot: ReplySlot | null;
  if (target.kind === "message") {
    const dm = goesToDm(target.message, wanted);
    const sent = await sendFor(target.message, dm, withFlags(messageBody(reply), flags));
    if (!sent.ok) return sent;
    slot = messageSlotOf(sent.message, dm);
  } else {
    const ephemeral = wanted ?? true;
    try {
      const sent = await target.interaction.followUp(
        withFlags(messageBody(reply), (ephemeral ? MessageFlags.Ephemeral : 0) | flags),
      );
      slot = interactionSlotOf(target.interaction, sent, ephemeral);
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }
  return slot ? { ok: true, sent: slot } : { ok: false, error: "Discord returned no message" };
}

/** Edit a follow-up: only the fields the reply has (an edit cannot clear the others). */
export async function editFollowup(reply: BehaviorReply, sent: ReplySlot): Promise<FollowupOutcome> {
  try {
    await editSlot(sent, editBody(reply));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

export async function deleteFollowup(sent: ReplySlot): Promise<FollowupOutcome> {
  try {
    await deleteSlot(sent);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

/**
 * Where a message trigger's reply goes: a DM to the author for a private
 * reply in a guild, else the channel (a DM with the bot is both).
 */
function goesToDm(message: TriggerMessage, ephemeral: boolean | undefined): boolean {
  return message.channel.type !== ChannelType.DM && ephemeral === true;
}

/** Send for a message trigger; a DM that fails is `dmFailed`, never retried in the channel. */
async function sendFor(
  message: TriggerMessage,
  dm: boolean,
  body: MessageCreateOptions,
): Promise<{ ok: true; message: Message } | { ok: false; error: string; dmFailed?: true }> {
  try {
    const sent = dm ? await message.author.send(body) : await (message.channel as SendableChannels).send(body);
    return { ok: true, message: sent };
  } catch (err) {
    return dm ? { ok: false, error: errorText(err), dmFailed: true } : { ok: false, error: errorText(err) };
  }
}

/**
 * The typing indicator where a message trigger's reply will most likely go
 * (a deferred webhook, #113): the author's DM for a guild message whose
 * stored visibility is private, else the channel. Best-effort.
 */
export async function sendTypingFor(
  message: TriggerMessage,
  visibility: ReplyVisibility | null | undefined,
): Promise<void> {
  try {
    if (goesToDm(message, visibility === "private")) {
      await (await message.author.createDM()).sendTyping();
    } else {
      await (message.channel as SendableChannels).sendTyping();
    }
  } catch (err) {
    botEventLog.record("warn", "bot", `reply-renderer: could not show typing: ${errorText(err)}`);
  }
}

async function renderToMessage(
  reply: BehaviorReply,
  message: TriggerMessage,
  current: ReplySlot | null,
): Promise<RenderOutcome> {
  if (!hasVisibleReply(reply)) return { ok: true, via: "none", replyMessage: current };
  // no say on who sees it: an answer already sent stays where it is
  const dm =
    reply.ephemeral === undefined && current ? current.ephemeral : goesToDm(message, reply.ephemeral);
  const via = dm ? "dm" : "channel";

  // the reply already sent (a behavior callback answering again): edit it
  // in place while it stays where it is
  if (current && current.ephemeral === dm) {
    await editSlot(current, editBody(reply));
    return { ok: true, via, replyMessage: current };
  }

  const sent = await sendFor(message, dm, withFlags(messageBody(reply), reply.flags ?? 0));
  if (!sent.ok) {
    if (sent.dmFailed) return sent;
    throw new Error(sent.error);
  }
  // moved between the channel and the DM: the old one goes
  if (current) await deleteSlot(current).catch(() => {});
  return { ok: true, via, replyMessage: messageSlotOf(sent.message, dm) };
}

/**
 * Tell the user the action failed, without saying why (#114): a command's
 * invoker only (a private placeholder is filled with it; a public one is
 * deleted and the line follows up privately), a message author in
 * the DM with the bot, or — for a guild message — in a DM to the author.
 * A guild channel never hears about a failure: it would be noise on a
 * broad trigger and could undo a reply meant to be private. If the DM
 * fails too, nothing is said; the caller has logged it. Never throws.
 */
export async function renderFailure(target: RenderTarget): Promise<void> {
  try {
    if (target.kind === "interaction") {
      const { interaction } = target;
      const content = t(resolveLocale(interaction), "behavior.action-failed");
      if ((interaction.deferred || interaction.replied) && interaction.ephemeral === false) {
        // a public placeholder (a leaf stored 'public'): the failure goes
        // to the invoker alone, and the public "thinking…" goes away
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        await interaction.deleteReply().catch(() => {});
      } else if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content, embeds: [], components: [], allowedMentions: { parse: [] } });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
      return;
    }
    const { message } = target;
    const content = t(
      resolveLocale({ guildLocale: message.guild?.preferredLocale ?? null }),
      "behavior.action-failed",
    );
    const body = { content, allowedMentions: { parse: [] as [] } };
    if (message.channel.type === ChannelType.DM) {
      await (message.channel as SendableChannels).send(body);
    } else {
      await message.author.send(body);
    }
  } catch (err) {
    botEventLog.record("warn", "bot", `reply-renderer: could not tell the user an action failed: ${errorText(err)}`);
  }
}
