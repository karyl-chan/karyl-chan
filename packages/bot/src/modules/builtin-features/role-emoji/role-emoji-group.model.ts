import { DataTypes } from "sequelize";
import { sequelize } from "../../../db.js";

/**
 * A named bucket of emoji→role mappings inside a guild. A watched
 * message is bound to exactly one group (`RoleReceiveMessage.groupId`,
 * NOT NULL); a reaction resolves to a role only when the emoji belongs
 * to that message's group.
 *
 * The groups model lets one guild keep several independent reaction
 * sets — for example, a "self-assignable colours" board and a "pings
 * opt-in" board — without the same emoji on a different board granting
 * the wrong role.
 */
export const RoleEmojiGroup = sequelize.define(
  "RoleEmojiGroup",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    guildId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "RoleEmojiGroups",
    indexes: [{ unique: true, fields: ["guildId", "name"] }],
  },
);

export const addRoleEmojiGroup = async (guildId: string, name: string) => {
  return await RoleEmojiGroup.create({ guildId, name });
};

export const removeRoleEmojiGroup = async (guildId: string, id: number) => {
  await RoleEmojiGroup.destroy({ where: { guildId, id } });
};

export const findRoleEmojiGroupByName = async (
  guildId: string,
  name: string,
) => {
  return await RoleEmojiGroup.findOne({ where: { guildId, name } });
};

export const findRoleEmojiGroupById = async (guildId: string, id: number) => {
  return await RoleEmojiGroup.findOne({ where: { guildId, id } });
};

export const findAllRoleEmojiGroups = async (guildId: string) => {
  return await RoleEmojiGroup.findAll({
    where: { guildId },
    order: [["name", "ASC"]],
  });
};
