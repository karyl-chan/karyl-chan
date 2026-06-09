import { DataTypes, Op } from "sequelize";
import { sequelize } from "../../../db.js";

/**
 * Sequelize wrapper for the `plugins` table.
 *
 * `manifestJson` is the raw JSON string of the last accepted manifest;
 * callers that need typed access parse it. We store the raw string
 * (rather than DataTypes.JSON) to keep diffs deterministic across
 * SQLite versions and to make the on-disk representation match what
 * a plugin will POST again on re-register.
 */
export const Plugin = sequelize.define(
  "Plugin",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    pluginKey: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    name: { type: DataTypes.STRING, allowNull: false },
    version: { type: DataTypes.STRING, allowNull: false },
    url: { type: DataTypes.TEXT, allowNull: false },
    manifestJson: { type: DataTypes.TEXT, allowNull: false },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "inactive",
      validate: { isIn: [["active", "inactive"]] },
    },
    tokenHash: { type: DataTypes.STRING, allowNull: true },
    enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    lastHeartbeatAt: { type: DataTypes.DATE, allowNull: true },
    setupSecretHash: { type: DataTypes.TEXT, allowNull: true },
    dispatchHmacKey: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: "plugins",
    timestamps: true,
  },
);

export type PluginStatus = "active" | "inactive";

export interface PluginRow {
  id: number;
  pluginKey: string;
  name: string;
  version: string;
  url: string;
  manifestJson: string;
  status: PluginStatus;
  tokenHash: string | null;
  enabled: boolean;
  lastHeartbeatAt: Date | null;
  /** SHA-256 hash of the per-plugin setup secret. NULL means use global fallback. */
  setupSecretHash: string | null;
  /** Cleartext HMAC key for signing outbound dispatches to this plugin. NULL means use global fallback. */
  dispatchHmacKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function rowOf(model: InstanceType<typeof Plugin>): PluginRow {
  return {
    id: model.getDataValue("id") as number,
    pluginKey: model.getDataValue("pluginKey") as string,
    name: model.getDataValue("name") as string,
    version: model.getDataValue("version") as string,
    url: model.getDataValue("url") as string,
    manifestJson: model.getDataValue("manifestJson") as string,
    status: model.getDataValue("status") as PluginStatus,
    tokenHash: (model.getDataValue("tokenHash") as string | null) ?? null,
    enabled: !!model.getDataValue("enabled"),
    lastHeartbeatAt:
      (model.getDataValue("lastHeartbeatAt") as Date | null) ?? null,
    setupSecretHash:
      (model.getDataValue("setupSecretHash") as string | null) ?? null,
    dispatchHmacKey:
      (model.getDataValue("dispatchHmacKey") as string | null) ?? null,
    createdAt: model.getDataValue("createdAt") as Date,
    updatedAt: model.getDataValue("updatedAt") as Date,
  };
}

export const findPluginById = async (id: number): Promise<PluginRow | null> => {
  const row = await Plugin.findByPk(id);
  return row ? rowOf(row) : null;
};

export const findPluginsByIds = async (
  ids: number[],
): Promise<Map<number, PluginRow>> => {
  if (ids.length === 0) return new Map();
  const rows = await Plugin.findAll({ where: { id: ids } });
  const map = new Map<number, PluginRow>();
  for (const r of rows) {
    const p = rowOf(r);
    map.set(p.id, p);
  }
  return map;
};

export const findPluginByKey = async (
  pluginKey: string,
): Promise<PluginRow | null> => {
  const row = await Plugin.findOne({ where: { pluginKey } });
  return row ? rowOf(row) : null;
};

export const findPluginByTokenHash = async (
  tokenHash: string,
): Promise<PluginRow | null> => {
  const row = await Plugin.findOne({ where: { tokenHash } });
  return row ? rowOf(row) : null;
};

export const findAllPlugins = async (): Promise<PluginRow[]> => {
  const rows = await Plugin.findAll({ order: [["pluginKey", "ASC"]] });
  return rows.map(rowOf);
};

export interface UpsertPluginInput {
  pluginKey: string;
  name: string;
  version: string;
  url: string;
  manifestJson: string;
  tokenHash: string;
  /** Initial value for newly-created rows. Existing rows preserve their setting. */
  defaultEnabled?: boolean;
}

/**
 * Insert or update by `pluginKey`. Always marks the row `active` and
 * stamps `lastHeartbeatAt` because the only caller is the registration
 * endpoint, which is by definition a fresh handshake.
 *
 * The `enabled` flag is only set on first insert; re-registration
 * preserves whatever value the admin has set, so a plugin restart
 * doesn't quietly re-enable a plugin that was paused.
 */
export const upsertPluginRegistration = async (
  input: UpsertPluginInput,
  now: Date = new Date(),
): Promise<PluginRow> => {
  const existing = await Plugin.findOne({
    where: { pluginKey: input.pluginKey },
  });
  if (existing) {
    await existing.update({
      name: input.name,
      version: input.version,
      url: input.url,
      manifestJson: input.manifestJson,
      tokenHash: input.tokenHash,
      status: "active",
      lastHeartbeatAt: now,
    });
    return rowOf(existing);
  }
  const created = await Plugin.create({
    pluginKey: input.pluginKey,
    name: input.name,
    version: input.version,
    url: input.url,
    manifestJson: input.manifestJson,
    tokenHash: input.tokenHash,
    status: "active",
    enabled: input.defaultEnabled ?? true,
    lastHeartbeatAt: now,
  });
  return rowOf(created);
};

/**
 * Write the hashed setup secret for a plugin.
 * Pass the *hash* of the cleartext secret — the cleartext is never stored.
 * Returns the updated row, or null if the plugin does not exist.
 */
export const setPluginSetupSecretHash = async (
  id: number,
  hash: string,
): Promise<PluginRow | null> => {
  const row = await Plugin.findByPk(id);
  if (!row) return null;
  await row.update({ setupSecretHash: hash });
  return rowOf(row);
};

/**
 * Write the cleartext dispatch HMAC key for a plugin.
 * This is stored in cleartext because the bot needs to use it to sign outbound
 * requests; only the server process ever reads this column.
 * Returns the updated row, or null if the plugin does not exist.
 */
export const setPluginDispatchHmacKey = async (
  id: number,
  key: string,
): Promise<PluginRow | null> => {
  const row = await Plugin.findByPk(id);
  if (!row) return null;
  await row.update({ dispatchHmacKey: key });
  return rowOf(row);
};

/**
 * Stamp lastHeartbeatAt + flip status to 'active'. Returns
 * `revived: true` when the row's prior status was something other
 * than 'active' (i.e. the reaper had already marked it inactive and
 * this heartbeat just woke it back up) so the caller can refresh
 * caches that pin the inactive state. Returns null if the row is
 * missing entirely.
 */
export const touchHeartbeat = async (
  id: number,
  now: Date = new Date(),
): Promise<{ revived: boolean; row: PluginRow } | null> => {
  const inst = await Plugin.findByPk(id);
  if (!inst) return null;
  const wasActive = inst.getDataValue("status") === "active";
  await inst.update({ lastHeartbeatAt: now, status: "active" });
  return { revived: !wasActive, row: rowOf(inst) };
};

export const setPluginEnabled = async (
  id: number,
  enabled: boolean,
): Promise<PluginRow | null> => {
  const row = await Plugin.findByPk(id);
  if (!row) return null;
  await row.update({ enabled });
  return rowOf(row);
};

/**
 * Hard-delete a plugin row by id. Returns true if a row was deleted,
 * false if the id was not found.
 *
 * The DB schema sets ON DELETE CASCADE on all related tables
 * (plugin_kv, plugin_configs, plugin_commands, plugin_guild_features,
 * plugin_feature_defaults), so the single destroy call is sufficient
 * to clean up all child rows. The caller is responsible for revoking
 * the in-memory auth token and unregistering Discord commands before
 * calling this.
 */
export const deletePlugin = async (id: number): Promise<boolean> => {
  const row = await Plugin.findByPk(id);
  if (!row) return false;
  await row.destroy();
  return true;
};

/**
 * Flip a single plugin (by key) to `inactive` immediately, regardless
 * of its heartbeat age. Used by the graceful-deregister path so a
 * cleanly-shutting-down plugin is taken offline at once instead of
 * waiting for the reaper's heartbeat-timeout window. Returns true when a
 * row was found and was active (i.e. an actual state change happened),
 * false otherwise.
 */
export const deactivatePluginByKey = async (
  pluginKey: string,
): Promise<boolean> => {
  const row = await Plugin.findOne({ where: { pluginKey } });
  if (!row) return false;
  if (row.getDataValue("status") !== "active") return false;
  await row.update({ status: "inactive" });
  return true;
};

/**
 * Mark every plugin whose last heartbeat is older than `cutoff` as
 * inactive. Returns affected ids so the caller can also revoke their
 * tokens / log the failure.
 */
export const expireStalePlugins = async (
  cutoff: Date,
): Promise<Array<{ id: number; pluginKey: string }>> => {
  const stale = await Plugin.findAll({
    where: {
      status: "active",
      lastHeartbeatAt: { [Op.lt]: cutoff },
    },
    attributes: ["id"],
  });
  const ids = stale.map((m) => m.getDataValue("id") as number);
  if (ids.length === 0) return [];
  // Re-assert the staleness predicate in the UPDATE. A heartbeat that
  // lands between the SELECT above and this write revives the row
  // (touchHeartbeat sets status -> active, lastHeartbeatAt -> now). A
  // blind `id IN (ids)` UPDATE would clobber that revived row back to
  // inactive — and the reaper caller would then revoke its freshly-rolled
  // token and drop it from the event index, forcing a needless re-register.
  await Plugin.update(
    { status: "inactive" },
    {
      where: {
        id: ids,
        status: "active",
        lastHeartbeatAt: { [Op.lt]: cutoff },
      },
    },
  );
  // Return only the rows this sweep actually left inactive, so the caller
  // never evicts a plugin that revived in the race window above. The
  // pluginKey rides along so the reaper can drop the dead plugin's
  // dispatch pool (keyed by pluginKey), not just its id-keyed state.
  const expired = await Plugin.findAll({
    where: { id: ids, status: "inactive" },
    attributes: ["id", "pluginKey"],
  });
  return expired.map((m) => ({
    id: m.getDataValue("id") as number,
    pluginKey: m.getDataValue("pluginKey") as string,
  }));
};
