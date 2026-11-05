/**
 * command-axes.ts — 指令三軸（contexts / integrationTypes）→ 型別化陣列
 *
 * behavior_commands 存逗號字串（sortJoin）、plugin manifest 存陣列；兩者都
 * 過濾掉不認得的值。放在 utils 讓 behavior（admin 視圖）與 command-system
 * （註冊）共用同一份解析，而不必讓 behavior 在 runtime 依賴 command-system。
 */

/**
 * 對應 Discord InteractionContextType 的字串值。
 * M0-FROZEN §1.1 鎖定列舉。
 */
export type DiscordContext = "Guild" | "BotDM" | "PrivateChannel";

/**
 * 對應 Discord ApplicationIntegrationType 的字串值。
 * M0-FROZEN §1.1 鎖定列舉。
 */
export type DiscordIntegrationType = "guild_install" | "user_install";

function splitAxis(raw: string | readonly string[]): string[] {
  return (typeof raw === "string" ? raw.split(",") : [...raw]).map((s) =>
    s.trim(),
  );
}

export function parseContexts(
  raw: string | readonly string[],
): DiscordContext[] {
  return splitAxis(raw).filter(
    (s): s is DiscordContext =>
      s === "Guild" || s === "BotDM" || s === "PrivateChannel",
  );
}

export function parseIntegrationTypes(
  raw: string | readonly string[],
): DiscordIntegrationType[] {
  return splitAxis(raw).filter(
    (s): s is DiscordIntegrationType =>
      s === "guild_install" || s === "user_install",
  );
}
