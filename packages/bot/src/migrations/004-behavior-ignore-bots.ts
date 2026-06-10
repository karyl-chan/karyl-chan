/**
 * BH-3 — add `behaviors.ignoreBots` (default true): whether a
 * guild-channel message_pattern behavior skips messages authored by
 * bots/webhooks. Defaulting to true keeps the safe behaviour for every
 * pre-existing row; the matcher unconditionally drops the bot's own
 * messages regardless of this flag.
 *
 * Fresh installs get the column from the model via sync(); existing DBs
 * get it here. Idempotent.
 */

import type { MigrationFn } from "umzug";
import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

const TABLE = "behaviors";
const COLUMN = "ignoreBots";

export const up: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const table = await qi.describeTable(TABLE);
  if (table[COLUMN]) return;
  await qi.addColumn(TABLE, COLUMN, {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const table = await qi.describeTable(TABLE);
  if (!table[COLUMN]) return;
  await qi.removeColumn(TABLE, COLUMN);
};
