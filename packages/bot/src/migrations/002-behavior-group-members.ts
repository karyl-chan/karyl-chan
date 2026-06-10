/**
 * BH-1 — audience group membership moves from the per-behavior
 * `behavior_audience_members` table (keyed by behaviorId; never had a
 * write path, so it is empty everywhere) to the group-name-keyed
 * `behavior_group_members` table shared by every behavior carrying the
 * same audienceGroupName.
 *
 * Fresh installs get the new table from the model via `sequelize.sync()`;
 * existing DBs also get it from sync() (missing tables are created on
 * boot). This migration only drops the orphaned old table — there is no
 * data to move.
 *
 * Idempotent: dropTable with a tableName check; re-running no-ops.
 */

import type { MigrationFn } from "umzug";
import type { QueryInterface } from "sequelize";

const OLD_TABLE = "behavior_audience_members";

export const up: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const tables = (await qi.showAllTables()) as string[];
  if (!tables.includes(OLD_TABLE)) return;
  await qi.dropTable(OLD_TABLE);
};

export const down: MigrationFn<QueryInterface> = async () => {
  // The old table was always empty (no write path existed); nothing to
  // restore. Recreating it on rollback would only resurrect dead schema.
};
