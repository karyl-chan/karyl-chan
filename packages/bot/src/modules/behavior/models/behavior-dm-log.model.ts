import { DataTypes } from "sequelize";
import { sequelize } from "../../../db.js";

/**
 * behavior_dm_log (#157): one row per direct message a behavior's reply
 * asked for (`direct_messages`) — who it was for, who triggered the
 * behavior, and what came of it. Unlike behavior_deliveries it holds user
 * ids, because the question it answers is "who did this behavior DM". It
 * holds no content. Written best-effort by behavior-direct-messages.ts,
 * kept 30 days (behavior-dm-log.ts).
 *
 * A new table made by `sync()` that no migration reshapes, so its index
 * lives here (architecture.md, "Do not break" #8).
 */

/**
 * What came of one direct message:
 *
 *   sent               Discord took it
 *   not_allowed        the recipient is not on the behavior's DM allowlist,
 *                      or (without one) not a member of the guild(s) the
 *                      rule allows
 *   rate_limited       past the behavior's DMs per minute
 *   attachment_failed  its attachments could not be downloaded
 *   failed             Discord refused it (DMs closed, unknown user …)
 */
export type DmOutcome = "sent" | "not_allowed" | "rate_limited" | "attachment_failed" | "failed";
export const DM_OUTCOMES: readonly DmOutcome[] = [
  "sent",
  "not_allowed",
  "rate_limited",
  "attachment_failed",
  "failed",
];

export const BehaviorDmLog = sequelize.define(
  "BehaviorDmLog",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    /**
     * No foreign key: a command leaf removed by a write Discord refuses
     * comes back with its id (command-snapshot.ts), and its DM log must
     * still be there. A deleted message trigger's rows are deleted with it
     * (destroyDmLog); a deleted command leaf's age out with the 30 days.
     */
    behaviorId: { type: DataTypes.INTEGER, allowNull: false },
    recipientUserId: { type: DataTypes.STRING, allowNull: false },
    triggererUserId: { type: DataTypes.STRING, allowNull: false },
    outcome: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: { isIn: [DM_OUTCOMES as DmOutcome[]] },
    },
    at: { type: DataTypes.DATE, allowNull: false },
  },
  {
    tableName: "behavior_dm_log",
    timestamps: false,
    indexes: [
      { name: "behavior_dm_log_behavior_id", fields: ["behaviorId", "id"] },
      { name: "behavior_dm_log_at", fields: ["at"] },
    ],
  },
);
