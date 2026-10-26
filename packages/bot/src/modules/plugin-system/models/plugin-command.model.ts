import { DataTypes, Op } from "sequelize";
import { sequelize } from "../../../db.js";
import type { CommandTarget } from "../../command-system/command-target.js";
import type { ManifestPluginCommand } from "../plugin-registry.service.js";

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
  // 指定伺服器的列優先於 all_guilds（同名同伺服器時 Discord 只會留一個）
  const matching = rows.filter((r) => covers(pluginCommandRowTarget(r)));
  return (
    matching.find((r) => r.guildId !== null) ?? matching[0] ?? null
  );
};

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
