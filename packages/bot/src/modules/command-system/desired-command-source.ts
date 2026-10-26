/**
 * command-system/desired-command-source.ts
 *
 * DesiredCommandSource：reconciler 的 desired set 來源。每種指令來源一個
 * adapter，reconciler 只認得 DesiredCommand（名稱 + 註冊目標 + Discord 資料），
 * 不知道背後是哪張表。
 *
 *   - BehaviorCommandSource：behaviors 表（軌二）。目前每條指令觸發的
 *     behavior 是一個只有根葉節點的指令；S3 改讀指令容器 + 葉節點表。
 *   - PluginCommandSource：plugin_commands 表 featureKey IS NULL 的列（軌三）。
 */

import { Op } from "sequelize";
import {
  Behavior,
  rowOfBehavior,
  type BehaviorRow,
} from "../behavior/models/behavior.model.js";
import {
  PluginCommand,
  parsePluginCommandManifest,
  pluginCommandScopeTarget,
  rowOfPluginCommand,
  type PluginCommandRow,
} from "../plugin-system/models/plugin-command.model.js";
import { findPluginById } from "../plugin-system/models/plugin.model.js";
import { parsePluginManifest } from "../plugin-system/plugin-dispatch-util.js";
import type {
  ManifestCommandOption,
  ManifestPluginCommand,
} from "../plugin-system/plugin-registry.service.js";
import { resolveDefaultMemberPermissions } from "../plugin-system/plugin-command-registry.service.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import {
  deriveRegistrationCall,
  parseContexts,
  parseIntegrationTypes,
  type CommandDefinition,
} from "./command-registration.js";
import { behaviorTarget, type CommandTarget } from "./command-target.js";
import type { DiscordRegistrationSpec } from "./types.js";
import { RejectionError } from "./types.js";

// ── 型別 ──────────────────────────────────────────────────────────────────────

export type CommandSourceKind = "behavior" | "plugin_command";

/** 一個 desired 指令在來源裡的身分（registerOne 的 key）。 */
export interface CommandKey {
  source: CommandSourceKind;
  id: number;
}

export interface DesiredCommand {
  key: CommandKey;
  name: string;
  spec: DiscordRegistrationSpec;
}

/**
 * 依 key 查單一來源列的結果。
 *   - desired：應該註冊在 Discord 上
 *   - not_desired：列存在但不該註冊（停用、不是指令觸發、plugin 未啟用…）；
 *     能推得出名稱與目標時一併帶上，讓呼叫端可以刪掉舊註冊
 *   - invalid：設定違反 Discord 規則（三軸非法等），無法註冊
 *   - unmanaged：列存在但不歸 reconciler 管（訊息觸發的 behavior、
 *     軌一 guild feature 指令）
 *   - not_found：沒有這列
 */
export type DesiredLookup =
  | { status: "desired"; command: DesiredCommand }
  | {
      status: "not_desired";
      reason: string;
      name?: string;
      target?: CommandTarget;
    }
  | { status: "invalid"; reason: string }
  | { status: "unmanaged" }
  | { status: "not_found" };

export interface DesiredCommandSource {
  readonly kind: CommandSourceKind;
  /** lookup 找不到來源列時，增量 reconcile 回報的訊息。 */
  readonly notFoundMessage: string;
  /**
   * 列存在但不該註冊（not_desired，例如停用）時，增量 reconcile 是否立刻
   * 刪掉 Discord 上的舊註冊；否則只回報，交給 reconcileAll 的 stale 清除。
   */
  readonly deleteWhenNotDesired: boolean;
  /** 這個來源目前要註冊的所有指令（invalid 的列記 log 後略過）。 */
  listDesired(): Promise<DesiredCommand[]>;
  lookup(id: number): Promise<DesiredLookup>;
}

// ── Behavior adapter ─────────────────────────────────────────────────────────

function behaviorDefinition(row: BehaviorRow): CommandDefinition {
  // BH-2.2C：admin 定義的 options（JSON 欄位）→ 註冊 payload。
  // 形狀已在路由層用 parseSlashCommandOptions 驗證過；這裡只防禦
  // 解析失敗（手改 DB 等），壞 JSON 記 warn 並以無參數註冊。
  let options: ManifestCommandOption[] | undefined;
  if (row.slashCommandOptions) {
    try {
      const parsed = JSON.parse(
        row.slashCommandOptions,
      ) as ManifestCommandOption[];
      if (Array.isArray(parsed) && parsed.length > 0) options = parsed;
    } catch {
      botEventLog.record(
        "warn",
        "bot",
        `command-reconciler: behavior ${row.id} slashCommandOptions JSON 解析失敗，以無參數註冊`,
        { behaviorId: row.id },
      );
    }
  }
  const description = row.slashCommandDescription ?? row.title;
  return {
    name: row.slashCommandName ?? "",
    description,
    integrationTypes: parseIntegrationTypes(row.integrationTypes),
    contexts: parseContexts(row.contexts),
    // 今天每條 behavior 是只有根葉節點的指令；S3 改由葉節點表組樹
    leaves: [{ path: [], description, options }],
  };
}

/** 單一 behavior 列 → DesiredLookup（純函式，不查 DB）。 */
export function lookupBehaviorRow(row: BehaviorRow): DesiredLookup {
  // message_pattern 不在 Discord 指令登記範疇
  if (row.triggerType !== "slash_command" || !row.slashCommandName) {
    return { status: "unmanaged" };
  }
  const target = behaviorTarget(row);
  if (!row.enabled) {
    return {
      status: "not_desired",
      reason: "behavior 已停用",
      name: row.slashCommandName,
      target,
    };
  }
  try {
    const spec = deriveRegistrationCall(behaviorDefinition(row), target);
    return {
      status: "desired",
      command: {
        key: { source: "behavior", id: row.id },
        name: row.slashCommandName,
        spec,
      },
    };
  } catch (err) {
    if (err instanceof RejectionError) {
      return { status: "invalid", reason: err.reason };
    }
    throw err;
  }
}

export class BehaviorCommandSource implements DesiredCommandSource {
  readonly kind = "behavior" as const;
  readonly notFoundMessage = "behavior not found";
  readonly deleteWhenNotDesired = true;

  async listDesired(): Promise<DesiredCommand[]> {
    const rows = await Behavior.findAll({
      where: { enabled: true, triggerType: "slash_command" },
    });
    const out: DesiredCommand[] = [];
    for (const model of rows) {
      const row = rowOfBehavior(model);
      const res = lookupBehaviorRow(row);
      if (res.status === "desired") out.push(res.command);
      else if (res.status === "invalid") {
        botEventLog.record(
          "warn",
          "bot",
          `command-reconciler: behavior ${row.id} 三軸非法，跳過：${res.reason}`,
          { behaviorId: row.id },
        );
      }
    }
    return out;
  }

  async lookup(id: number): Promise<DesiredLookup> {
    const model = await Behavior.findByPk(id);
    if (!model) return { status: "not_found" };
    return lookupBehaviorRow(rowOfBehavior(model));
  }
}

// ── Plugin command（軌三）adapter ────────────────────────────────────────────

function pluginCommandDefinition(
  cmd: ManifestPluginCommand,
): CommandDefinition {
  // Accept either snake_case (SDK 0.8+ canonical) or camelCase
  // (plugins built against older SDKs that emit camelCase via
  // module augmentation) so neither shape is silently dropped.
  const cm = cmd as ManifestPluginCommand & {
    descriptionLocalizations?: Record<string, string>;
    nameLocalizations?: Record<string, string>;
  };
  const descLoc = cm.description_localizations ?? cm.descriptionLocalizations;
  const nameLoc = cm.name_localizations ?? cm.nameLocalizations;
  return {
    name: cmd.name,
    description: cmd.description,
    integrationTypes: parseIntegrationTypes(cmd.integration_types ?? []),
    contexts: parseContexts(cmd.contexts ?? []),
    options: cmd.options,
    defaultMemberPermissions: resolveDefaultMemberPermissions(
      cmd.default_member_permissions,
      cmd.name,
    ),
    localizations: {
      ...(descLoc ? { description_localizations: descLoc } : {}),
      ...(nameLoc ? { name_localizations: nameLoc } : {}),
    },
  };
}

export class PluginCommandSource implements DesiredCommandSource {
  readonly kind = "plugin_command" as const;
  readonly notFoundMessage = "plugin_command row not found";
  readonly deleteWhenNotDesired = false;

  async listDesired(): Promise<DesiredCommand[]> {
    const rows = await PluginCommand.findAll({
      where: { featureKey: { [Op.is]: null } },
    });
    const out: DesiredCommand[] = [];
    for (const model of rows) {
      const res = await this.lookupRow(rowOfPluginCommand(model));
      if (res.status === "desired") out.push(res.command);
    }
    return out;
  }

  async lookup(id: number): Promise<DesiredLookup> {
    const model = await PluginCommand.findByPk(id);
    if (!model) return { status: "not_found" };
    return this.lookupRow(rowOfPluginCommand(model));
  }

  private async lookupRow(row: PluginCommandRow): Promise<DesiredLookup> {
    // 軌一指令（guild feature）由 PluginCommandRegistry 管，不由 reconciler 管
    if (row.featureKey !== null) return { status: "unmanaged" };
    // OQ-14 守衛：plugin 的 manifest schema_version 必須是 "1"
    const plugin = await findPluginById(row.pluginId);
    if (!plugin) return { status: "not_desired", reason: "plugin 不存在" };
    const manifest = parsePluginManifest(plugin);
    if (!manifest || manifest.schema_version !== "1") {
      return { status: "not_desired", reason: 'schema_version 非 "1"' };
    }
    const cmd = parsePluginCommandManifest(row.manifestJson);
    if (!cmd) return { status: "invalid", reason: "manifestJson 無法解析" };
    const target = pluginCommandScopeTarget(cmd.scope);
    // 確認 plugin + command 都在 enabled 狀態；adminEnabled：admin 可停用個別指令
    if (!plugin.enabled || plugin.status !== "active" || !row.adminEnabled) {
      return {
        status: "not_desired",
        reason: "plugin 或指令未啟用",
        name: cmd.name,
        target,
      };
    }
    try {
      const spec = deriveRegistrationCall(pluginCommandDefinition(cmd), target);
      return {
        status: "desired",
        command: {
          key: { source: "plugin_command", id: row.id },
          name: cmd.name,
          spec,
        },
      };
    } catch (err) {
      if (err instanceof RejectionError) {
        botEventLog.record(
          "warn",
          "bot",
          `command-reconciler: plugin_command ${row.id} (${row.name}) 三軸非法，跳過：${err.reason}`,
          { pluginId: row.pluginId, cmdName: row.name },
        );
        return { status: "invalid", reason: err.reason };
      }
      throw err;
    }
  }
}
