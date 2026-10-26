import { DataTypes, Op, type Transaction } from "sequelize";
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
 * group 不是有自己列的實體（#137，原 #116）：它只在有訊息觸發引用這個
 * 名字時存在。名單只能設給被引用的 group（groupInUse），最後一個引用它
 * 的觸發改掉對象或被刪除時，名單一併清掉（pruneUnusedGroupMembers），
 * 所以不會留下沒有觸發用的孤兒名單。
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

export interface BehaviorGroupMemberRow {
  groupName: string;
  userId: string;
}

export const findGroupMembers = async (
  groupName: string,
): Promise<string[]> => {
  const rows = await BehaviorGroupMember.findAll({
    where: { groupName },
    order: [["userId", "ASC"]],
  });
  return rows.map((r) => r.getDataValue("userId") as string);
};

export const findGroupMembersBulk = async (
  groupNames: string[],
): Promise<Map<string, string[]>> => {
  const unique = Array.from(new Set(groupNames));
  if (unique.length === 0) return new Map();
  const rows = await BehaviorGroupMember.findAll({
    where: { groupName: { [Op.in]: unique } },
    order: [
      ["groupName", "ASC"],
      ["userId", "ASC"],
    ],
  });
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const g = r.getDataValue("groupName") as string;
    const uid = r.getDataValue("userId") as string;
    let list = map.get(g);
    if (!list) {
      list = [];
      map.set(g, list);
    }
    list.push(uid);
  }
  return map;
};

export const addGroupMember = async (
  groupName: string,
  userId: string,
): Promise<void> => {
  await BehaviorGroupMember.upsert({ groupName, userId });
};

export const removeGroupMember = async (
  groupName: string,
  userId: string,
): Promise<void> => {
  await BehaviorGroupMember.destroy({ where: { groupName, userId } });
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

/** Whether some message trigger's audience is this group. */
export const groupInUse = async (
  groupName: string,
  transaction: Transaction,
): Promise<boolean> =>
  (await BehaviorDefinition.count({
    where: { triggerKind: "message", audienceGroupName: groupName },
    transaction,
  })) > 0;

/** Drop the member lists of every group no message trigger uses any more. */
export const pruneUnusedGroupMembers = async (transaction: Transaction): Promise<void> => {
  const rows = await BehaviorDefinition.findAll({
    attributes: ["audienceGroupName"],
    where: { triggerKind: "message", audienceGroupName: { [Op.ne]: null } },
    transaction,
  });
  const inUse = [...new Set(rows.map((r) => r.getDataValue("audienceGroupName") as string))];
  await BehaviorGroupMember.destroy({
    where: inUse.length > 0 ? { groupName: { [Op.notIn]: inUse } } : {},
    transaction,
  });
};
