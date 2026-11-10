/**
 * Service Behaviors (#126): behavior_definitions gains the service a
 * Service Behavior belongs to.
 *
 *   serviceId  INTEGER, null on every row that is not a Service Behavior
 *              (actionSource 'service' ⇔ non-null — the model validates
 *              it; actionSource is a STRING + isIn, so the new value needs
 *              no schema change)
 *
 * plus a unique index on it (non-null rows only): a service owns exactly
 * one behavior. The index lives here, not on the model, for the reason
 * migration 011 gives: sync() would try to create it on a long-lived
 * table before this column exists.
 *
 * The services table itself is new and comes from sync(). On a fresh DB
 * sync() already created the column — hence the existence checks, which
 * also make a re-run a no-op.
 */

import type { MigrationFn } from "umzug";
import { DataTypes, Op, type QueryInterface } from "sequelize";

const TABLE = "behavior_definitions";
const COLUMN = "serviceId";
const INDEX = "behavior_definitions_service_uq";

export const up: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const columns = await qi.describeTable(TABLE);
  if (!(COLUMN in columns)) {
    await qi.addColumn(TABLE, COLUMN, {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    });
  }
  const indexes = (await qi.showIndex(TABLE)) as Array<{ name: string }>;
  if (!indexes.some((i) => i.name === INDEX)) {
    await qi.addIndex(TABLE, {
      name: INDEX,
      fields: [COLUMN],
      unique: true,
      where: { [COLUMN]: { [Op.ne]: null } },
    });
  }
};

export const down: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const indexes = (await qi.showIndex(TABLE)) as Array<{ name: string }>;
  if (indexes.some((i) => i.name === INDEX)) await qi.removeIndex(TABLE, INDEX);
  const columns = await qi.describeTable(TABLE);
  if (COLUMN in columns) await qi.removeColumn(TABLE, COLUMN);
};
