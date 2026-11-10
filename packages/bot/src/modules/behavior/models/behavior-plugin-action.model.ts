import { DataTypes, type Transaction } from "sequelize";
import { sequelize } from "../../../db.js";
import { BehaviorDefinition } from "./behavior-definition.model.js";

/**
 * behavior_plugin_actions (#127 phase 2, #203): what a behavior whose
 * actionSource is 'plugin' runs — one action a plugin declares in its
 * manifest (`behavior_actions`). One row per such behavior.
 *
 * Keyed by pluginKey, not the plugin row's id: a plugin that is deleted
 * and registers again gets a new row, and its bindings still find it.
 * The binding is the authorization (ADR 0003 addendum): no Feature or
 * Guild Reach applies when it runs. Whether the plugin still declares
 * the action is checked on save and again on every run, never kept
 * here. No per-binding settings in v1 — a command's options go to the
 * plugin as they are.
 *
 * Removed with its behavior — explicitly (SQLite may run without FK
 * enforcement), and the command snapshot carries it so a refused command
 * write puts it back. A new table made by `sync()`; nothing to index past
 * the primary key.
 */
export const BehaviorPluginAction = sequelize.define(
  "BehaviorPluginAction",
  {
    behaviorId: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: { model: BehaviorDefinition, key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    pluginKey: { type: DataTypes.STRING, allowNull: false },
    actionKey: { type: DataTypes.STRING, allowNull: false },
  },
  { tableName: "behavior_plugin_actions", timestamps: true },
);

/** A behavior's plugin action binding. */
export interface BehaviorPluginActionRow {
  behaviorId: number;
  pluginKey: string;
  actionKey: string;
}

export function rowOfBehaviorPluginAction(
  model: InstanceType<typeof BehaviorPluginAction>,
): BehaviorPluginActionRow {
  return {
    behaviorId: model.getDataValue("behaviorId") as number,
    pluginKey: model.getDataValue("pluginKey") as string,
    actionKey: model.getDataValue("actionKey") as string,
  };
}

/** Remove the bindings of these behaviors (explicitly: see above). */
export async function destroyPluginActions(
  behaviorIds: number | number[],
  transaction: Transaction,
): Promise<void> {
  await BehaviorPluginAction.destroy({ where: { behaviorId: behaviorIds }, transaction });
}
