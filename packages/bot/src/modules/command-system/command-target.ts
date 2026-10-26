/**
 * command-system/command-target.ts
 *
 * 指令的「註冊目標」：Discord application command 要註冊到哪裡。
 *
 *   - `global`        全域指令（application.commands）
 *   - `guild:<id>`    只註冊在指定伺服器
 *   - `all_guilds`    在 bot 所在的每個伺服器各註冊一份（只給 track 3
 *                     plugin_commands 的 `scope: guild` 與內建指令；
 *                     behavior 的指令只有 global / guild:<id>）
 *
 * `all_guilds` 不是 Discord 的概念，執行時依 bot 的 guild cache 展開成多個
 * 具體目標（ConcreteTarget）。這裡全是純函式，不碰 Discord / DB。
 */

import type { BehaviorCommandRegistration } from "../behavior/models/behavior-command.model.js";

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
 * 一次 interaction 是否來自這個目標註冊的指令。`commandGuildId` 是
 * Discord 告訴我們「這個指令註冊在哪個伺服器」（全域指令為 null），
 * 與 interaction 發生在哪裡（guildId）無關。
 */
export function targetMatchesInvocation(
  target: CommandTarget,
  commandGuildId: string | null,
): boolean {
  if (commandGuildId === null) return target === "global";
  return targetCovers(target, guildTarget(commandGuildId));
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
 * Behavior 指令（behavior_commands）的註冊目標：`global` 或 `guild:<guildId>`。
 */
export function behaviorCommandTarget(command: {
  registration: BehaviorCommandRegistration;
  guildId: string | null;
}): "global" | GuildTarget {
  if (command.registration === "guild" && command.guildId !== null) {
    return guildTarget(command.guildId);
  }
  return "global";
}
