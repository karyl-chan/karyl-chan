import { DataTypes, Op } from "sequelize";
import { sequelize } from "../../../db.js";
import { shouldRecord } from "../../bot-events/bot-event-dedup.js";
import { botEventLog } from "../../bot-events/bot-event-log.js";
import { isSupportedSchemaVersion } from "@karyl-chan/plugin-wire";
import type { CommandTarget } from "../../command-system/command-target.js";
import { parsePluginManifest } from "../plugin-dispatch-util.js";
import type { ManifestPluginCommand } from "../plugin-registry.service.js";
import type { PluginRow } from "./plugin.model.js";

export const PluginCommand = sequelize.define(
  "PluginCommand",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    pluginId: { type: DataTypes.INTEGER, allowNull: false },
    /** NULL for global-scoped commands. */
    guildId: { type: DataTypes.STRING, allowNull: true },
    name: { type: DataTypes.STRING, allowNull: false },
    discordCommandId: { type: DataTypes.STRING, allowNull: true },
    /**
     * NULL = top-level `manifest.commands[]` row (truly global).
     * non-NULL = declared under `manifest.guild_features[<key>].commands[]`,
     * gated by the per-guild feature toggle. Reconcile uses this to
     * decide which rows correspond to which feature when a toggle flips.
     */
    featureKey: { type: DataTypes.STRING, allowNull: true },
    manifestJson: { type: DataTypes.TEXT, allowNull: false },
    /**
     * Admin on/off toggle for this command.
     * true = admin 啟用（預設），false = admin 停用（CommandReconciler 不登記此指令）。
     * DB column: adminEnabled INTEGER NOT NULL DEFAULT 1（added in 20260501020000-plugin-commands-tri-axis.ts）。
     */
    adminEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    tableName: "plugin_commands",
    timestamps: true,
    indexes: [
      {
        name: "plugin_commands_unique",
        unique: true,
        fields: ["pluginId", "guildId", "name"],
      },
      {
        name: "plugin_commands_lookup",
        fields: ["name", "guildId"],
      },
      {
        name: "plugin_commands_by_feature",
        fields: ["pluginId", "featureKey"],
      },
      {
        name: "plugin_commands_admin_enabled_idx",
        fields: ["pluginId", "adminEnabled"],
      },
    ],
  },
);

export interface PluginCommandRow {
  id: number;
  pluginId: number;
  guildId: string | null;
  name: string;
  discordCommandId: string | null;
  featureKey: string | null;
  manifestJson: string;
  /**
   * Admin on/off toggle.
   * false 時 CommandReconciler 不登記此指令到 Discord。
   */
  adminEnabled: boolean;
}

export function rowOfPluginCommand(
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

export const findPluginCommandsByPlugin = async (
  pluginId: number,
): Promise<PluginCommandRow[]> => {
  const rows = await PluginCommand.findAll({ where: { pluginId } });
  return rows.map(rowOfPluginCommand);
};

/** 一個 plugin 的軌三列（featureKey IS NULL；軌一 guild feature 列不在內）。 */
export const findTrackThreeCommandsByPlugin = async (
  pluginId: number,
): Promise<PluginCommandRow[]> => {
  const rows = await PluginCommand.findAll({
    where: { pluginId, featureKey: { [Op.is]: null } },
  });
  return rows.map(rowOfPluginCommand);
};

// ── 註冊目標 ─────────────────────────────────────────────────────────────────
// CommandTarget 是 command-system 的型別；這裡只做 type import，不形成
// plugin-system → command-system 的 runtime 依賴。

/** 軌三 manifest 的 scope → 註冊目標：guild 是「每個伺服器」（reconciler 逐伺服器註冊）。 */
export function pluginCommandScopeTarget(
  scope: string | undefined,
): CommandTarget {
  return scope === "guild" ? "all_guilds" : "global";
}

/** 軌三列的 manifestJson；無法解析或缺名稱時回 null。 */
export function parsePluginCommandManifest(
  manifestJson: string,
): ManifestPluginCommand | null {
  try {
    const parsed = JSON.parse(manifestJson) as ManifestPluginCommand | null;
    return parsed && parsed.name ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 這一列實際註冊在哪：軌一 guild feature 列 → guild:<guildId>；軌三列 →
 * 依 manifest scope（解析失敗保守視為 global）。
 */
export function pluginCommandRowTarget(row: PluginCommandRow): CommandTarget {
  if (row.featureKey !== null && row.guildId) return `guild:${row.guildId}`;
  return pluginCommandScopeTarget(
    parsePluginCommandManifest(row.manifestJson)?.scope,
  );
}

// ── 軌三列的註冊狀態 ─────────────────────────────────────────────────────────

/**
 * 軌三列會不會被 reconciler 註冊到 Discord——這個判斷只有這一份，
 * PluginCommandSource（desired set）與 Command Reach（#129）共用。
 * 唯一不在這裡的是三軸合法性：reconciler 組 Discord payload 時才檢查
 * （deriveRegistrationCall）；register 本來就會擋非法三軸（validateManifest
 * V-05..V-C3），所以這裡是 live、那裡被拒的列只會是驗證上線前留下的舊列。
 */
export type TrackThreeRowState =
  | { status: "live"; command: ManifestPluginCommand; target: CommandTarget }
  /** 軌一 guild feature 列——歸 PluginCommandRegistry 管，不是軌三。 */
  | { status: "feature_row" }
  | { status: "plugin_missing" }
  | { status: "manifest_unparseable" }
  /** OQ-14 守衛：schema_version 不是這個 build 看得懂的值（plugin-wire V-01）。 */
  | { status: "unsupported_schema_version"; schemaVersion: unknown }
  | { status: "unparseable_command" }
  /** plugin 停用／非 active，或 admin 關掉了這個指令。 */
  | {
      status: "disabled";
      command: ManifestPluginCommand;
      target: CommandTarget;
    };

export function trackThreeRowState(
  row: PluginCommandRow,
  plugin: PluginRow | null,
): TrackThreeRowState {
  if (row.featureKey !== null) return { status: "feature_row" };
  if (!plugin) return { status: "plugin_missing" };
  // parsePluginManifest 依 row 實例 memoize，同一個 plugin 的多列只解析一次
  const manifest = parsePluginManifest(plugin);
  if (!manifest) return { status: "manifest_unparseable" };
  if (!isSupportedSchemaVersion(manifest.schema_version)) {
    return {
      status: "unsupported_schema_version",
      schemaVersion: manifest.schema_version,
    };
  }
  const command = parsePluginCommandManifest(row.manifestJson);
  if (!command) return { status: "unparseable_command" };
  const target = pluginCommandScopeTarget(command.scope);
  if (!plugin.enabled || plugin.status !== "active" || !row.adminEnabled) {
    return { status: "disabled", command, target };
  }
  return { status: "live", command, target };
}

/**
 * Reverse lookup used by the interaction dispatcher: the plugin command a
 * Discord invocation belongs to. `commandGuildId` is where the invoked
 * command is registered (null = a global command), not where it was used.
 * Only a row whose registration target covers it may claim the
 * invocation — a global command is claimed only by a global track-3 row;
 * a guild command only by that guild's feature row or a scope=guild
 * track-3 row. (Same rule as command-target.ts targetMatchesInvocation.)
 * Otherwise a same-named row registered elsewhere (e.g. a global plugin
 * /foo vs a behavior's guild /foo) would steal the interaction.
 */
export const findPluginCommandForInvocation = async (
  name: string,
  commandGuildId: string | null,
): Promise<PluginCommandRow | null> => {
  const rows = (await PluginCommand.findAll({ where: { name } })).map(
    rowOfPluginCommand,
  );
  const covers = (target: CommandTarget): boolean =>
    commandGuildId === null
      ? target === "global"
      : target === "all_guilds" || target === `guild:${commandGuildId}`;
  const matching = rows.filter((r) => covers(pluginCommandRowTarget(r)));
  // 指定伺服器的列優先於 all_guilds（同名同伺服器時 Discord 只會留一個）。
  // 註冊時的名稱檢查與 manifest 協定應該讓這種情況不會發生；真的發生（舊
  // 資料）就記下來。每次呼叫都會走到這裡，所以依名稱 + 呼叫位置去重。
  const chosen =
    matching.find((r) => r.guildId !== null) ?? matching[0] ?? null;
  const site = commandGuildId ?? "global";
  if (
    matching.length > 1 &&
    chosen &&
    shouldRecord(`plugin-command-overlap:${name}:${site}`)
  ) {
    // 依列 id 列出，讓同一組衝突每次記下的文字都一樣（查詢結果順序不固定）。
    const candidates = [...matching].sort((a, b) => a.id - b.id);
    botEventLog.record(
      "warn",
      "bot",
      describeOverlap(name, site, candidates, chosen),
      {
        cmd: name,
        commandGuildId,
        candidates: candidates.map((r) => ({
          id: r.id,
          pluginId: r.pluginId,
          kind: rowKind(r),
          featureKey: r.featureKey,
        })),
      },
    );
  }
  return chosen;
};

/** 列的種類：guild feature 指令，或軌三 `plugin_commands[]` 指令。 */
function rowKind(row: PluginCommandRow): "feature" | "plugin_command" {
  return row.featureKey !== null ? "feature" : "plugin_command";
}

/** warn 文字：每個候選列的 plugin、列 id、種類；不預設是兩個 plugin 撞名。 */
function describeOverlap(
  name: string,
  site: string,
  candidates: PluginCommandRow[],
  chosen: PluginCommandRow,
): string {
  const pluginIds = new Set(candidates.map((r) => r.pluginId));
  const origin =
    pluginIds.size === 1
      ? `都是同一個 plugin ${chosen.pluginId} 同時宣告的`
      : `來自 ${pluginIds.size} 個 plugin`;
  const rows = candidates
    .map((r) => {
      const kind =
        rowKind(r) === "feature"
          ? `feature 指令 ${r.featureKey}`
          : `軌三 scope=${parsePluginCommandManifest(r.manifestJson)?.scope ?? "?"}`;
      return `列 ${r.id}（plugin ${r.pluginId}，${kind}）`;
    })
    .join("、");
  return `plugin-commands: /${name}（commandGuildId=${site}）有 ${candidates.length} 列涵蓋同一次呼叫，${origin}：${rows}；選用列 ${chosen.id}`;
}

export interface UpsertPluginCommandInput {
  pluginId: number;
  guildId: string | null;
  name: string;
  discordCommandId: string | null;
  featureKey?: string | null;
  manifestJson: string;
}

export const upsertPluginCommand = async (
  input: UpsertPluginCommandInput,
): Promise<PluginCommandRow> => {
  const existing = await PluginCommand.findOne({
    where: {
      pluginId: input.pluginId,
      guildId: input.guildId ?? null,
      name: input.name,
    },
  });
  if (existing) {
    await existing.update({
      discordCommandId: input.discordCommandId,
      featureKey: input.featureKey ?? null,
      manifestJson: input.manifestJson,
    });
    return rowOfPluginCommand(existing);
  }
  const created = await PluginCommand.create({
    pluginId: input.pluginId,
    guildId: input.guildId,
    name: input.name,
    discordCommandId: input.discordCommandId,
    featureKey: input.featureKey ?? null,
    manifestJson: input.manifestJson,
  });
  return rowOfPluginCommand(created);
};

export const findPluginCommandsByFeature = async (
  pluginId: number,
  featureKey: string,
): Promise<PluginCommandRow[]> => {
  const rows = await PluginCommand.findAll({
    where: { pluginId, featureKey },
  });
  return rows.map(rowOfPluginCommand);
};

export const deletePluginCommandRow = async (rowId: number): Promise<void> => {
  await PluginCommand.destroy({ where: { id: rowId } });
};

export const deletePluginCommandsByPlugin = async (
  pluginId: number,
): Promise<PluginCommandRow[]> => {
  const rows = await findPluginCommandsByPlugin(pluginId);
  await PluginCommand.destroy({ where: { pluginId } });
  return rows;
};

/**
 * DB-only cleanup for a guild the bot left (PM-7.4). Discord removes
 * an app's guild commands itself when the app leaves, so there is no
 * Discord call to make — without this the guard in sync() (rows whose
 * guild isn't in this process's cache are never treated as stale)
 * would keep departed guilds' rows forever.
 */
export const deletePluginCommandsByGuild = async (
  guildId: string,
): Promise<number> => {
  return PluginCommand.destroy({ where: { guildId } });
};
