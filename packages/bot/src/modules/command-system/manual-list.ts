/**
 * /manual 列表 embed 建構。
 *
 * 兩個入口共用：
 *   - InteractionDispatcher.dispatchManualBehavior（slash /manual）
 *   - MessagePatternMatcher.handleMatchedSystemBehavior（message_pattern 觸發的 manual）
 *
 * 回傳 null 代表 0 條 applicable behaviors，呼叫端自行回「沒有可用行為」文字。
 */

import { EmbedBuilder } from "discord.js";
import type { BehaviorRow } from "../behavior/models/behavior.model.js";
import { t, type SupportedLocale } from "../../i18n/index.js";

const DISCORD_EMBED_FIELD_LIMIT = 25;
const DISCORD_EMBED_FIELD_NAME_MAX = 256;
const DISCORD_EMBED_FIELD_VALUE_MAX = 1024;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // 預留 1 char 給省略符號;避免拼接後超界 (max 必 ≥ 2 才有意義)。
  return `${s.slice(0, max - 1)}…`;
}

export function buildManualBehaviorsEmbed(
  behaviors: BehaviorRow[],
  locale: SupportedLocale,
): EmbedBuilder | null {
  if (behaviors.length === 0) return null;

  const embed = new EmbedBuilder()
    .setTitle(t(locale, "manual.embed-title"))
    .setDescription(
      t(locale, "manual.embed-description", { count: behaviors.length }),
    )
    .setColor(0x5865f2);

  const typeSlashLabel = t(locale, "manual.label-type-slash");
  const typeMessageLabel = t(locale, "manual.label-type-message");
  const notSetLabel = t(locale, "manual.trigger-not-set");

  for (const b of behaviors.slice(0, DISCORD_EMBED_FIELD_LIMIT)) {
    const triggerLabel =
      b.triggerType === "slash_command"
        ? `/${b.slashCommandName ?? notSetLabel}`
        : t(locale, "manual.message-trigger", {
            kind: b.messagePatternKind ?? "?",
            value: b.messagePatternValue ?? "",
          });
    const rawValue =
      `${t(locale, "manual.field-type", {
        type: b.triggerType === "slash_command" ? typeSlashLabel : typeMessageLabel,
      })}\n` +
      `${t(locale, "manual.field-trigger", { trigger: triggerLabel })}\n` +
      (b.description
        ? t(locale, "manual.field-description", { desc: b.description })
        : "");
    // behavior.title / description / messagePatternValue 在 DB 是無限長 TEXT；
    // Discord embed 限制 name ≤256, value ≤1024，超界整個訊息會被 reject。
    // 截斷比靜默失敗好。
    embed.addFields({
      name: truncate(b.title, DISCORD_EMBED_FIELD_NAME_MAX),
      value: truncate(rawValue, DISCORD_EMBED_FIELD_VALUE_MAX),
      inline: false,
    });
  }

  if (behaviors.length > DISCORD_EMBED_FIELD_LIMIT) {
    embed.setFooter({
      text: t(locale, "manual.embed-footer", {
        limit: DISCORD_EMBED_FIELD_LIMIT,
        total: behaviors.length,
      }),
    });
  }

  return embed;
}
