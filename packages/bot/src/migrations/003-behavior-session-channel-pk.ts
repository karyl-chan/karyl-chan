/**
 * BH-4.3 — behavior_sessions PK widens from (userId) to
 * (userId, channelId): DM sessions behave exactly as before (a user's
 * DMs with the bot are one channel), while guild-channel patterns (BH-3)
 * give the same user independent sessions per channel.
 *
 * SQLite can't alter a primary key in place, so this is a table rebuild:
 * create the new shape, copy rows (channelId already existed as a plain
 * column), swap. Fresh installs get the new shape from sync().
 *
 * Idempotent: describeTable shows channelId.primaryKey=true once
 * migrated; re-running no-ops.
 */

import type { MigrationFn } from "umzug";
import type { QueryInterface } from "sequelize";
import { DataTypes, Op } from "sequelize";

const TABLE = "behavior_sessions";
const TMP = "behavior_sessions_bh43_new";

export const up: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const tables = (await qi.showAllTables()) as string[];
  if (!tables.includes(TABLE)) return; // fresh install — sync() builds it

  const desc = await qi.describeTable(TABLE);
  if (desc["channelId"]?.primaryKey) return; // already migrated

  await qi.createTable(TMP, {
    userId: { type: DataTypes.STRING, primaryKey: true },
    channelId: { type: DataTypes.STRING, primaryKey: true },
    behaviorId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "behaviors", key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    startedAt: { type: DataTypes.STRING, allowNull: false },
    expiresAt: { type: DataTypes.STRING, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.sequelize.query(
    `INSERT INTO ${TMP} (userId, channelId, behaviorId, startedAt, expiresAt, createdAt, updatedAt)
     SELECT userId, channelId, behaviorId, startedAt, expiresAt, createdAt, updatedAt FROM ${TABLE}`,
  );
  await qi.dropTable(TABLE);
  await qi.renameTable(TMP, TABLE);
  await qi.addIndex(TABLE, {
    name: "behavior_sessions_behavior_idx",
    fields: ["behaviorId"],
  });
  await qi.addIndex(TABLE, {
    name: "behavior_sessions_expires_at_idx",
    fields: ["expiresAt"],
    where: { expiresAt: { [Op.ne]: null } },
  });
};

export const down: MigrationFn<QueryInterface> = async () => {
  // Sessions are transient (hours-scale TTL); narrowing the PK back would
  // have to drop per-channel rows arbitrarily. Roll forward instead.
};
