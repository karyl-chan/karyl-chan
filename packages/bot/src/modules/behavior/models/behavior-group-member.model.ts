import { DataTypes, type Transaction } from "sequelize";
import { sequelize } from "../../../db.js";
import { BehaviorDefinition } from "./behavior-definition.model.js";

/**
 * Audience group 成員清單（BH-1）。取代舊 behavior_audience_members 表。
 *
 * 舊表以 behaviorId 為鍵，導致同一個 group tab 上的多條 behavior 各自有
 * 成員清單、必須逐條同步（而且從未有寫入路徑，永遠是空表）。group 的
 * 心智模型是「一個名字、一份名單、掛在上面的 behaviors 共享」——以
 * groupName 為鍵讓 audienceKind='group' 的訊息觸發天然共用同一份名單。
 *
 *   - PK：(groupName, userId)
 *   - groupName 對應 behavior_definitions.audienceGroupName
 *
 * 舊表由 migration 002 清除（從未有資料，無需搬遷）。
 *
 * group 是一個 Behavior Target（ADR 0004，取代 #137 的「只在被引用時存在」）：
 * 它在 behavior_targets 有自己的列（`group:<name>`），名單跟著那一列 ——
 * 有列才能設成員（groupTargetExists），列被刪除時名單一起刪
 * （behavior-target-routes.ts）。沒有觸發引用的群組照樣保留名單。
 *
 * behavior 的私訊白名單（#157，behavior_dm_allowlists）也用群組名稱引用
 * 同一份名單。
 */
export const BehaviorGroupMember = sequelize.define(
  "BehaviorGroupMember",
  {
    groupName: {
      type: DataTypes.TEXT,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.TEXT,
      primaryKey: true,
    },
  },
  {
    tableName: "behavior_group_members",
    timestamps: true,
    indexes: [
      {
        name: "behavior_group_members_user_idx",
        fields: ["userId"],
      },
    ],
  },
);

export const findGroupMembers = async (
  groupName: string,
): Promise<string[]> => {
  const rows = await BehaviorGroupMember.findAll({
    where: { groupName },
    order: [["userId", "ASC"]],
  });
  return rows.map((r) => r.getDataValue("userId") as string);
};

export const replaceGroupMembers = async (
  groupName: string,
  userIds: string[],
  transaction: Transaction,
): Promise<void> => {
  await BehaviorGroupMember.destroy({ where: { groupName }, transaction });
  if (userIds.length === 0) return;
  const unique = Array.from(new Set(userIds));
  await BehaviorGroupMember.bulkCreate(
    unique.map((userId) => ({ groupName, userId })),
    { transaction },
  );
};

/**
 * Whether a Service Behavior's trigger uses this group (#126): its members
 * are then who may log in to that service, which only an owner decides.
 */
export const groupUsedByService = async (
  groupName: string,
  transaction: Transaction,
): Promise<boolean> =>
  (await BehaviorDefinition.count({
    where: { triggerKind: "message", actionSource: "service", audienceGroupName: groupName },
    transaction,
  })) > 0;

/** Remove a group's whole member list — its group target is being deleted. */
export const destroyGroupMembers = async (
  groupName: string,
  transaction: Transaction,
): Promise<void> => {
  await BehaviorGroupMember.destroy({ where: { groupName }, transaction });
};
