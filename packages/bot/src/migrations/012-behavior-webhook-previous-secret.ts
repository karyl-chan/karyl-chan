/**
 * Webhook secret rotation (#99): behavior_webhook_actions keeps the
 * secret a rotation replaced, and until when it still counts.
 *
 *   previousSecret           encrypted like `secret`; null = no rotation
 *                            in its grace period
 *   previousSecretExpiresAt  end of the grace period (24 h after the
 *                            rotation); set exactly when previousSecret is
 *
 * The table itself is created by `sync()` (migration 011's comment), which
 * on a fresh DB already includes both columns — hence the existence check.
 */

import type { MigrationFn } from "umzug";
import { DataTypes, type QueryInterface } from "sequelize";

const TABLE = "behavior_webhook_actions";

export const up: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const columns = await qi.describeTable(TABLE);
  if (!("previousSecret" in columns)) {
    await qi.addColumn(TABLE, "previousSecret", {
      type: DataTypes.TEXT,
      allowNull: true,
    });
  }
  if (!("previousSecretExpiresAt" in columns)) {
    await qi.addColumn(TABLE, "previousSecretExpiresAt", {
      type: DataTypes.DATE,
      allowNull: true,
    });
  }
};

export const down: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const columns = await qi.describeTable(TABLE);
  if ("previousSecretExpiresAt" in columns) {
    await qi.removeColumn(TABLE, "previousSecretExpiresAt");
  }
  if ("previousSecret" in columns) await qi.removeColumn(TABLE, "previousSecret");
};
