/**
 * Reply helpers that combine translation + Discord interaction reply
 * for the most common ephemeral patterns. The 30% of replies that need
 * rich embeds with multiple translated parts should call `t()` /
 * `tForInteraction()` directly and build the payload themselves.
 */
import type {
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import { tForInteraction, type TranslationKey } from "./index.js";

type ReplyableInteraction =
  | ChatInputCommandInteraction
  | ModalSubmitInteraction;

interface ReplyOptions {
  /** When provided, wraps content in an embed with this color. */
  color?: number;
  /** Embed title key (will be translated). Used only when `color` is set. */
  titleKey?: TranslationKey;
  /** Ephemeral flag, default true. */
  ephemeral?: boolean;
}

/**
 * Ephemeral reply with `t(key, vars)` content. Picks between content
 * and embed based on whether `color` is provided.
 */
export async function replyWithLocale(
  interaction: ReplyableInteraction,
  key: TranslationKey,
  vars?: Record<string, string | number>,
  options: ReplyOptions = {},
): Promise<void> {
  const content = tForInteraction(interaction, key, vars);
  const flags = options.ephemeral === false ? undefined : ("Ephemeral" as const);
  if (options.color !== undefined) {
    const title = options.titleKey
      ? tForInteraction(interaction, options.titleKey)
      : undefined;
    await interaction.reply({
      embeds: [{ color: options.color, ...(title ? { title } : {}), description: content }],
      flags,
    });
    return;
  }
  await interaction.reply({ content, flags });
}

/**
 * Same as `replyWithLocale` but uses `editReply` (after a prior
 * `deferReply`). Discord ignores the flags argument on editReply, so
 * `ephemeral` is silently dropped — the deferReply already locked
 * that in.
 */
export async function editReplyWithLocale(
  interaction: ReplyableInteraction,
  key: TranslationKey,
  vars?: Record<string, string | number>,
  options: Omit<ReplyOptions, "ephemeral"> = {},
): Promise<void> {
  const content = tForInteraction(interaction, key, vars);
  if (options.color !== undefined) {
    const title = options.titleKey
      ? tForInteraction(interaction, options.titleKey)
      : undefined;
    await interaction.editReply({
      embeds: [{ color: options.color, ...(title ? { title } : {}), description: content }],
    });
    return;
  }
  await interaction.editReply({ content });
}
