/**
 * command-system/desired-command-source.ts
 *
 * DesiredCommandSource：reconciler 的 desired set 來源。每種指令來源一個
 * adapter，reconciler 只認得 DesiredCommand（名稱 + 註冊目標 + Discord 資料），
 * 不知道背後是哪張表。
 *
 *   - BehaviorCommandSource：behavior_commands + 葉節點（軌二）。每個指令
 *     容器是一個 desired 指令，啟用中的葉節點組成它的子指令樹。
 *   - PluginCommandSource：plugin_commands 表 featureKey IS NULL 的列（軌三）。
 */

import { Op } from "sequelize";
import {
  loadBehaviorCatalog,
  type CatalogCommand,
} from "../behavior/behavior-catalog.js";
import {
  leafPathOf,
  parseLeafOptions,
} from "../behavior/models/behavior-definition.model.js";
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
  type CommandDefinition,
} from "./command-registration.js";
import { behaviorCommandTarget, type CommandTarget } from "./command-target.js";
import { parseContexts, parseIntegrationTypes } from "../../utils/command-axes.js";
import type { DiscordRegistrationSpec } from "./types.js";
import { RejectionError } from "./types.js";

// ── 型別 ──────────────────────────────────────────────────────────────────────

export type CommandSourceKind = "behavior" | "plugin_command";

/**
 * 一個 desired 指令在來源裡的身分（registerOne 的 key）。behavior 來源的
 * id 是 behavior_commands.id（指令容器），plugin_command 是 plugin_commands.id。
 */
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

/** 葉節點的 options → manifest 形狀；壞 JSON 記 warn 並以無參數註冊。 */
function leafOptions(
  leafId: number,
  raw: string | null,
): ManifestCommandOption[] | undefined {
  const options = parseLeafOptions(raw);
  if (options === null) {
    botEventLog.record(
      "warn",
      "bot",
      `command-reconciler: behavior ${leafId} options JSON 解析失敗，以無參數註冊`,
      { behaviorId: leafId },
    );
    return undefined;
  }
  return options.length > 0 ? options : undefined;
}

function behaviorCommandDefinition(command: CatalogCommand): CommandDefinition {
  return {
    name: command.name,
    description: command.description,
    integrationTypes: parseIntegrationTypes(command.integrationTypes),
    contexts: parseContexts(command.contexts),
    defaultMemberPermissions: command.defaultMemberPermissions,
    // 只有啟用中的葉節點進子指令樹；路徑：根葉節點 []、子指令 [sub]、
    // 預留的群組 [group, sub]（組樹時拒絕）
    leaves: command.leaves
      .filter((leaf) => leaf.enabled)
      .map((leaf) => {
        const { subcommandGroup, subcommand } = leafPathOf(leaf);
        return {
          path: [subcommandGroup, subcommand].filter((p) => p !== ""),
          description: leaf.leafDescription || leaf.title,
          options: leafOptions(leaf.id, leaf.options),
        };
      }),
  };
}

/** 單一指令容器（含葉節點）→ DesiredLookup（純函式，不查 DB）。 */
export function lookupBehaviorCommand(command: CatalogCommand): DesiredLookup {
  const target = behaviorCommandTarget(command);
  if (!command.leaves.some((leaf) => leaf.enabled)) {
    return {
      status: "not_desired",
      reason: "沒有啟用中的葉節點",
      name: command.name,
      target,
    };
  }
  try {
    const spec = deriveRegistrationCall(
      behaviorCommandDefinition(command),
      target,
    );
    return {
      status: "desired",
      command: {
        key: { source: "behavior", id: command.id },
        name: command.name,
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
  readonly notFoundMessage = "behavior command not found";
  readonly deleteWhenNotDesired = true;

  async listDesired(): Promise<DesiredCommand[]> {
    const { commands } = await loadBehaviorCatalog();
    const out: DesiredCommand[] = [];
    for (const command of commands) {
      const res = lookupBehaviorCommand(command);
      if (res.status === "desired") out.push(res.command);
      else if (res.status === "invalid") {
        botEventLog.record(
          "warn",
          "bot",
          `command-reconciler: behavior 指令 ${command.id} (/${command.name}) 設定非法，跳過：${res.reason}`,
          { behaviorCommandId: command.id },
        );
      }
    }
    return out;
  }

  async lookup(id: number): Promise<DesiredLookup> {
    const { commands } = await loadBehaviorCatalog();
    const command = commands.find((c) => c.id === id);
    return command ? lookupBehaviorCommand(command) : { status: "not_found" };
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
