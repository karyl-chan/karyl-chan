import { DataTypes } from "sequelize";
import { sequelize } from "../../../db.js";
import { BehaviorDefinition } from "./behavior-definition.model.js";

/**
 * behavior_webhook_actions：actionSource='webhook' 的 behavior 的動作設定。
 * url 與 secret 皆以 encryptSecret 加密保存；secret 與 authMode 同生同滅。
 * admin API 只回報 secret 是否已設定，不回傳明文。
 *
 * 輪換（#99）：previousSecret 是被換掉的舊密鑰（同樣加密），在
 * previousSecretExpiresAt 之前仍然有效 —— 轉發時多送一份舊密鑰的簽章 /
 * token，回應用新舊任一把簽都接受（webhook-forwarder.service.ts）。
 * 兩欄同生同滅（migration 012 新增）。
 */

export type BehaviorWebhookAuthMode = "token" | "hmac";

export const BehaviorWebhookAction = sequelize.define(
  "BehaviorWebhookAction",
  {
    behaviorId: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: { model: BehaviorDefinition, key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    url: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    secret: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    authMode: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: { isIn: [["token", "hmac"]] },
    },
    previousSecret: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    previousSecretExpiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "behavior_webhook_actions",
    timestamps: true,
    validate: {
      secretShape(this: { secret?: string | null; authMode?: string | null }) {
        if (this.secret === undefined || this.authMode === undefined) return;
        if ((this.secret === null) !== (this.authMode === null)) {
          throw new Error("secret and authMode must be set together");
        }
      },
      previousSecretShape(this: {
        previousSecret?: string | null;
        previousSecretExpiresAt?: Date | null;
      }) {
        if (
          this.previousSecret === undefined ||
          this.previousSecretExpiresAt === undefined
        ) {
          return;
        }
        if ((this.previousSecret === null) !== (this.previousSecretExpiresAt === null)) {
          throw new Error("previousSecret and previousSecretExpiresAt must be set together");
        }
      },
    },
  },
);

/** 轉發一個 webhook 動作需要的全部資料（url / secret 仍是密文）。 */
export interface BehaviorWebhookActionRow {
  behaviorId: number;
  url: string;
  secret: string | null;
  authMode: BehaviorWebhookAuthMode | null;
  /** the secret a rotation replaced (ciphertext), while its grace period lasts */
  previousSecret: string | null;
  previousSecretExpiresAt: Date | null;
}

export function rowOfBehaviorWebhookAction(
  model: InstanceType<typeof BehaviorWebhookAction>,
): BehaviorWebhookActionRow {
  return {
    behaviorId: model.getDataValue("behaviorId") as number,
    url: model.getDataValue("url") as string,
    secret: (model.getDataValue("secret") as string | null) ?? null,
    authMode:
      (model.getDataValue("authMode") as BehaviorWebhookAuthMode | null) ??
      null,
    previousSecret:
      (model.getDataValue("previousSecret") as string | null) ?? null,
    previousSecretExpiresAt:
      (model.getDataValue("previousSecretExpiresAt") as Date | null) ?? null,
  };
}
