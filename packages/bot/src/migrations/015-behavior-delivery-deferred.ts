/**
 * Deferred deliveries (#113): behavior_deliveries marks a delivery whose
 * receiver answered `{"defer": true}` — ok now, the reply comes later
 * through the behavior callback token.
 *
 *   deferred  BOOLEAN NOT NULL DEFAULT false; false on every existing row
 *
 * The table is created by `sync()` (behavior-delivery.model.ts), which on
 * a fresh DB already includes the column — hence the existence check,
 * which also makes a re-run a no-op. No table at all (sync() has not
 * created it): nothing to change, sync() makes it with the column.
 */

import type { MigrationFn } from "umzug";
import { DataTypes, type QueryInterface } from "sequelize";

const TABLE = "behavior_deliveries";
const COLUMN = "deferred";

async function tableExists(qi: QueryInterface): Promise<boolean> {
  const tables = (await qi.showAllTables()) as Array<string | { tableName: string }>;
  return tables.some((t) => (typeof t === "string" ? t : t.tableName) === TABLE);
}

export const up: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  if (!(await tableExists(qi))) return;
  const columns = await qi.describeTable(TABLE);
  if (COLUMN in columns) return;
  await qi.addColumn(TABLE, COLUMN, {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  if (!(await tableExists(qi))) return;
  const columns = await qi.describeTable(TABLE);
  if (COLUMN in columns) await qi.removeColumn(TABLE, COLUMN);
};
