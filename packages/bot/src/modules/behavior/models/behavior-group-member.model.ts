import { DataTypes, Op } from "sequelize";
import { sequelize } from "../../../db.js";

/**
 * Audience group 成員清單（BH-1）。取代舊 behavior_audience_members 表。
 *
 * 舊表以 behaviorId 為鍵，導致同一個 group tab 上的多條 behavior 各自有
 * 成員清單、必須逐條同步（而且從未有寫入路徑，永遠是空表）。group 的
 * 心智模型是「一個名字、一份名單、掛在上面的 behaviors 共享」——以
 * groupName 為鍵讓 specific_group tab 與 audienceKind='group' 的 behavior
 * 天然共用同一份名單。
 *
 *   - PK：(groupName, userId)
 *   - groupName 對應 behaviors.audienceGroupName / scope tab 的 groupName
 *
 * 舊表由 migration 002 清除（從未有資料，無需搬遷）。
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
): Promise<void> => {
  await sequelize.transaction(async (t) => {
    await BehaviorGroupMember.destroy({
      where: { groupName },
      transaction: t,
    });
    if (userIds.length === 0) return;
    const unique = Array.from(new Set(userIds));
    await BehaviorGroupMember.bulkCreate(
      unique.map((userId) => ({ groupName, userId })),
      { transaction: t },
    );
  });
};
