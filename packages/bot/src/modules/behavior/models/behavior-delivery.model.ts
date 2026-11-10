import { DataTypes } from "sequelize";
import { sequelize } from "../../../db.js";
import { BehaviorDefinition } from "./behavior-definition.model.js";

/**
 * behavior_deliveries (#120): one row per webhook delivery of a behavior —
 * its outcome, for an admin chasing a receiver problem. Written
 * best-effort by runWebhookAction (behavior-deliveries.ts), bounded by its
 * pruner (the last 20 per behavior, at most 7 days).
 *
 * Holds the outcome only. Never a webhook URL, a secret, the payload, the
 * message or the reply, a user id or a message id: status, duration and
 * error are enough to debug a receiver, and every column not stored is one
 * less to protect and clean up.
 *
 * A new table made by `sync()` that no migration reshapes, so its index
 * lives here (architecture.md, "Do not break" #8).
 */

/** How the behavior was triggered. */
export type DeliveryVia = "command" | "message";

export const BehaviorDelivery = sequelize.define(
  "BehaviorDelivery",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    behaviorId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: BehaviorDefinition, key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    /** When the delivery started. */
    firedAt: { type: DataTypes.DATE, allowNull: false },
    via: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: { isIn: [["command", "message"]] },
    },
    ok: { type: DataTypes.BOOLEAN, allowNull: false },
    /** The receiver's HTTP status; null when no response came back. */
    httpStatus: { type: DataTypes.INTEGER, allowNull: true },
    /** Forward plus reply rendering; null when nothing was forwarded. */
    durationMs: { type: DataTypes.INTEGER, allowNull: true },
    errorCode: { type: DataTypes.STRING, allowNull: true },
    /** At most 300 characters, from the same source as behavior_stats.lastError. */
    error: { type: DataTypes.STRING(300), allowNull: true },
    /** Which key verified the response's signature; null: not verified. */
    verified: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: { isIn: [["hmac", "token"]] },
    },
    /**
     * The receiver answered `{"defer": true}` (#113): the run succeeded and
     * its reply comes later, through the callback token. Migration 015.
     */
    deferred: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    tableName: "behavior_deliveries",
    timestamps: false,
    indexes: [{ name: "behavior_deliveries_behavior_id", fields: ["behaviorId", "id"] }],
  },
);
