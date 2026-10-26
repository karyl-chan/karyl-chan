/**
 * command-system/command-target.ts
 *
 * 指令的「註冊目標」：Discord application command 要註冊到哪裡。
 *
 *   - `global`        全域指令（application.commands）
 *   - `guild:<id>`    只註冊在指定伺服器
 *   - `all_guilds`    在 bot 所在的每個伺服器各註冊一份（只給 track 3
 *                     plugin_commands 的 `scope: guild`；behavior 的舊
 *                     all_guilds 分頁在 S3 移除前暫時也用它）
 *
 * `all_guilds` 不是 Discord 的概念，執行時依 bot 的 guild cache 展開成多個
 * 具體目標（ConcreteTarget）。這裡全是純函式，不碰 Discord / DB。
 */

export type GuildTarget = `guild:${string}`;

export type CommandTarget = "global" | "all_guilds" | GuildTarget;

/** 展開後實際對 Discord 呼叫的目標：全域或某一個伺服器。 */
export type ConcreteTarget = "global" | GuildTarget;

export function guildTarget(guildId: string): GuildTarget {
  return `guild:${guildId}`;
}

/** `guild:<id>` → `<id>`；其餘回 null。 */
export function targetGuildId(target: CommandTarget): string | null {
  return target.startsWith("guild:") ? target.slice("guild:".length) : null;
}

/** Discord 端的作用域：global 或 guild（`guild:<id>` 與 `all_guilds` 都是 guild）。 */
export function targetDiscordScope(target: CommandTarget): "global" | "guild" {
  return target === "global" ? "global" : "guild";
}

/**
 * 把目標展開成具體目標。`all_guilds` 展開成 `guildIds` 裡的每一個；
 * `guild:<id>` 不論 bot 在不在那個伺服器都原樣回傳（是否可操作由呼叫端判斷）。
 */
export function expandTarget(
  target: CommandTarget,
  guildIds: Iterable<string>,
): ConcreteTarget[] {
  if (target === "all_guilds") return [...guildIds].map(guildTarget);
  return [target];
}

/** 目標是否涵蓋某個具體目標（stale 判斷、guild 增量 reconcile 用）。 */
export function targetCovers(
  target: CommandTarget,
  concrete: ConcreteTarget,
): boolean {
  if (target === "all_guilds") return concrete !== "global";
  return target === concrete;
}

/**
 * 同名指令的兩個目標是否衝突。Discord 允許全域與伺服器指令同名並存，
 * 但伺服器的指令選單會列出兩個同名項目；karyl 把全域指令視為與任何
 * 同名伺服器指令衝突。只有「兩個不同的指定伺服器」可以同名。
 */
export function targetsConflict(a: CommandTarget, b: CommandTarget): boolean {
  const ga = targetGuildId(a);
  const gb = targetGuildId(b);
  if (ga !== null && gb !== null) return ga === gb;
  return true;
}

// ── 各來源的目標推導 ─────────────────────────────────────────────────────────

/**
 * Behavior 的註冊目標（由舊的 scope + placement 欄位推導）：
 *   scope='global'                      → global
 *   scope='guild' + placementGuildId    → guild:<placementGuildId>
 *     （specific_guild / specific_channel 分頁；#128）
 *   scope='guild' 無 placement          → all_guilds（舊 all_guilds 分頁，S3 移除）
 */
export function behaviorTarget(row: {
  scope: "global" | "guild";
  placementGuildId: string | null;
}): CommandTarget {
  if (row.scope !== "guild") return "global";
  return row.placementGuildId !== null
    ? guildTarget(row.placementGuildId)
    : "all_guilds";
}
