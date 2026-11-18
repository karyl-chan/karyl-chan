import { DataTypes, type Transaction } from "sequelize";
import { sequelize } from "../../../db.js";
import {
  behaviorTargetKey,
  type BehaviorTargetFields,
  type BehaviorTargetKind,
} from "../behavior-target.js";

/**
 * behavior_targets：管理員建立的 Behavior Target（作用對象，ADR 0004）名冊
 * —— 指定伺服器、指定頻道、特定使用者、群組。三個內建對象（App 指令、
 * 所有人與 bot 的私訊、全部伺服器）沒有列。
 *
 *   - key：對象的 key（behavior-target.ts），唯一。群組名稱因此全域唯一。
 *   - kind + guildId / channelId / userId / groupName：key 的組成，讓讀的人
 *     不必解析 key；`targetShape` 檢查兩邊一致。
 *
 * 名冊只記「有哪些對象」，不決定行為：behavior 屬於哪個對象仍由
 * behavior_definitions 的欄位推導（messageTriggerTarget / behaviorSection）。
 * 被 behavior 或私訊白名單用到的對象一定有列（behavior-target-registry.ts
 * 在每次寫入後補上），沒有 behavior 的對象留著，直到管理員刪除它。
 *
 * 群組的成員在 behavior_group_members（以名稱為鍵），和群組的列同生同滅：
 * 有列才能設成員，刪除列時名單一起刪。
 *
 * 新表由 sync() 建立；既有資料由 migration 017 補列。
 */
export const BehaviorTarget = sequelize.define(
  "BehaviorTarget",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    key: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
    },
    kind: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: { isIn: [["guild", "channel", "user", "group"]] },
    },
    guildId: { type: DataTypes.TEXT, allowNull: true },
    channelId: { type: DataTypes.TEXT, allowNull: true },
    userId: { type: DataTypes.TEXT, allowNull: true },
    groupName: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    tableName: "behavior_targets",
    timestamps: true,
    validate: {
      targetShape(this: Partial<BehaviorTargetFields> & { key?: string }) {
        if (this.kind === undefined || this.key === undefined) return;
        const fields: BehaviorTargetFields = {
          kind: this.kind,
          guildId: this.guildId ?? null,
          channelId: this.channelId ?? null,
          userId: this.userId ?? null,
          groupName: this.groupName ?? null,
        };
        const used: Record<BehaviorTargetKind, Array<keyof BehaviorTargetFields>> = {
          guild: ["guildId"],
          channel: ["guildId", "channelId"],
          user: ["userId"],
          group: ["groupName"],
        };
        for (const field of ["guildId", "channelId", "userId", "groupName"] as const) {
          const wanted = used[fields.kind].includes(field);
          if (wanted !== (fields[field] !== null)) {
            throw new Error(
              wanted
                ? `a ${fields.kind} target needs ${field}`
                : `a ${fields.kind} target takes no ${field}`,
            );
          }
        }
        if (behaviorTargetKey(fields) !== this.key) {
          throw new Error("a target's key must match its fields");
        }
      },
    },
  },
);

export interface BehaviorTargetRow extends BehaviorTargetFields {
  id: number;
  key: string;
}

export function rowOfBehaviorTarget(
  model: InstanceType<typeof BehaviorTarget>,
): BehaviorTargetRow {
  const nullable = (k: string): string | null => (model.getDataValue(k) as string | null) ?? null;
  return {
    id: model.getDataValue("id") as number,
    key: model.getDataValue("key") as string,
    kind: model.getDataValue("kind") as BehaviorTargetKind,
    guildId: nullable("guildId"),
    channelId: nullable("channelId"),
    userId: nullable("userId"),
    groupName: nullable("groupName"),
  };
}

export async function findBehaviorTargets(transaction?: Transaction): Promise<BehaviorTargetRow[]> {
  const rows = await BehaviorTarget.findAll({ order: [["id", "ASC"]], transaction });
  return rows.map(rowOfBehaviorTarget);
}

/** Whether a group target of this name exists — only then can its members be set. */
export async function groupTargetExists(
  groupName: string,
  transaction?: Transaction,
): Promise<boolean> {
  return (
    (await BehaviorTarget.count({
      where: { key: behaviorTargetKey({ kind: "group", guildId: null, channelId: null, userId: null, groupName }) },
      transaction,
    })) > 0
  );
}
