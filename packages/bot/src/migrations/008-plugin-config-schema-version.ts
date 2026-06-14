/**
 * Add `plugin_configs.configSchemaVersion` — the manifest
 * `config_schema_version` a plugin's admin config was last SAVED under
 * (PD-4.3). A plugin can bump config_schema_version when it changes the
 * meaning of its config fields; without recording the version each saved
 * config set was written against, the admin UI can't tell that stored
 * values predate the current schema and may need re-review. NULL = saved
 * before this column existed, or never saved (no staleness signal).
 *
 * Idempotent: checks the live column list and no-ops if already present
 * (fresh installs get the column from the model via `sequelize.sync()`).
 */

import type { MigrationFn } from "umzug";
import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

const TABLE = "plugin_configs";
const COLUMN = "configSchemaVersion";

export const up: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const table = await qi.describeTable(TABLE);
  if (table[COLUMN]) return;
  await qi.addColumn(TABLE, COLUMN, {
    type: DataTypes.INTEGER,
    allowNull: true,
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const table = await qi.describeTable(TABLE);
  if (!table[COLUMN]) return;
  await qi.removeColumn(TABLE, COLUMN);
};
