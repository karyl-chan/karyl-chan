/**
 * Move `configSchemaVersion` from `plugin_configs` (one copy per admin
 * config row) to `plugins` (one row per plugin).
 *
 * Migration 008 (PD-4.3) recorded the manifest config_schema_version a
 * plugin's admin config was saved under on EVERY admin config row — a
 * per-plugin scalar denormalized across N rows, read back via Math.max.
 * This relocates it to a single `plugins.configSchemaVersion` column and
 * drops the `plugin_configs` column.
 *
 * Pre-existing values are NOT copied: the version is a re-stampable
 * staleness hint (the next admin save re-records it), so the only effect
 * of skipping the data copy is that a config that was stale *before* this
 * deploy won't warn until it's next saved. Both steps are idempotent
 * (guarded by describeTable) so fresh installs — where sync() already
 * created plugins.configSchemaVersion from the model and plugin_configs
 * without it — are no-ops.
 */

import type { MigrationFn } from "umzug";
import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

export const up: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const plugins = await qi.describeTable("plugins");
  if (!plugins["configSchemaVersion"]) {
    await qi.addColumn("plugins", "configSchemaVersion", {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
  }
  const configs = await qi.describeTable("plugin_configs");
  if (configs["configSchemaVersion"]) {
    await qi.removeColumn("plugin_configs", "configSchemaVersion");
  }
};

export const down: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const configs = await qi.describeTable("plugin_configs");
  if (!configs["configSchemaVersion"]) {
    await qi.addColumn("plugin_configs", "configSchemaVersion", {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
  }
  const plugins = await qi.describeTable("plugins");
  if (plugins["configSchemaVersion"]) {
    await qi.removeColumn("plugins", "configSchemaVersion");
  }
};
