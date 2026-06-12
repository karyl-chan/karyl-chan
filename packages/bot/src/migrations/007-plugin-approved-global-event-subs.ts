/**
 * Add `plugins.approvedGlobalEventSubs` — the admin-approved GLOBAL event
 * subscription set (PM-8 event-reach enforcement). Mirrors
 * `approvedRpcScopes` (001) exactly: JSON-array TEXT, NULL reads as the
 * empty set.
 *
 * No data backfill: with PLUGIN_AUTO_APPROVE=true (the default) the event
 * index treats every declared global subscription as approved at build
 * time, so pre-PM-8 rows keep receiving their global events without a
 * re-register. The column only carries decisions once an operator runs
 * with auto-approve off.
 *
 * Idempotent: checks the live column list and no-ops if already present
 * (fresh installs get the column from the model via `sequelize.sync()`).
 */

import type { MigrationFn } from "umzug";
import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

const TABLE = "plugins";
const COLUMN = "approvedGlobalEventSubs";

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
