import { DataTypes, type Transaction } from "sequelize";
import { sequelize } from "../../../db.js";
import { BehaviorDefinition } from "./behavior-definition.model.js";

/**
 * behavior_dm_allowlists (#157): who a behavior's reply may DM besides the
 * person who triggered it (`direct_messages`). One row per behavior that
 * has a list: user ids and behavior group names (a group's members are
 * behavior_group_members, shared by name). No row = no list: then a guild
 * trigger may DM members of its guild, a DM trigger members of any guild
 * the bot is in (behavior-direct-messages.ts).
 *
 * A group named here is in use (groupInUse / pruneUnusedGroupMembers), so
 * its member list survives without a message trigger using it.
 *
 * Removed with its behavior — explicitly (SQLite may run without FK
 * enforcement), and the command snapshot carries it so a refused command
 * write puts it back. A new table made by `sync()`; nothing to index past
 * the primary key.
 */
export const BehaviorDmAllowlist = sequelize.define(
  "BehaviorDmAllowlist",
  {
    behaviorId: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: { model: BehaviorDefinition, key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    /** JSON string[] of user ids. */
    userIds: { type: DataTypes.TEXT, allowNull: false, defaultValue: "[]" },
    /** JSON string[] of behavior group names. */
    groupNames: { type: DataTypes.TEXT, allowNull: false, defaultValue: "[]" },
  },
  { tableName: "behavior_dm_allowlists", timestamps: true },
);

export interface DmAllowlist {
  userIds: string[];
  groupNames: string[];
}

const parseList = (raw: unknown): string[] => {
  try {
    const value = JSON.parse(String(raw)) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

const listOf = (model: InstanceType<typeof BehaviorDmAllowlist>): DmAllowlist => ({
  userIds: parseList(model.getDataValue("userIds")),
  groupNames: parseList(model.getDataValue("groupNames")),
});

/** The behavior's list, or null when it has none. */
export async function findDmAllowlist(
  behaviorId: number,
  transaction?: Transaction,
): Promise<DmAllowlist | null> {
  const row = await BehaviorDmAllowlist.findByPk(behaviorId, { transaction });
  return row ? listOf(row) : null;
}

/** Replace the behavior's list; an empty one (no users, no groups) removes it. */
export async function replaceDmAllowlist(
  behaviorId: number,
  list: DmAllowlist,
  transaction: Transaction,
): Promise<DmAllowlist | null> {
  const userIds = [...new Set(list.userIds)];
  const groupNames = [...new Set(list.groupNames)];
  if (userIds.length === 0 && groupNames.length === 0) {
    await BehaviorDmAllowlist.destroy({ where: { behaviorId }, transaction });
    return null;
  }
  await BehaviorDmAllowlist.upsert(
    { behaviorId, userIds: JSON.stringify(userIds), groupNames: JSON.stringify(groupNames) },
    { transaction },
  );
  return { userIds, groupNames };
}

/** Remove the lists of deleted behaviors. */
export async function destroyDmAllowlists(
  behaviorIds: number | number[],
  transaction: Transaction,
): Promise<void> {
  await BehaviorDmAllowlist.destroy({ where: { behaviorId: behaviorIds }, transaction });
}

/** Every group name some behavior's list refers to. */
export async function groupsInDmAllowlists(transaction?: Transaction): Promise<Set<string>> {
  const rows = await BehaviorDmAllowlist.findAll({ attributes: ["groupNames"], transaction });
  return new Set(rows.flatMap((r) => parseList(r.getDataValue("groupNames"))));
}
