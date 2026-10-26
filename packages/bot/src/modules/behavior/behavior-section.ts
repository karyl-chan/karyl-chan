/**
 * Behavior Section（分區）：admin UI 依觸發「在哪裡能用」推導出的分組
 * （ADR 0003）。只是呈現，不儲存、不影響行為。這是唯一的推導規則；
 * 前端拿 API 回傳的 `section` 直接分組，不自己再推一次。
 *
 * Section key：
 *   - `app`                         App 指令
 *   - `bot_dm`                      與 bot 的私訊
 *   - `guild:all`                   伺服器 › 全部伺服器
 *   - `guild:<guildId>`             伺服器 › 指定伺服器
 *   - `channel:<guildId>:<chId>`    伺服器 › 指定頻道（只有訊息觸發）
 */

import type {
  DiscordContext,
  DiscordIntegrationType,
} from "../command-system/types.js";
import type { BehaviorCommandRegistration } from "./models/behavior-command.model.js";
import type { BehaviorMessageSurface } from "./models/behavior-definition.model.js";

export type BehaviorSection =
  | "app"
  | "bot_dm"
  | "guild:all"
  | `guild:${string}`
  | `channel:${string}:${string}`;

/** 推導分區需要的觸發欄位。 */
export type SectionSource =
  | {
      kind: "command";
      registration: BehaviorCommandRegistration;
      guildId: string | null;
      integrationTypes: readonly DiscordIntegrationType[];
      contexts: readonly DiscordContext[];
    }
  | {
      kind: "message";
      surface: BehaviorMessageSurface;
      guildId: string | null;
      channelId: string | null;
    };

export function behaviorSection(source: SectionSource): BehaviorSection {
  if (source.kind === "message") {
    if (source.surface === "bot_dm") return "bot_dm";
    if (source.guildId === null) return "guild:all";
    if (source.channelId !== null) {
      return `channel:${source.guildId}:${source.channelId}`;
    }
    return `guild:${source.guildId}`;
  }

  // 指令：註冊到指定伺服器 → 那個伺服器
  if (source.registration === "guild") {
    return source.guildId !== null ? `guild:${source.guildId}` : "guild:all";
  }
  // 全域指令：只在一處可用、且不開放使用者安裝，才歸到那一處
  const onlyContext =
    source.contexts.length === 1 &&
    !source.integrationTypes.includes("user_install")
      ? source.contexts[0]
      : null;
  if (onlyContext === "BotDM") return "bot_dm";
  if (onlyContext === "Guild") return "guild:all";
  return "app";
}
