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

const DISCORD_EMBED_FIELD_LIMIT = 25;

export function buildManualBehaviorsEmbed(
  behaviors: BehaviorRow[],
): EmbedBuilder | null {
  if (behaviors.length === 0) return null;

  const embed = new EmbedBuilder()
    .setTitle("私訊可用行為清單")
    .setDescription(`目前對你適用的行為共 ${behaviors.length} 條：`)
    .setColor(0x5865f2);

  for (const b of behaviors.slice(0, DISCORD_EMBED_FIELD_LIMIT)) {
    const triggerLabel =
      b.triggerType === "slash_command"
        ? `/${b.slashCommandName ?? "(未設定)"}`
        : `訊息觸發（${b.messagePatternKind ?? "?"}）：${b.messagePatternValue ?? ""}`;
    embed.addFields({
      name: b.title,
      value:
        `**類型**：${b.triggerType === "slash_command" ? "Slash 指令" : "訊息模式"}\n` +
        `**觸發**：\`${triggerLabel}\`\n` +
        (b.description ? `**說明**：${b.description}` : ""),
      inline: false,
    });
  }

  if (behaviors.length > DISCORD_EMBED_FIELD_LIMIT) {
    embed.setFooter({
      text: `（僅顯示前 ${DISCORD_EMBED_FIELD_LIMIT} 條，共 ${behaviors.length} 條）`,
    });
  }

  return embed;
}
