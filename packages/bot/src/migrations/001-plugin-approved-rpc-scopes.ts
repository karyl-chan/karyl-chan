/**
 * Add `plugins.approvedRpcScopes` — the admin-approved RPC scope set the
 * issued plugin token is signed with (PM-3.1, scope-approval model).
 *
 * Fresh installs get the column from the model via `sequelize.sync()`;
 * this migration is then recorded as applied with nothing to do. Existing
 * DBs predate the column, so we add it here. NULL is the on-disk value for
 * rows registered before this change; the model reads NULL as the empty
 * set, and the plugin's next re-register repopulates it (auto-approve on)
 * or leaves it pending (auto-approve off).
 *
 * Idempotent: re-running after a partial failure checks the live column
 * list first and no-ops if the column already exists.
 */

import type { MigrationFn } from "umzug";
import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

const TABLE = "plugins";
const COLUMN = "approvedRpcScopes";

export const up: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const table = await qi.describeTable(TABLE);
  if (table[COLUMN]) return; // already present (fresh install via sync())
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
