/**
 * BH-4.2 — add `behaviors.sessionExpireHours` (INTEGER, nullable): the
 * per-behavior continuous-session TTL. NULL keeps the global
 * `config.behavior.sessionExpireHours` default, so existing rows
 * behave exactly as before.
 *
 * Fresh installs get the column from the model via sync(). Idempotent.
 */

import type { MigrationFn } from "umzug";
import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

const TABLE = "behaviors";
const COLUMN = "sessionExpireHours";

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
