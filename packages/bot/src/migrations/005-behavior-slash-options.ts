/**
 * BH-2.2C — add `behaviors.slashCommandOptions` (TEXT, nullable): the
 * admin-defined slash command option list (JSON array, flat scalar
 * subset of ManifestCommandOption) registered to Discord by the
 * reconciler and delivered to the webhook via `_meta.options`.
 *
 * Fresh installs get the column from the model via sync(). Idempotent.
 */

import type { MigrationFn } from "umzug";
import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

const TABLE = "behaviors";
const COLUMN = "slashCommandOptions";

export const up: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const table = await qi.describeTable(TABLE);
  if (table[COLUMN]) return;
  await qi.addColumn(TABLE, COLUMN, {
    type: DataTypes.TEXT,
    allowNull: true,
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const table = await qi.describeTable(TABLE);
  if (!table[COLUMN]) return;
  await qi.removeColumn(TABLE, COLUMN);
};
