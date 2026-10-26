/**
 * Reply visibility default (#140): behavior_definitions keeps who a
 * behavior's reply is for when the webhook's response does not say
 * (`ephemeral`).
 *
 *   replyVisibility  'private' | 'public' | null
 *                    null = the trigger's own default (a command answers
 *                    only the invoker, a guild message trigger answers in
 *                    the channel); a DM with the bot ignores it
 *
 * The table is created by `sync()` (migration 011's comment), which on a
 * fresh DB already includes the column — hence the existence check, which
 * also makes a re-run a no-op.
 */

import type { MigrationFn } from "umzug";
import { DataTypes, type QueryInterface } from "sequelize";

const TABLE = "behavior_definitions";
const COLUMN = "replyVisibility";

export const up: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const columns = await qi.describeTable(TABLE);
  if (COLUMN in columns) return;
  await qi.addColumn(TABLE, COLUMN, {
    type: DataTypes.STRING,
    allowNull: true,
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const columns = await qi.describeTable(TABLE);
  if (COLUMN in columns) await qi.removeColumn(TABLE, COLUMN);
};
