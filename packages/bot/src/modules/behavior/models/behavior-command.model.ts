import { DataTypes } from "sequelize";
import { sequelize } from "../../../db.js";

/**
 * behavior_commands：一個 Command（指令，ADR 0003）—— Discord 註冊的單位，
 * 持有名稱與所有可見性設定；底下的 Command Leaf 是 behavior_definitions
 * 中 triggerKind='command' 的列。
 *
 *   - registration：`global`（全域）或 `guild`（指定伺服器，guildId 必填）
 *   - integrationTypes / contexts：排序過的逗號字串（sortJoin）
 *   - defaultMemberPermissions：Discord permission bitfield 十進位字串；
 *     null = 不限制
 *   - isSystem：系統指令（登入改用指令觸發時）的容器
 *
 * 索引一律由 migration 011 建立（不放 model）：sync() 會替既有的表補建
 * model 上的索引，而它在 migration 之前執行。
 *   - name 唯一（registration='global'）
 *   - (name, guildId) 唯一（registration='guild'）
 *
 * 跨欄位規則是 model-level validate（app-level）：bulk update 只把被 SET
 * 的欄位帶進 validate context，因此每條規則在所需欄位有 undefined 時略過；
 * 動到這些欄位的寫入請用 instance 寫法（load → 改 → save()）。
 */

export type BehaviorCommandRegistration = "global" | "guild";

export const COMMAND_NAME_RE = /^[a-z0-9_-]{1,32}$/;
export const PERMISSIONS_RE = /^\d+$/;

export const BehaviorCommand = sequelize.define(
  "BehaviorCommand",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: { is: COMMAND_NAME_RE },
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: false,
      validate: { len: [1, 100] },
    },
    registration: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "global",
      validate: { isIn: [["global", "guild"]] },
    },
    guildId: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    integrationTypes: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: "guild_install",
    },
    contexts: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: "Guild",
    },
    defaultMemberPermissions: {
      type: DataTypes.TEXT,
      allowNull: true,
      validate: { is: PERMISSIONS_RE },
    },
    isSystem: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    tableName: "behavior_commands",
    timestamps: true,
    validate: {
      // registration='guild' ⇔ guildId；指定伺服器的指令只能在伺服器
      // 裡用、只能由伺服器安裝（Discord 對伺服器指令的規則）
      registrationShape(this: {
        registration?: string;
        guildId?: string | null;
        integrationTypes?: string;
        contexts?: string;
      }) {
        if (this.registration === undefined || this.guildId === undefined) {
          return;
        }
        if (this.registration === "guild") {
          if (!this.guildId) {
            throw new Error("guild registration requires guildId");
          }
          if (
            (this.contexts !== undefined && this.contexts !== "Guild") ||
            (this.integrationTypes !== undefined &&
              this.integrationTypes !== "guild_install")
          ) {
            throw new Error(
              "guild registration requires contexts=Guild and integrationTypes=guild_install",
            );
          }
        } else if (this.guildId !== null) {
          throw new Error("global registration must not set guildId");
        }
      },
    },
  },
);

export interface BehaviorCommandRow {
  id: number;
  name: string;
  description: string;
  registration: BehaviorCommandRegistration;
  guildId: string | null;
  integrationTypes: string;
  contexts: string;
  defaultMemberPermissions: string | null;
  isSystem: boolean;
}

export function rowOfBehaviorCommand(
  model: InstanceType<typeof BehaviorCommand>,
): BehaviorCommandRow {
  return {
    id: model.getDataValue("id") as number,
    name: model.getDataValue("name") as string,
    description: model.getDataValue("description") as string,
    registration: model.getDataValue(
      "registration",
    ) as BehaviorCommandRegistration,
    guildId: (model.getDataValue("guildId") as string | null) ?? null,
    integrationTypes: model.getDataValue("integrationTypes") as string,
    contexts: model.getDataValue("contexts") as string,
    defaultMemberPermissions:
      (model.getDataValue("defaultMemberPermissions") as string | null) ??
      null,
    isSystem: !!model.getDataValue("isSystem"),
  };
}
