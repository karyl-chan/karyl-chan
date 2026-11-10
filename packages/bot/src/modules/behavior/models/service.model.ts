import { DataTypes } from "sequelize";
import { sequelize } from "../../../db.js";

/**
 * services：一個 Service（#126）—— 透過 karyl 登入的自架服務。
 *
 *   - name：顯示名稱（登入回覆的標題、管理頁）
 *   - audience：服務 token 的 `aud`，唯一 slug；服務端用它確認 token 是給
 *     自己的
 *   - redirectUrl：登入連結的目的地（https），token 以 `token` query 帶上
 *
 * 每個服務擁有一列 Service Behavior（behavior_definitions 的
 * actionSource='service'、serviceId 指向這裡），與服務同生同滅。新表由
 * sync() 建立；audience 的唯一索引定義在欄位上。
 */

/** A service's audience: a lower-case slug (it also names the default trigger `!login-<audience>`). */
export const SERVICE_AUDIENCE_PATTERN = "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$";

export const Service = sequelize.define(
  "Service",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    audience: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: { is: new RegExp(SERVICE_AUDIENCE_PATTERN) },
    },
    redirectUrl: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    tableName: "services",
    timestamps: true,
  },
);

/** A service's login title: its Service Behavior's title and the login reply's. */
export function serviceBehaviorTitle(serviceName: string): string {
  return `登入 ${serviceName}`;
}

export interface ServiceRow {
  id: number;
  name: string;
  audience: string;
  redirectUrl: string;
  createdAt: Date;
  /** last write — the version an admin edit is based on */
  updatedAt: Date;
}

export function rowOfService(model: InstanceType<typeof Service>): ServiceRow {
  const value = <T>(k: string): T => model.getDataValue(k) as T;
  return {
    id: value<number>("id"),
    name: value<string>("name"),
    audience: value<string>("audience"),
    redirectUrl: value<string>("redirectUrl"),
    createdAt: value<Date>("createdAt"),
    updatedAt: value<Date>("updatedAt"),
  };
}
