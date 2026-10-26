/**
 * command-system/reconcile.service.ts
 *
 * CommandReconciler：軌二（behaviors）+ 軌三（plugin_commands）Discord 指令
 * 統一 reconcile 入口。對齊 C-runtime §2.2 介面定義 + §3.2 流程 2 + §3.3 三軸表。
 *
 * desired set 來自 DesiredCommandSource adapters（desired-command-source.ts）；
 * 每個 desired 指令帶一個註冊目標（global / guild:<id> / all_guilds，見
 * command-target.ts），執行時依 bot 的 guild cache 展開成具體目標。
 *
 * 「軌一不動」保證（C-runtime §1）：
 *   - 本服務只認領 reconciler_owned_commands 名冊 + desired set 中的指令
 *   - 任何 featureKey 非 null 的 plugin_commands 由 PluginCommandRegistry 管，不觸碰
 *   - in-process 指令（picture-only-channel 等）不在 desired set，不動
 */

import {
  InteractionContextType,
  type Client,
  type Collection,
  type Guild,
  type ApplicationCommand,
  type ApplicationCommandData,
} from "discord.js";
import { Op } from "sequelize";
import { botEventLog } from "../bot-events/bot-event-log.js";
import type {
  ReconcileItemResult,
  ReconcileReport,
  TargetOutcome,
} from "./types.js";
import { ReconcilerOwnedCommand } from "./models/reconciler-owned-command.model.js";
import { commandNeedsPatch } from "./command-registration.js";
import {
  expandTarget,
  guildTarget,
  targetCovers,
  targetGuildId,
  type CommandTarget,
  type ConcreteTarget,
} from "./command-target.js";
import {
  BehaviorCommandSource,
  PluginCommandSource,
  type CommandKey,
  type CommandSourceKind,
  type DesiredCommand,
  type DesiredCommandSource,
  type DesiredLookup,
} from "./desired-command-source.js";

// ── 單一指令的結果型別 ──────────────────────────────────────────────────────

/**
 * registerOne 的結果。ok=true 表示展開後的每個具體目標都已在 Discord 上
 * （新建、更新或本來就一致），且至少有一個目標 —— S7 的原子切換靠這個
 * 判斷「新觸發已生效」。
 */
export type RegisterOneResult =
  | {
      ok: true;
      key: CommandKey;
      name: string;
      outcomes: TargetOutcome[];
    }
  | {
      ok: false;
      key: CommandKey;
      reason: "bot_not_ready" | "not_found" | "not_desired" | "invalid";
      error: string;
    }
  | {
      ok: false;
      key: CommandKey;
      reason: "registration_failed";
      name: string;
      outcomes: TargetOutcome[];
      error: string;
    };

// ── reconciler_owned_commands 名冊（透過 ReconcilerOwnedCommand model）──────────

/** 名冊的一筆：reconciler 在某個具體目標上註冊過的一個指令名稱。 */
export interface OwnedCommand {
  name: string;
  target: ConcreteTarget;
}

/** 名冊表以 scope + guildId 存目標；與 OwnedCommand 的換算只在這幾個函式裡。 */
function ownedWhere(owned: OwnedCommand) {
  const guildId = targetGuildId(owned.target);
  return guildId === null
    ? { name: owned.name, scope: "global", guildId: { [Op.is]: null } }
    : { name: owned.name, scope: "guild", guildId };
}

async function loadOwnedCommands(): Promise<OwnedCommand[]> {
  const rows = await ReconcilerOwnedCommand.findAll();
  const out: OwnedCommand[] = [];
  for (const r of rows) {
    const name = r.getDataValue("name") as string;
    const guildId = (r.getDataValue("guildId") as string | null) ?? null;
    if (r.getDataValue("scope") === "global") {
      out.push({ name, target: "global" });
    } else if (guildId) {
      out.push({ name, target: guildTarget(guildId) });
    }
  }
  return out;
}

async function upsertOwnedCommand(owned: OwnedCommand): Promise<void> {
  // 先刪再建：partial unique index 下不能用 upsert，且每次 reconcile 都要
  // 刷新 ownedAt。create() 會觸發 model 的 scopeGuildShape validate。
  const guildId = targetGuildId(owned.target);
  await ReconcilerOwnedCommand.destroy({ where: ownedWhere(owned) });
  await ReconcilerOwnedCommand.create({
    name: owned.name,
    scope: guildId === null ? "global" : "guild",
    guildId,
    ownedAt: new Date(),
  });
}

async function deleteOwnedCommand(owned: OwnedCommand): Promise<void> {
  await ReconcilerOwnedCommand.destroy({ where: ownedWhere(owned) });
}

/**
 * 名冊中的一筆是否仍被 desired set 需要 —— 以「名稱 + 目標」為鍵。
 * 伺服器的註冊只有在某個同名 desired 指令的目標涵蓋該伺服器時才保留；
 * 指令搬到別的伺服器、或從 all_guilds 改成指定伺服器時，其他伺服器的
 * 舊註冊就會被判定為 stale。
 */
export function isOwnedCommandDesired(
  owned: OwnedCommand,
  desired: ReadonlyArray<{ name: string; target: CommandTarget }>,
): boolean {
  return desired.some(
    (d) => d.name === owned.name && targetCovers(d.target, owned.target),
  );
}

// ── Discord 現況 ─────────────────────────────────────────────────────────────

interface DiscordState {
  /** key：stateKey(name, target) */
  commands: Map<string, ApplicationCommand>;
  /** 拉取失敗的具體目標（現況未知） */
  unreadable: Set<ConcreteTarget>;
}

/** 全域與伺服器指令 manager 共用的操作面。 */
interface CommandManager {
  fetch(): Promise<Collection<string, ApplicationCommand>>;
  create(data: ApplicationCommandData): Promise<unknown>;
  edit(id: string, data: ApplicationCommandData): Promise<unknown>;
  delete(id: string): Promise<unknown>;
}

/** 具體目標的指令 manager；bot 不在（或此 shard 看不到）該伺服器時回 null。 */
function commandManagerFor(
  bot: Client,
  target: ConcreteTarget,
): CommandManager | null {
  const guildId = targetGuildId(target);
  if (guildId === null) return bot.application!.commands;
  return bot.guilds.cache.get(guildId)?.commands ?? null;
}

/** DiscordState.commands 的 key：具體目標 + 指令名稱。 */
function stateKey(name: string, target: ConcreteTarget): string {
  return `${target} ${name}`;
}

// ── CommandReconciler 主類別 ──────────────────────────────────────────────────

export class CommandReconciler {
  private reconcileLock: Promise<void> = Promise.resolve();
  private readonly sources: Map<CommandSourceKind, DesiredCommandSource>;

  constructor(
    private readonly getBot: () => Client | null,
    sources: DesiredCommandSource[] = [
      new BehaviorCommandSource(),
      new PluginCommandSource(),
    ],
  ) {
    this.sources = new Map(sources.map((s) => [s.kind, s]));
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.reconcileLock;
    let resolve!: () => void;
    this.reconcileLock = new Promise<void>((r) => {
      resolve = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }

  // ── 公開 API ──────────────────────────────────────────────────────────────

  /**
   * 全量 reconcile（C-runtime §3.2 流程 2）。
   * 在 bot ready 事件繼 syncInProcessCommandsToDiscord + pluginCommandRegistry.reconcileAll
   * 之後呼叫，接管軌二 + 軌三 global 指令。
   *
   * 錯誤策略：每條 row 獨立 try/catch，單條失敗不阻擋其餘。
   */
  async reconcileAll(): Promise<ReconcileReport> {
    return this.withLock(() => this._reconcileAll());
  }

  private async _reconcileAll(): Promise<ReconcileReport> {
    const bot = this.getBot();
    if (!bot?.application) {
      botEventLog.record(
        "warn",
        "bot",
        "command-reconciler: bot not ready, skipping reconcileAll",
      );
      return emptyReport();
    }

    const report = emptyReport();

    // 步驟 1：枚舉 desired set
    const desired = await this.listDesired();

    // 步驟 3：拉 Discord 現況
    const discordState = await this.fetchDiscordState(bot);

    // 載入已知名冊（避免誤刪軌一）
    const owned = await loadOwnedCommands();

    // 步驟 4：Diff & Apply
    const outcomesByCommand = new Map<DesiredCommand, TargetOutcome[]>();
    for (const cmd of desired) {
      try {
        const outcomes = await this.applyCommand(
          bot,
          cmd,
          this.concreteTargets(bot, cmd),
          discordState,
        );
        outcomesByCommand.set(cmd, outcomes);
        tally(report, toItemResult(cmd.key, outcomes));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        report.errors.push({
          ok: false,
          source: cmd.key.source,
          sourceId: cmd.key.id,
          error,
        });
      }
    }

    // 步驟 4 續：stale 清除（名冊中有、但 desired set 沒涵蓋的「名稱 + 目標」）
    const desiredTargets = desired.map((d) => ({
      name: d.name,
      target: d.spec.target,
    }));
    for (const entry of owned) {
      if (isOwnedCommandDesired(entry, desiredTargets)) continue;
      if (await this.deleteStale(bot, entry)) report.deleted++;
    }

    // 步驟 5：清舊版產物（dm-slash-rebind 遺留物）
    await this.cleanupLegacyDmSlashCommands(bot, desired);

    // 步驟末：upsert 名冊
    for (const [cmd, outcomes] of outcomesByCommand) {
      await this.upsertOwned(cmd, outcomes);
    }

    botEventLog.record(
      "info",
      "bot",
      `command-reconciler: reconcileAll 完成 created=${report.created} patched=${report.patched} deleted=${report.deleted} errors=${report.errors.length}`,
    );

    return report;
  }

  /**
   * 註冊單一 desired 指令（建立或 patch 到與 desired 一致），在 reconcile
   * 鎖內執行，所以不會跟 reconcileAll 的 stale 清除交錯（清除看到的
   * desired set 與這裡註冊的是同一份 DB 狀態）。不做 stale 清除、不刪除。
   *
   * 給 S7 的原子切換用：新觸發要先註冊成功（ok=true）才停用舊的。
   * 鎖不可重入：不要在持有 reconcile 鎖的流程裡呼叫。
   */
  async registerOne(key: CommandKey): Promise<RegisterOneResult> {
    return this.withLock(() => this._registerOne(key));
  }

  private async _registerOne(key: CommandKey): Promise<RegisterOneResult> {
    const bot = this.getBot();
    if (!bot?.application) {
      return { ok: false, key, reason: "bot_not_ready", error: "bot not ready" };
    }
    const lookup = await this.sourceFor(key.source).lookup(key.id);
    if (lookup.status !== "desired") {
      return { ok: false, key, ...notRegistrable(lookup) };
    }
    const cmd = lookup.command;
    const outcomes = await this.applyAndRecord(bot, cmd);

    const problems = outcomes.filter(
      (o) => o.status === "failed" || o.status === "skipped",
    );
    if (problems.length > 0 || outcomes.length === 0) {
      return {
        ok: false,
        key,
        reason: "registration_failed",
        name: cmd.name,
        outcomes,
        // all_guilds 但 bot 不在任何伺服器：沒有地方能呼叫，不算生效
        error:
          outcomes.length === 0
            ? "沒有可註冊的目標（bot 不在任何伺服器）"
            : describeProblems(problems),
      };
    }
    return { ok: true, key, name: cmd.name, outcomes };
  }

  /**
   * 放掉一筆不再需要的註冊：behavior 指令改名、換註冊目標或被刪除後，
   * 舊的「名稱 + 目標」立刻從 Discord 與名冊移除，不等下一次 reconcileAll。
   * desired set 仍涵蓋它（例如別的指令正好用這個名稱 + 目標）時不動。
   * 與 registerOne 同在 reconcile 鎖內，所以看到的 desired set 與 DB 一致。
   *
   *   - removed：已刪除（Discord 上本來就沒有也算）
   *   - still_desired：仍被需要，沒有刪
   *   - unavailable：bot 未就緒或碰不到該伺服器 / Discord 失敗；名冊保留，
   *     交給之後的 reconcileAll
   */
  async releaseRegistration(
    name: string,
    target: ConcreteTarget,
  ): Promise<"removed" | "still_desired" | "unavailable"> {
    return this.withLock(async () => {
      const bot = this.getBot();
      if (!bot?.application) return "unavailable";
      const desired = (await this.listDesired()).map((d) => ({
        name: d.name,
        target: d.spec.target,
      }));
      if (isOwnedCommandDesired({ name, target }, desired)) return "still_desired";
      return (await this.deleteStale(bot, { name, target }))
        ? "removed"
        : "unavailable";
    });
  }

  /**
   * 增量 reconcile 單一 behavior 指令（behavior_commands.id；admin 寫入後
   * 呼叫）。沒有啟用中葉節點的指令從 Discord 刪除。
   */
  async reconcileForBehaviorCommand(
    commandId: number,
  ): Promise<ReconcileItemResult> {
    return this.withLock(() =>
      this._reconcileForSource({ source: "behavior", id: commandId }),
    );
  }

  /**
   * 增量 reconcile 單條 plugin 自訂指令（plugin register/update 後呼叫）。
   * rowId 對應 plugin_commands.id（featureKey=null 的那半部）。
   */
  async reconcileForPluginCommand(rowId: number): Promise<ReconcileItemResult> {
    return this.withLock(() =>
      this._reconcileForSource({ source: "plugin_command", id: rowId }),
    );
  }

  private async _reconcileForSource(
    key: CommandKey,
  ): Promise<ReconcileItemResult> {
    const base = { source: key.source, sourceId: key.id };
    const bot = this.getBot();
    if (!bot?.application) {
      return { ...base, ok: false, error: "bot not ready" };
    }
    const source = this.sourceFor(key.source);
    const lookup = await source.lookup(key.id);
    switch (lookup.status) {
      case "desired":
        return toItemResult(
          key,
          await this.applyAndRecord(bot, lookup.command),
        );
      case "not_found":
        return { ...base, ok: false, error: source.notFoundMessage };
      case "unmanaged":
        return { ...base, ok: true, action: "noop" };
      case "not_desired":
        // 來源決定停用時要不要立刻刪 Discord 上的舊註冊（behavior 會；
        // plugin 指令沿用既有行為，回報無法計算，交給 reconcileAll 清除）
        if (source.deleteWhenNotDesired && lookup.name && lookup.target) {
          // 刪除失敗要回報（呼叫端據此判斷「已從 Discord 移除」是否成立）；
          // bot 碰不到的伺服器不算失敗 —— 名冊保留，交給看得到它的 process，
          // 以 skipped 回報，讓呼叫端知道移除還沒發生
          const failures: string[] = [];
          const skipped: TargetOutcome[] = [];
          for (const target of expandTarget(
            lookup.target,
            bot.guilds.cache.keys(),
          )) {
            const removal = await this.removeRegistration(bot, {
              name: lookup.name,
              target,
            });
            if (removal.status === "failed") {
              failures.push(`${target}: ${removal.error}`);
            } else if (removal.status === "unavailable") {
              skipped.push({ target, status: "skipped", reason: "guild_unavailable" });
            }
          }
          const reported = skipped.length > 0 ? { targets: skipped } : {};
          return failures.length > 0
            ? { ...base, ok: false, action: "delete", error: failures.join("; "), ...reported }
            : { ...base, ok: true, action: "delete", ...reported };
        }
        return {
          ...base,
          ok: false,
          error: `無法計算 desired spec：${lookup.reason}`,
        };
      case "invalid":
        return {
          ...base,
          ok: false,
          error: `無法計算 desired spec：${lookup.reason}`,
        };
    }
  }

  /**
   * 增量 reconcile 單一 guild（OQ-8 補強）。
   *
   * 在 bot 加入新 guild（guildCreate 事件）時呼叫，確保目標涵蓋這個 guild
   * 的指令（all_guilds，或指定的正是這個 guild）自動 register，不需要重啟
   * 才生效。
   *
   * 流程：
   *   1. 枚舉 desired set（只取目標涵蓋此 guild 的項目）
   *   2. 拉取該 guild 的 Discord 現況
   *   3. diff + apply create / patch（不做 stale 清除，讓 reconcileAll 負責全量 cleanup）
   *   4. 更新 reconciler_owned_commands 名冊（限此 guild）
   */
  async reconcileForGuild(guild: Guild): Promise<ReconcileReport> {
    return this.withLock(() => this._reconcileForGuild(guild));
  }

  private async _reconcileForGuild(guild: Guild): Promise<ReconcileReport> {
    const bot = this.getBot();
    if (!bot?.application) {
      botEventLog.record(
        "warn",
        "bot",
        `command-reconciler: reconcileForGuild(${guild.id}) bot not ready, skipping`,
      );
      return emptyReport();
    }

    const report = emptyReport();

    // 步驟 1：枚舉 desired set，只保留目標涵蓋此 guild 的項目（#128：
    // 指定其他伺服器的指令不在這裡註冊）
    const here = guildTarget(guild.id);
    const guildDesired = (await this.listDesired()).filter((c) =>
      targetCovers(c.spec.target, here),
    );

    if (guildDesired.length === 0) {
      return report;
    }

    // 步驟 2：拉取此 guild 的 Discord 現況；拉不到就不動（避免盲目重建）
    const discordState = await this.fetchDiscordState(bot, [here]);
    if (discordState.unreadable.has(here)) return report;

    // 步驟 3：diff + apply；步驟 4：更新名冊（限此 guild）
    for (const cmd of guildDesired) {
      const outcomes = await this.applyCommand(bot, cmd, [here], discordState);
      tally(report, toItemResult(cmd.key, outcomes));
      await this.upsertOwned(cmd, outcomes);
    }

    botEventLog.record(
      "info",
      "bot",
      `command-reconciler: reconcileForGuild(${guild.id}) 完成 created=${report.created} patched=${report.patched} errors=${report.errors.length}`,
    );

    return report;
  }

  // ── 私有：desired set ─────────────────────────────────────────────────────

  private sourceFor(kind: CommandSourceKind): DesiredCommandSource {
    const source = this.sources.get(kind);
    if (!source) throw new Error(`command-reconciler: 沒有 ${kind} 來源`);
    return source;
  }

  private async listDesired(): Promise<DesiredCommand[]> {
    const out: DesiredCommand[] = [];
    for (const source of this.sources.values()) {
      out.push(...(await source.listDesired()));
    }
    return out;
  }

  private concreteTargets(bot: Client, cmd: DesiredCommand): ConcreteTarget[] {
    return expandTarget(cmd.spec.target, bot.guilds.cache.keys());
  }

  // ── 私有：Discord 現況拉取 ────────────────────────────────────────────────

  /**
   * 拉 Discord 現況。`only` 給定時只拉這些具體目標（單條指令 / 單一 guild
   * 用，避免掃過所有伺服器）；未給定時拉全域 + 每個 cached guild。
   * bot 不在的伺服器略過（套用時會回報 skipped）。
   */
  private async fetchDiscordState(
    bot: Client,
    only?: ConcreteTarget[],
  ): Promise<DiscordState> {
    const state: DiscordState = { commands: new Map(), unreadable: new Set() };
    const targets: ConcreteTarget[] = only ?? [
      "global",
      ...[...bot.guilds.cache.keys()].map(guildTarget),
    ];

    for (const target of targets) {
      const manager = commandManagerFor(bot, target);
      if (!manager) continue;
      try {
        const cmds = await manager.fetch();
        for (const cmd of cmds.values()) {
          state.commands.set(stateKey(cmd.name, target), cmd);
        }
      } catch (err) {
        state.unreadable.add(target);
        botEventLog.record(
          "warn",
          "bot",
          `command-reconciler: 拉 ${target} commands 失敗：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return state;
  }

  // ── 私有：Diff & Apply 單條 ───────────────────────────────────────────────

  /**
   * 單條指令的增量路徑（registerOne / reconcileFor*）：只拉這條指令的目標
   * 現況、套用、登記名冊。登記名冊是為了讓之後的 reconcileAll 認得它 ——
   * 否則一條從這裡建立、之後被刪掉的指令，stale 清除找不到，會永遠留在
   * Discord 上。
   */
  private async applyAndRecord(
    bot: Client,
    cmd: DesiredCommand,
  ): Promise<TargetOutcome[]> {
    const targets = this.concreteTargets(bot, cmd);
    const discordState = await this.fetchDiscordState(bot, targets);
    const outcomes = await this.applyCommand(bot, cmd, targets, discordState);
    await this.upsertOwned(cmd, outcomes);
    return outcomes;
  }

  /** 把一個 desired 指令套到給定的具體目標。 */
  private async applyCommand(
    bot: Client,
    cmd: DesiredCommand,
    targets: ConcreteTarget[],
    discordState: DiscordState,
  ): Promise<TargetOutcome[]> {
    const outcomes: TargetOutcome[] = [];
    for (const target of targets) {
      const manager = commandManagerFor(bot, target);
      if (!manager) {
        outcomes.push({ target, status: "skipped", reason: "guild_unavailable" });
        continue;
      }
      const existing = discordState.commands.get(stateKey(cmd.name, target));
      const attempted = !existing
        ? "create"
        : commandNeedsPatch(existing, cmd.spec.data)
          ? "patch"
          : null;
      if (attempted === null) {
        outcomes.push({ target, status: "unchanged" });
        continue;
      }
      try {
        if (attempted === "create") {
          await manager.create(cmd.spec.data);
          outcomes.push({ target, status: "created" });
        } else {
          await manager.edit(existing!.id, cmd.spec.data);
          outcomes.push({ target, status: "patched" });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        botEventLog.record(
          "warn",
          "bot",
          `command-reconciler: ${target} ${cmd.name} 操作失敗：${error}`,
        );
        outcomes.push({ target, status: "failed", attempted, error });
      }
    }
    return outcomes;
  }

  // ── 私有：名冊 / stale 清除 ────────────────────────────────────────────────

  /**
   * Register an item's owned-command rows so a later reconcileAll can
   * recognise + clean them up. Mirrors the apply just performed: one row
   * per concrete target that the bot could reach (skipped guilds get no
   * row). Failures are logged, not thrown — the registry is best-effort
   * bookkeeping that reconcileAll re-derives, not the source of truth.
   */
  private async upsertOwned(
    cmd: DesiredCommand,
    outcomes: TargetOutcome[],
  ): Promise<void> {
    for (const o of outcomes) {
      if (o.status === "skipped") continue;
      await upsertOwnedCommand({ name: cmd.name, target: o.target }).catch(
        (e: unknown) => {
          botEventLog.record(
            "warn",
            "bot",
            `command-reconciler: 名冊 upsert 失敗 ${o.target} ${cmd.name}: ${e instanceof Error ? e.message : String(e)}`,
          );
        },
      );
    }
  }

  /**
   * 從 Discord 與名冊清掉一筆；有清掉名冊列就回 true。目標伺服器不在此
   * process 的 cache（別的 shard，或 bot 已離開）時無法驗證，不動並回
   * false —— 只刪名冊會讓 Discord 端的指令永遠失去認領者，留給看得到它的
   * process 處理。
   */
  private async deleteStale(
    bot: Client,
    owned: OwnedCommand,
  ): Promise<boolean> {
    return (await this.removeRegistration(bot, owned)).status === "removed";
  }

  /** deleteStale 的三態版本：removed / unavailable（碰不到該目標）/ failed。 */
  private async removeRegistration(
    bot: Client,
    owned: OwnedCommand,
  ): Promise<
    | { status: "removed" | "unavailable" }
    | { status: "failed"; error: string }
  > {
    const manager = commandManagerFor(bot, owned.target);
    if (!manager) return { status: "unavailable" };
    try {
      const cmds = await manager.fetch();
      const cmd = cmds.find((c) => c.name === owned.name);
      if (cmd) await manager.delete(cmd.id);
      await deleteOwnedCommand(owned);
      return { status: "removed" };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      botEventLog.record(
        "warn",
        "bot",
        `command-reconciler: stale 清除失敗 ${owned.target} ${owned.name}：${error}`,
      );
      return { status: "failed", error };
    }
  }

  // ── 步驟 5：清舊版 dm-slash-rebind 遺留物 ────────────────────────────────

  /**
   * 清除 dm-slash-rebind 遺留的純 DM 形狀全域指令（C-runtime §3.2 步驟 5a）。
   * 識別條件：contexts = [BotDM, PrivateChannel]（只有 DM context）且 name 不在 desired set。
   */
  private async cleanupLegacyDmSlashCommands(
    bot: Client,
    desired: DesiredCommand[],
  ): Promise<void> {
    const desiredNames = new Set(desired.map((i) => i.name));
    try {
      const globalCmds = await bot.application!.commands.fetch();
      for (const cmd of globalCmds.values()) {
        if (desiredNames.has(cmd.name)) continue;

        // 識別「純 DM context」指令（contexts 只有 BotDM + PrivateChannel）
        const ctxs = (cmd.contexts ?? []) as InteractionContextType[];
        const isDmOnly =
          ctxs.length === 2 &&
          ctxs.includes(InteractionContextType.BotDM) &&
          ctxs.includes(InteractionContextType.PrivateChannel);

        if (isDmOnly) {
          try {
            await bot.application!.commands.delete(cmd.id);
            botEventLog.record(
              "info",
              "bot",
              `command-reconciler: 清除 dm-slash-rebind 遺留指令 /${cmd.name}`,
            );
          } catch (err) {
            botEventLog.record(
              "warn",
              "bot",
              `command-reconciler: 清除遺留指令 /${cmd.name} 失敗：${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      botEventLog.record(
        "warn",
        "bot",
        `command-reconciler: 清舊版產物步驟失敗：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ── 輔助：結果彙整 ───────────────────────────────────────────────────────────

function emptyReport(): ReconcileReport {
  return { created: 0, patched: 0, deleted: 0, errors: [] };
}

/** 非 desired 的 lookup → registerOne 的失敗原因。 */
function notRegistrable(
  lookup: Exclude<DesiredLookup, { status: "desired" }>,
): { reason: "not_found" | "not_desired" | "invalid"; error: string } {
  switch (lookup.status) {
    case "not_found":
      return { reason: "not_found", error: "來源列不存在" };
    case "unmanaged":
      return { reason: "not_desired", error: "不是由 reconciler 管理的指令" };
    case "not_desired":
      return { reason: "not_desired", error: lookup.reason };
    case "invalid":
      return { reason: "invalid", error: lookup.reason };
  }
}

/**
 * 把一條指令的結果計入 report。Count only successful work; a failed
 * create/patch returns ok:false with action set, and must land in errors
 * (not the created/patched totals) so the report can't claim a command
 * was registered when the Discord call actually threw.
 */
function tally(report: ReconcileReport, result: ReconcileItemResult): void {
  if (!result.ok) {
    report.errors.push(result);
  } else if (result.action === "create") {
    report.created++;
  } else if (result.action === "patch") {
    report.patched++;
  }
}

function describeProblems(problems: TargetOutcome[]): string {
  return problems
    .map((o) =>
      o.status === "failed"
        ? `${o.target}: ${o.error}`
        : `${o.target}: ${o.status === "skipped" ? o.reason : o.status}`,
    )
    .join("; ");
}

/**
 * 把一個指令的各目標結果彙整成 ReconcileItemResult。action 取實際做過的
 * 最強動作（create > patch > noop）—— 一個邏輯指令最多計一次，不論展開到
 * 幾個伺服器；任一目標失敗則 ok=false，error 逐目標列出（不再只留最後一個）。
 * skipped（bot 不在指定伺服器）不算錯誤：可能在別的 shard，或 bot 已離開。
 */
function toItemResult(
  key: CommandKey,
  outcomes: TargetOutcome[],
): ReconcileItemResult {
  // 失敗的目標以「嘗試過的動作」計入，維持舊行為（失敗的 create 回報
  // action=create、ok=false）
  const triedOrDid = (
    attempted: "create" | "patch",
    done: "created" | "patched",
  ): boolean =>
    outcomes.some(
      (o) =>
        o.status === done ||
        (o.status === "failed" && o.attempted === attempted),
    );
  const action = triedOrDid("create", "created")
    ? "create"
    : triedOrDid("patch", "patched")
      ? "patch"
      : "noop";
  const failed = outcomes.filter((o) => o.status === "failed");
  if (failed.length > 0) {
    return {
      ok: false,
      source: key.source,
      sourceId: key.id,
      action,
      error: describeProblems(failed),
      targets: outcomes,
    };
  }
  return {
    ok: true,
    source: key.source,
    sourceId: key.id,
    action,
    targets: outcomes,
  };
}
