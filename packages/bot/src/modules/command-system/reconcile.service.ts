/**
 * command-system/reconcile.service.ts
 *
 * CommandReconciler：軌二（behaviors）+ 軌三（plugin_commands）Discord 指令
 * 統一 reconcile 入口。對齊 C-runtime §2.2 介面定義 + §3.2 流程 2 + §3.3 三軸表。
 *
 * 「軌一不動」保證（C-runtime §1）：
 *   - 本服務只認領 reconciler_owned_commands 名冊 + desired set 中的指令
 *   - 任何 featureKey 非 null 的 plugin_commands 由 PluginCommandRegistry 管，不觸碰
 *   - in-process 指令（picture-only-channel 等）不在 desired set，不動
 */

import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  type Client,
  type Guild,
  type ApplicationCommandData,
  type ApplicationCommand,
} from "discord.js";
import { Op } from "sequelize";
import {
  Behavior,
  type BehaviorRow,
} from "../behavior/models/behavior.model.js";
import {
  PluginCommand,
  type PluginCommandRow,
} from "../plugin-system/models/plugin-command.model.js";
import {
  findPluginById,
  type PluginRow,
} from "../plugin-system/models/plugin.model.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import type {
  CommandScope,
  DiscordContext,
  DiscordIntegrationType,
  DiscordRegistrationSpec,
  ReconcileItemResult,
  ReconcileReport,
} from "./types.js";
import { RejectionError } from "./types.js";
import type {
  PluginManifest,
  ManifestPluginCommand,
  ManifestCommandOption,
} from "../plugin-system/plugin-registry.service.js";
import { manifestOptionToData } from "../plugin-system/plugin-command-registry.service.js";
import { ReconcilerOwnedCommand } from "./models/reconciler-owned-command.model.js";

// ── Discord 三軸對照表 ────────────────────────────────────────────────────────

const CONTEXT_MAP: Record<DiscordContext, InteractionContextType> = {
  Guild: InteractionContextType.Guild,
  BotDM: InteractionContextType.BotDM,
  PrivateChannel: InteractionContextType.PrivateChannel,
};

const INTEGRATION_MAP: Record<
  DiscordIntegrationType,
  ApplicationIntegrationType
> = {
  guild_install: ApplicationIntegrationType.GuildInstall,
  user_install: ApplicationIntegrationType.UserInstall,
};

// ── 輔助：三軸 string → 陣列解析 ─────────────────────────────────────────────

function parseContexts(raw: string): DiscordContext[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(
      (s): s is DiscordContext =>
        s === "Guild" || s === "BotDM" || s === "PrivateChannel",
    );
}

function parseIntegrationTypes(raw: string): DiscordIntegrationType[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(
      (s): s is DiscordIntegrationType =>
        s === "guild_install" || s === "user_install",
    );
}

// ── 輔助：行比對（指令是否需要 patch）────────────────────────────────────────

/**
 * Canonical JSON for options comparison.
 * Projects each option (and nested sub-command options) to a stable
 * {type, name, description, required, options} shape, sorts sibling
 * arrays by name, then serialises to JSON.
 * Used for both the desired side (ApplicationCommandOptionData[]) and
 * the existing side (ApplicationCommandOption[] from Discord's cache).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function canonicalOptions(options: any[]): string {
  type CanonicalOption = {
    type: number;
    name: string;
    description: string;
    required: boolean;
    choices?: unknown[];
    channel_types?: number[];
    min_value?: number | null;
    max_value?: number | null;
    autocomplete?: boolean;
    description_localizations?: Record<string, string>;
    name_localizations?: Record<string, string>;
    options?: CanonicalOption[];
  };
  // Discord returns localization maps under snake_case (REST shape) but
  // discord.js camelCases them on `ApplicationCommandOption`. Read both
  // so the diff catches localization-only changes whether the desired
  // side originated from a JS literal (camelCase) or the wire (snake).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function sortedLocalizationMap(raw: any): Record<string, string> | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const entries = Object.entries(raw as Record<string, string>);
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function project(o: any): CanonicalOption {
    const node: CanonicalOption = {
      type: o.type as number,
      name: o.name as string,
      description: (o.description as string | undefined) ?? "",
      required: (o.required as boolean | undefined) ?? false,
      choices: o.choices ?? [],
      channel_types: o.channel_types ?? o.channelTypes ?? [],
      min_value: o.min_value ?? o.minValue ?? null,
      max_value: o.max_value ?? o.maxValue ?? null,
      autocomplete: o.autocomplete ?? false,
    };
    const descLoc = sortedLocalizationMap(
      o.description_localizations ?? o.descriptionLocalizations,
    );
    if (descLoc) node.description_localizations = descLoc;
    const nameLoc = sortedLocalizationMap(
      o.name_localizations ?? o.nameLocalizations,
    );
    if (nameLoc) node.name_localizations = nameLoc;
    if (Array.isArray(o.options) && o.options.length > 0) {
      node.options = (o.options as unknown[])
        .map(project)
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    return node;
  }
  return JSON.stringify(
    options.map(project).sort((a, b) => a.name.localeCompare(b.name)),
  );
}

function commandNeedsPatch(
  existing: ApplicationCommand,
  desired: ApplicationCommandData,
): boolean {
  // 比對 description
  const existDesc = "description" in existing ? existing.description : "";
  const desiredDesc =
    "description" in desired
      ? ((desired as { description?: string }).description ?? "")
      : "";
  if (existDesc !== desiredDesc) return true;

  // 比對 top-level description_localizations / name_localizations.
  // discord.js's ApplicationCommand carries them as camelCase
  // (`descriptionLocalizations`); the desired side (our manifest data)
  // uses camelCase too. Compare via sorted-keys canonical JSON.
  const canonLocMap = (raw: unknown): string => {
    if (!raw || typeof raw !== "object") return "";
    const entries = Object.entries(raw as Record<string, string>);
    return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
  };
  const existDescLoc = (existing as { descriptionLocalizations?: unknown })
    .descriptionLocalizations;
  const desiredDescLoc = (desired as { descriptionLocalizations?: unknown })
    .descriptionLocalizations;
  if (canonLocMap(existDescLoc) !== canonLocMap(desiredDescLoc)) return true;
  const existNameLoc = (existing as { nameLocalizations?: unknown })
    .nameLocalizations;
  const desiredNameLoc = (desired as { nameLocalizations?: unknown })
    .nameLocalizations;
  if (canonLocMap(existNameLoc) !== canonLocMap(desiredNameLoc)) return true;

  // 比對 contexts — numeric enum values, so sort numerically (both sides
  // identically) before joining, otherwise the canonical strings can
  // differ purely from JS's default lexicographic Array.sort().
  const byNumber = (a: number, b: number): number => a - b;
  const existCtxSorted = (existing.contexts ?? [])
    .slice()
    .sort(byNumber)
    .join(",");
  const desiredCtx =
    (desired as { contexts?: InteractionContextType[] }).contexts ?? [];
  const desiredCtxSorted = desiredCtx.slice().sort(byNumber).join(",");
  if (existCtxSorted !== desiredCtxSorted) return true;

  // 比對 integrationTypes — likewise numeric enum values.
  const existItSorted = (existing.integrationTypes ?? [])
    .slice()
    .sort(byNumber)
    .join(",");
  const desiredIt =
    (desired as { integrationTypes?: ApplicationIntegrationType[] })
      .integrationTypes ?? [];
  const desiredItSorted = desiredIt.slice().sort(byNumber).join(",");
  if (existItSorted !== desiredItSorted) return true;

  // 比對 options（sub_command / 參數定義）
  // Discord cache 的 existing.options 是 ApplicationCommandOption[]；
  // desired.options 是 ApplicationCommandOptionData[]。
  // 兩側都序列化成 canonical JSON 再比對，避免嵌套 sub_command stale。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existOptions: any[] = (existing as any).options ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const desiredOptions: any[] = (desired as any).options ?? [];
  if (canonicalOptions(existOptions) !== canonicalOptions(desiredOptions)) {
    return true;
  }

  return false;
}

// ── reconciler_owned_commands 名冊操作（透過 ReconcilerOwnedCommand model）─────

interface OwnedCommandKey {
  name: string;
  scope: CommandScope;
  guildId: string | null;
}

async function loadOwnedCommands(): Promise<Set<string>> {
  // key format: `${scope}:${name}:${guildId ?? ""}`
  const rows = await ReconcilerOwnedCommand.findAll();
  const result = new Set<string>();
  for (const r of rows) {
    const scope = r.getDataValue("scope") as string;
    const name = r.getDataValue("name") as string;
    const guildId = r.getDataValue("guildId") as string | null;
    result.add(`${scope}:${name}:${guildId ?? ""}`);
  }
  return result;
}

async function upsertOwnedCommand(key: OwnedCommandKey): Promise<void> {
  // 先刪再建：partial unique index 下不能用 upsert，且每次 reconcile 都要
  // 刷新 ownedAt。create() 會觸發 model 的 scopeGuildShape validate。
  const ownedAt = new Date();
  if (key.scope === "global") {
    await ReconcilerOwnedCommand.destroy({
      where: { name: key.name, scope: "global", guildId: { [Op.is]: null } },
    });
    await ReconcilerOwnedCommand.create({
      name: key.name,
      scope: "global",
      guildId: null,
      ownedAt,
    });
  } else {
    await ReconcilerOwnedCommand.destroy({
      where: { name: key.name, scope: "guild", guildId: key.guildId },
    });
    await ReconcilerOwnedCommand.create({
      name: key.name,
      scope: "guild",
      guildId: key.guildId,
      ownedAt,
    });
  }
}

async function deleteOwnedCommand(key: OwnedCommandKey): Promise<void> {
  if (key.scope === "global") {
    await ReconcilerOwnedCommand.destroy({
      where: { name: key.name, scope: "global", guildId: { [Op.is]: null } },
    });
  } else {
    await ReconcilerOwnedCommand.destroy({
      where: { name: key.name, scope: "guild", guildId: key.guildId },
    });
  }
}

// ── deriveRegistrationCall（C-runtime §3.3 三軸 → Discord 登記形狀）──────────

/**
 * 依三軸計算 Discord API call shape。
 * 對齊 C-runtime §3.3 的 9 種合法組合（含 #8 非法修正）。
 * 非法組合回 RejectionError。
 *
 * 欄位 name/description 由呼叫方傳入（behaviors.slashCommandName / plugin_commands.name）。
 */
export function deriveRegistrationCall(
  name: string,
  description: string,
  scope: CommandScope,
  integrationTypes: DiscordIntegrationType[],
  contexts: DiscordContext[],
  options?: ManifestCommandOption[],
  localizations?: {
    description_localizations?: Record<string, string>;
    name_localizations?: Record<string, string>;
  },
): DiscordRegistrationSpec {
  // 非法組合檢查（C-runtime §3.3 底部非法清單）
  if (integrationTypes.length === 0) {
    throw new RejectionError("integrationTypes 不得為空");
  }
  if (contexts.length === 0) {
    throw new RejectionError("contexts 不得為空");
  }
  if (scope === "guild") {
    if (integrationTypes.includes("user_install")) {
      throw new RejectionError("scope=guild 不支援 user_install");
    }
    if (
      integrationTypes.includes("guild_install") &&
      integrationTypes.includes("user_install")
    ) {
      throw new RejectionError(
        "scope=guild 不支援 guild_install+user_install 組合",
      );
    }
    // M-8 修：scope=guild + 含 BotDM 為非法
    if (contexts.some((c) => c !== "Guild")) {
      throw new RejectionError(
        "scope=guild 的 contexts 只能包含 Guild（BotDM/PrivateChannel 非法）",
      );
    }
  }

  const discordContexts = contexts.map((c) => CONTEXT_MAP[c]);
  const discordIntegrationTypes = integrationTypes.map(
    (t) => INTEGRATION_MAP[t],
  );

  const data: Record<string, unknown> = {
    type: ApplicationCommandType.ChatInput,
    name,
    description,
  };

  // Discord's per-locale picker overrides. Map snake_case (manifest /
  // wire shape) → camelCase (discord.js ApplicationCommandData).
  if (localizations?.description_localizations) {
    data["descriptionLocalizations"] = localizations.description_localizations;
  }
  if (localizations?.name_localizations) {
    data["nameLocalizations"] = localizations.name_localizations;
  }

  if (discordContexts.length > 0) {
    data["contexts"] = discordContexts;
  }
  if (discordIntegrationTypes.length > 0) {
    data["integrationTypes"] = discordIntegrationTypes;
  }
  if (options && options.length > 0) {
    data["options"] = options.map(manifestOptionToData);
  }

  return {
    scope,
    data: data as unknown as ApplicationCommandData,
  };
}

// ── DesiredItem：reconcile desired set 的元素 ────────────────────────────────

interface DesiredItem {
  name: string;
  spec: DiscordRegistrationSpec;
  source: "behavior" | "plugin_command";
  sourceId: number;
}

// ── CommandReconciler 主類別 ──────────────────────────────────────────────────

export class CommandReconciler {
  private reconcileLock: Promise<void> = Promise.resolve();

  constructor(private readonly getBot: () => Client | null) {}

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
      return { created: 0, patched: 0, deleted: 0, errors: [] };
    }

    const report: ReconcileReport = {
      created: 0,
      patched: 0,
      deleted: 0,
      errors: [],
    };

    // 步驟 1：枚舉 desired set
    const desiredItems = await this.buildDesiredSet();

    // 步驟 3：拉 Discord 現況
    const discordState = await this.fetchDiscordState(bot);

    // 載入已知名冊（避免誤刪軌一）
    const ownedSet = await loadOwnedCommands();

    // 步驟 4：Diff & Apply
    for (const item of desiredItems) {
      try {
        const result = await this.applyOne(bot, item, discordState);
        // Count only successful work; a failed create/patch returns
        // ok:false with action set, and must land in errors (not the
        // created/patched totals) so the report can't claim a command
        // was registered when the Discord call actually threw.
        if (result.ok) {
          if (result.action === "create") report.created++;
          else if (result.action === "patch") report.patched++;
        } else {
          report.errors.push(result);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        report.errors.push({
          ok: false,
          source: item.source,
          sourceId: item.sourceId,
          error,
        });
      }
    }

    // 步驟 4 續：stale 清除（名冊中有、但 desired set 沒有的指令）
    const desiredNames = new Set(
      desiredItems.map((i) => `${i.spec.scope}:${i.name}`),
    );

    for (const key of ownedSet) {
      // key format: `${scope}:${name}:${guildId ?? ""}`
      const [scope, name, guildIdPart] = key.split(":");
      if (!scope || !name) continue;
      const desiredKey = `${scope}:${name}`;
      if (!desiredNames.has(desiredKey)) {
        // stale：此指令已不在 desired set，從 Discord + 名冊刪除
        await this.deleteStale(
          bot,
          name,
          scope as CommandScope,
          guildIdPart || null,
        );
        report.deleted++;
      }
    }

    // 步驟 5：清舊版產物（dm-slash-rebind 遺留物）
    await this.cleanupLegacyDmSlashCommands(bot, desiredItems);

    // 步驟末：upsert 名冊
    for (const item of desiredItems) {
      await this.upsertOwnedForItem(bot, item);
    }

    botEventLog.record(
      "info",
      "bot",
      `command-reconciler: reconcileAll 完成 created=${report.created} patched=${report.patched} deleted=${report.deleted} errors=${report.errors.length}`,
    );

    return report;
  }

  /**
   * 增量 reconcile 單條 behavior（admin CRUD 後呼叫）。
   * 若 triggerType !== 'slash_command' 則為 no-op。
   */
  async reconcileForBehavior(behaviorId: number): Promise<ReconcileItemResult> {
    return this.withLock(() => this._reconcileForBehavior(behaviorId));
  }

  private async _reconcileForBehavior(
    behaviorId: number,
  ): Promise<ReconcileItemResult> {
    const bot = this.getBot();
    if (!bot?.application) {
      return {
        ok: false,
        source: "behavior",
        sourceId: behaviorId,
        error: "bot not ready",
      };
    }

    const row = await Behavior.findByPk(behaviorId);
    if (!row) {
      return {
        ok: false,
        source: "behavior",
        sourceId: behaviorId,
        error: "behavior not found",
      };
    }

    const behaviorRow = rowOfBehavior(row);

    // message_pattern 不在 Discord 指令登記範疇
    if (behaviorRow.triggerType !== "slash_command") {
      return {
        ok: true,
        source: "behavior",
        sourceId: behaviorId,
        action: "noop",
      };
    }

    if (!behaviorRow.enabled) {
      // disabled：從 Discord 刪除（若存在）
      await this.deleteIfExistsForBehavior(bot, behaviorRow);
      return {
        ok: true,
        source: "behavior",
        sourceId: behaviorId,
        action: "delete",
      };
    }

    const item = await this.behaviorToDesiredItem(behaviorRow);
    if (!item) {
      return {
        ok: false,
        source: "behavior",
        sourceId: behaviorId,
        error: "無法計算 desired spec（三軸非法或缺少 slashCommandName）",
      };
    }

    const discordState = await this.fetchDiscordState(bot);
    const result = await this.applyOne(bot, item, discordState);
    // Register in the owned-commands roster so a later reconcileAll can
    // recognise + clean this command up. Without this, a command created
    // via this incremental path (e.g. /resync) is invisible to the
    // roster, so when the behavior is later deleted reconcileAll's stale
    // sweep can't find it and it orphans on Discord.
    await this.upsertOwnedForItem(bot, item);
    return result;
  }

  /**
   * 增量 reconcile 單條 plugin 自訂指令（plugin register/update 後呼叫）。
   * rowId 對應 plugin_commands.id（featureKey=null 的那半部）。
   */
  async reconcileForPluginCommand(rowId: number): Promise<ReconcileItemResult> {
    return this.withLock(() => this._reconcileForPluginCommand(rowId));
  }

  private async _reconcileForPluginCommand(
    rowId: number,
  ): Promise<ReconcileItemResult> {
    const bot = this.getBot();
    if (!bot?.application) {
      return {
        ok: false,
        source: "plugin_command",
        sourceId: rowId,
        error: "bot not ready",
      };
    }

    const row = await PluginCommand.findByPk(rowId);
    if (!row) {
      return {
        ok: false,
        source: "plugin_command",
        sourceId: rowId,
        error: "plugin_command row not found",
      };
    }

    const cmdRow = rowOfPluginCommand(row);
    if (cmdRow.featureKey !== null) {
      // 軌一指令，不由本服務管
      return {
        ok: true,
        source: "plugin_command",
        sourceId: rowId,
        action: "noop",
      };
    }

    const item = await this.pluginCommandToDesiredItem(cmdRow);
    if (!item) {
      return {
        ok: false,
        source: "plugin_command",
        sourceId: rowId,
        error:
          "無法計算 desired spec（schema_version 非 \"1\"、三軸非法、或 plugin 不存在）",
      };
    }

    const discordState = await this.fetchDiscordState(bot);
    const result = await this.applyOne(bot, item, discordState);
    // Register in the owned-commands roster (see _reconcileForBehavior) so
    // reconcileAll's stale sweep can later clean up a command first created
    // via this incremental path.
    await this.upsertOwnedForItem(bot, item);
    return result;
  }

  /**
   * 增量 reconcile 單一 guild（OQ-8 補強）。
   *
   * 在 bot 加入新 guild（guildCreate 事件）時呼叫，確保 scope='guild' 的
   * 軌二 behaviors 與軌三 plugin_commands 在該 guild 自動 register，
   * 不需要重啟才生效。
   *
   * 流程：
   *   1. 枚舉 desired set（只取 scope='guild' 的項目）
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
      return { created: 0, patched: 0, deleted: 0, errors: [] };
    }

    const report: ReconcileReport = {
      created: 0,
      patched: 0,
      deleted: 0,
      errors: [],
    };

    // 步驟 1：枚舉 desired set，只保留 scope='guild' 的項目
    const allDesired = await this.buildDesiredSet();
    const guildDesired = allDesired.filter((i) => i.spec.scope === "guild");

    if (guildDesired.length === 0) {
      return report;
    }

    // 步驟 2：拉取此 guild 的 Discord 現況
    const discordState = new Map<string, ApplicationCommand>();
    try {
      const guildCmds = await guild.commands.fetch();
      for (const cmd of guildCmds.values()) {
        discordState.set(`guild:${cmd.name}:${guild.id}`, cmd);
      }
    } catch (err) {
      botEventLog.record(
        "warn",
        "bot",
        `command-reconciler: reconcileForGuild(${guild.id}) 拉 guild commands 失敗：${err instanceof Error ? err.message : String(err)}`,
      );
      return report;
    }

    // 步驟 3：diff + apply
    for (const item of guildDesired) {
      const { name, spec, source, sourceId } = item;
      const key = `guild:${name}:${guild.id}`;
      const existing = discordState.get(key);
      try {
        if (!existing) {
          await guild.commands.create(spec.data);
          report.created++;
        } else if (commandNeedsPatch(existing, spec.data)) {
          await guild.commands.edit(existing.id, spec.data);
          report.patched++;
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        report.errors.push({ ok: false, source, sourceId, error });
        botEventLog.record(
          "warn",
          "bot",
          `command-reconciler: reconcileForGuild(${guild.id}) ${name} 失敗：${error}`,
        );
      }
    }

    // 步驟 4：更新名冊（限此 guild 的 guild-scope 項目）
    for (const item of guildDesired) {
      await upsertOwnedCommand({
        name: item.name,
        scope: "guild",
        guildId: guild.id,
      }).catch((e: unknown) => {
        botEventLog.record(
          "warn",
          "bot",
          `command-reconciler: reconcileForGuild 名冊 upsert 失敗 ${item.name}/${guild.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }

    botEventLog.record(
      "info",
      "bot",
      `command-reconciler: reconcileForGuild(${guild.id}) 完成 created=${report.created} patched=${report.patched} errors=${report.errors.length}`,
    );

    return report;
  }

  // ── 私有：desired set 建構 ────────────────────────────────────────────────

  private async buildDesiredSet(): Promise<DesiredItem[]> {
    const items: DesiredItem[] = [];

    // 步驟 1a：behaviors 表 WHERE enabled=true AND triggerType='slash_command'
    const behaviorRows = await Behavior.findAll({
      where: {
        enabled: true,
        triggerType: "slash_command",
      },
    });

    for (const row of behaviorRows) {
      const item = await this.behaviorToDesiredItem(rowOfBehavior(row));
      if (item) items.push(item);
    }

    // 步驟 1b：plugin_commands WHERE featureKey IS NULL（軌三）
    const pluginCmdRows = await PluginCommand.findAll({
      where: {
        featureKey: { [Op.is]: null },
      },
    });

    for (const row of pluginCmdRows) {
      const cmdRow = rowOfPluginCommand(row);
      const item = await this.pluginCommandToDesiredItem(cmdRow);
      if (item) items.push(item);
    }

    return items;
  }

  private async behaviorToDesiredItem(
    row: BehaviorRow,
  ): Promise<DesiredItem | null> {
    if (!row.slashCommandName) return null;

    const integrationTypes = parseIntegrationTypes(row.integrationTypes);
    const contexts = parseContexts(row.contexts);

    let spec: DiscordRegistrationSpec;
    try {
      spec = deriveRegistrationCall(
        row.slashCommandName,
        row.slashCommandDescription ?? row.title,
        row.scope,
        integrationTypes,
        contexts,
        undefined,
      );
    } catch (err) {
      if (err instanceof RejectionError) {
        botEventLog.record(
          "warn",
          "bot",
          `command-reconciler: behavior ${row.id} 三軸非法，跳過：${err.reason}`,
          { behaviorId: row.id },
        );
        return null;
      }
      throw err;
    }

    return {
      name: row.slashCommandName,
      spec,
      source: "behavior",
      sourceId: row.id,
    };
  }

  private async pluginCommandToDesiredItem(
    row: PluginCommandRow,
  ): Promise<DesiredItem | null> {
    // OQ-14 守衛：檢查 plugin 的 manifest schema_version 是否為 "1"
    const plugin = await findPluginById(row.pluginId);
    if (!plugin) return null;

    let manifest: PluginManifest | null = null;
    try {
      const parsed = JSON.parse(plugin.manifestJson) as PluginManifest;
      if (parsed.schema_version !== "1") {
        return null;
      }
      manifest = parsed;
    } catch {
      return null;
    }

    // 從 manifestJson 找到對應的 plugin_command 定義
    let cmdManifest: ManifestPluginCommand | null = null;
    try {
      const parsed = JSON.parse(row.manifestJson) as ManifestPluginCommand;
      cmdManifest = parsed;
    } catch {
      return null;
    }

    if (!cmdManifest || !cmdManifest.name) return null;

    // 確認 plugin + command 都在 enabled 狀態
    if (!plugin.enabled) return null;
    if (plugin.status !== "active") return null;

    // 確認 adminEnabled：admin 可停用個別指令
    if (!row.adminEnabled) return null;

    const integrationTypes = cmdManifest.integration_types.filter(
      (t): t is DiscordIntegrationType =>
        t === "guild_install" || t === "user_install",
    );
    const contexts = cmdManifest.contexts.filter(
      (c): c is DiscordContext =>
        c === "Guild" || c === "BotDM" || c === "PrivateChannel",
    );
    const scope: CommandScope =
      cmdManifest.scope === "guild" ? "guild" : "global";

    let spec: DiscordRegistrationSpec;
    try {
      spec = deriveRegistrationCall(
        cmdManifest.name,
        cmdManifest.description,
        scope,
        integrationTypes,
        contexts,
        cmdManifest.options,
        (() => {
          // Accept either snake_case (SDK 0.8+ canonical) or camelCase
          // (plugins built against older SDKs that emit camelCase via
          // module augmentation) so neither shape is silently dropped.
          const cm = cmdManifest as typeof cmdManifest & {
            descriptionLocalizations?: Record<string, string>;
            nameLocalizations?: Record<string, string>;
          };
          const descLoc =
            cm.description_localizations ?? cm.descriptionLocalizations;
          const nameLoc = cm.name_localizations ?? cm.nameLocalizations;
          return {
            ...(descLoc ? { description_localizations: descLoc } : {}),
            ...(nameLoc ? { name_localizations: nameLoc } : {}),
          };
        })(),
      );
    } catch (err) {
      if (err instanceof RejectionError) {
        botEventLog.record(
          "warn",
          "bot",
          `command-reconciler: plugin_command ${row.id} (${row.name}) 三軸非法，跳過：${err.reason}`,
          { pluginId: row.pluginId, cmdName: row.name },
        );
        return null;
      }
      throw err;
    }

    // manifest 用於 OQ-14 守衛（已在上方使用）
    void manifest;

    return {
      name: cmdManifest.name,
      spec,
      source: "plugin_command",
      sourceId: row.id,
    };
  }

  // ── 私有：Discord 現況拉取 ────────────────────────────────────────────────

  private async fetchDiscordState(
    bot: Client,
  ): Promise<Map<string, ApplicationCommand>> {
    // key: `${scope}:${name}:${guildId ?? ""}`
    const state = new Map<string, ApplicationCommand>();

    // 全域指令
    try {
      const globalCmds = await bot.application!.commands.fetch();
      for (const cmd of globalCmds.values()) {
        state.set(`global:${cmd.name}:`, cmd);
      }
    } catch (err) {
      botEventLog.record(
        "warn",
        "bot",
        `command-reconciler: 拉 global commands 失敗：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // per-guild 指令
    for (const guild of bot.guilds.cache.values()) {
      try {
        const guildCmds = await guild.commands.fetch();
        for (const cmd of guildCmds.values()) {
          state.set(`guild:${cmd.name}:${guild.id}`, cmd);
        }
      } catch (err) {
        botEventLog.record(
          "warn",
          "bot",
          `command-reconciler: 拉 guild ${guild.id} commands 失敗：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return state;
  }

  // ── 私有：Diff & Apply 單條 ───────────────────────────────────────────────

  private async applyOne(
    bot: Client,
    item: DesiredItem,
    discordState: Map<string, ApplicationCommand>,
  ): Promise<ReconcileItemResult> {
    const { name, spec, source, sourceId } = item;

    if (spec.scope === "global") {
      const key = `global:${name}:`;
      const existing = discordState.get(key);
      if (!existing) {
        // create
        try {
          await bot.application!.commands.create(spec.data);
          return { ok: true, source, sourceId, action: "create" };
        } catch (err) {
          return {
            ok: false,
            source,
            sourceId,
            action: "create",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      } else {
        if (commandNeedsPatch(existing, spec.data)) {
          try {
            await bot.application!.commands.edit(existing.id, spec.data);
            return { ok: true, source, sourceId, action: "patch" };
          } catch (err) {
            return {
              ok: false,
              source,
              sourceId,
              action: "patch",
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
        return { ok: true, source, sourceId, action: "noop" };
      }
    } else {
      // guild scope：對每個 bot 所在 guild 操作
      let anyError: string | undefined;
      let anyCreate = false;
      let anyPatch = false;
      for (const guild of bot.guilds.cache.values()) {
        const key = `guild:${name}:${guild.id}`;
        const existing = discordState.get(key);
        try {
          if (!existing) {
            await guild.commands.create(spec.data);
            anyCreate = true;
          } else if (commandNeedsPatch(existing, spec.data)) {
            await guild.commands.edit(existing.id, spec.data);
            anyPatch = true;
          }
        } catch (err) {
          anyError = err instanceof Error ? err.message : String(err);
          botEventLog.record(
            "warn",
            "bot",
            `command-reconciler: guild ${guild.id} ${name} 操作失敗：${anyError}`,
          );
        }
      }
      if (anyError) {
        return {
          ok: false,
          source,
          sourceId,
          action: "patch",
          error: anyError,
        };
      }
      // Report the strongest action actually taken across guilds. This
      // previously always returned "noop", so reconcileAll's created /
      // patched totals never counted guild-scope work (always 0) and the
      // resync endpoint mislabelled every guild command as a no-op. Per-
      // item granularity matches the global branch (one logical command
      // = at most one count, regardless of how many guilds it fans out to).
      const action = anyCreate ? "create" : anyPatch ? "patch" : "noop";
      return { ok: true, source, sourceId, action };
    }
  }

  // ── 私有：stale 清除 ───────────────────────────────────────────────────────

  /**
   * Register an item's owned-command rows so a later reconcileAll can
   * recognise + clean them up. Mirrors the apply just performed: one row
   * for a global command, one per bot guild for a guild-scoped command.
   * Failures are logged, not thrown — the registry is best-effort
   * bookkeeping that reconcileAll re-derives, not the source of truth.
   */
  private async upsertOwnedForItem(
    bot: Client,
    item: DesiredItem,
  ): Promise<void> {
    if (item.spec.scope === "global") {
      await upsertOwnedCommand({
        name: item.name,
        scope: "global",
        guildId: null,
      }).catch((e: unknown) => {
        botEventLog.record(
          "warn",
          "bot",
          `command-reconciler: 名冊 upsert 失敗 ${item.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    } else {
      // guild scope：為每個 bot 所在 guild 各登記一筆
      for (const guild of bot.guilds.cache.values()) {
        await upsertOwnedCommand({
          name: item.name,
          scope: "guild",
          guildId: guild.id,
        }).catch((e: unknown) => {
          botEventLog.record(
            "warn",
            "bot",
            `command-reconciler: 名冊 upsert 失敗 ${item.name}/${guild.id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      }
    }
  }

  private async deleteStale(
    bot: Client,
    name: string,
    scope: CommandScope,
    guildId: string | null,
  ): Promise<void> {
    try {
      if (scope === "global") {
        const cmds = await bot.application!.commands.fetch();
        const cmd = cmds.find((c) => c.name === name);
        if (cmd) await bot.application!.commands.delete(cmd.id);
      } else if (guildId) {
        const guild = bot.guilds.cache.get(guildId);
        if (guild) {
          const cmds = await guild.commands.fetch();
          const cmd = cmds.find((c) => c.name === name);
          if (cmd) await guild.commands.delete(cmd.id);
        }
      }
      await deleteOwnedCommand({ name, scope, guildId });
    } catch (err) {
      botEventLog.record(
        "warn",
        "bot",
        `command-reconciler: stale 清除失敗 ${scope}:${name}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async deleteIfExistsForBehavior(
    bot: Client,
    row: BehaviorRow,
  ): Promise<void> {
    if (!row.slashCommandName) return;
    const name = row.slashCommandName;
    const scope: CommandScope = row.scope === "guild" ? "guild" : "global";
    if (scope === "global") {
      await this.deleteStale(bot, name, "global", null);
    } else {
      for (const guild of bot.guilds.cache.values()) {
        await this.deleteStale(bot, name, "guild", guild.id);
      }
    }
  }

  // ── 步驟 5：清舊版 dm-slash-rebind 遺留物 ────────────────────────────────

  /**
   * 清除 dm-slash-rebind 遺留的純 DM 形狀全域指令（C-runtime §3.2 步驟 5a）。
   * 識別條件：contexts = [BotDM, PrivateChannel]（只有 DM context）且 name 不在 desired set。
   */
  private async cleanupLegacyDmSlashCommands(
    bot: Client,
    desiredItems: DesiredItem[],
  ): Promise<void> {
    const desiredNames = new Set(desiredItems.map((i) => i.name));
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

// ── 輔助：Sequelize model instance → typed row ───────────────────────────────

function rowOfBehavior(model: InstanceType<typeof Behavior>): BehaviorRow {
  return {
    id: model.getDataValue("id") as number,
    title: model.getDataValue("title") as string,
    description: (model.getDataValue("description") as string) ?? "",
    enabled: !!model.getDataValue("enabled"),
    sortOrder: model.getDataValue("sortOrder") as number,
    stopOnMatch: !!model.getDataValue("stopOnMatch"),
    forwardType: model.getDataValue(
      "forwardType",
    ) as BehaviorRow["forwardType"],
    source: model.getDataValue("source") as BehaviorRow["source"],
    triggerType: model.getDataValue(
      "triggerType",
    ) as BehaviorRow["triggerType"],
    messagePatternKind:
      (model.getDataValue(
        "messagePatternKind",
      ) as BehaviorRow["messagePatternKind"]) ?? null,
    messagePatternValue:
      (model.getDataValue("messagePatternValue") as string | null) ?? null,
    slashCommandName:
      (model.getDataValue("slashCommandName") as string | null) ?? null,
    slashCommandDescription:
      (model.getDataValue("slashCommandDescription") as string | null) ?? null,
    scope: model.getDataValue("scope") as BehaviorRow["scope"],
    integrationTypes: model.getDataValue("integrationTypes") as string,
    contexts: model.getDataValue("contexts") as string,
    placementGuildId:
      (model.getDataValue("placementGuildId") as string | null) ?? null,
    placementChannelId:
      (model.getDataValue("placementChannelId") as string | null) ?? null,
    audienceKind: model.getDataValue(
      "audienceKind",
    ) as BehaviorRow["audienceKind"],
    audienceUserId:
      (model.getDataValue("audienceUserId") as string | null) ?? null,
    audienceGroupName:
      (model.getDataValue("audienceGroupName") as string | null) ?? null,
    webhookUrl: (model.getDataValue("webhookUrl") as string | null) ?? null,
    webhookSecret:
      (model.getDataValue("webhookSecret") as string | null) ?? null,
    webhookAuthMode:
      (model.getDataValue(
        "webhookAuthMode",
      ) as BehaviorRow["webhookAuthMode"]) ?? null,
    systemKey:
      (model.getDataValue("systemKey") as BehaviorRow["systemKey"]) ?? null,
    scopeTabId: (model.getDataValue("scopeTabId") as number) ?? 1,
  };
}

function rowOfPluginCommand(
  model: InstanceType<typeof PluginCommand>,
): PluginCommandRow {
  return {
    id: model.getDataValue("id") as number,
    pluginId: model.getDataValue("pluginId") as number,
    guildId: (model.getDataValue("guildId") as string | null) ?? null,
    name: model.getDataValue("name") as string,
    discordCommandId:
      (model.getDataValue("discordCommandId") as string | null) ?? null,
    featureKey: (model.getDataValue("featureKey") as string | null) ?? null,
    manifestJson: model.getDataValue("manifestJson") as string,
    adminEnabled:
      model.getDataValue("adminEnabled") !== 0 &&
      model.getDataValue("adminEnabled") !== false,
  };
}
