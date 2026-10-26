import { DataTypes } from "sequelize";
import { sequelize } from "../../../db.js";
import { BehaviorCommand } from "./behavior-command.model.js";

/**
 * behavior_definitions：一個 Behavior（ADR 0003）—— 一個觸發綁一個動作。
 *
 * 觸發（triggerKind）：
 *   - `command`：一個 Command Leaf。commandId 指向 behavior_commands；
 *     subcommandGroup 預留（第一階段一律 ''）；subcommand '' 是根葉節點。
 *     leafDescription / options（JSON，BehaviorCommandOption[]）是葉節點的
 *     說明與參數。
 *   - `message`：Message Trigger。surface `bot_dm`（與 bot 的私訊）或
 *     `guild`（guildId / channelId 為空 = 全部伺服器 / 整個伺服器）；
 *     patternKind + patternValue 比對；stopOnMatch、ignoreBots；對象
 *     （audience*）只在 bot_dm 提供。
 *
 * 動作來源（actionSource）：
 *   - `builtin`：系統動作，只給 System Behavior（systemKey 必填）
 *   - `webhook`：behavior_webhook_actions 的一列
 *
 * 索引一律由 migration 011 建立（理由見 behavior-command.model.ts）：
 *   - (commandId, subcommandGroup, subcommand) 唯一
 *   - systemKey 唯一（非 null）
 *
 * 「根葉節點與子指令不並存」是跨列規則，由寫入路徑與註冊時的子指令樹
 * 組裝（command-registration.ts）把關。
 */

export type BehaviorTriggerKind = "command" | "message";
export type BehaviorActionSource = "builtin" | "webhook";
export type BehaviorMessageSurface = "bot_dm" | "guild";
export type BehaviorPatternKind = "startswith" | "endswith" | "regex";
export type BehaviorAudienceKind = "all" | "user" | "group";
export type BehaviorSystemKey = "admin-login";

export const SYSTEM_BEHAVIOR_KEY_LOGIN = "admin-login" as const;
export const SYSTEM_BEHAVIOR_KEYS = [SYSTEM_BEHAVIOR_KEY_LOGIN] as const;

/** 葉節點允許的扁平 scalar option 型別（OPTION_TYPE_MAP 的子集；
 *  不開 sub_command / choices / autocomplete —— 那些屬 plugin SDK 的進階面）。 */
export const BEHAVIOR_OPTION_TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "user",
  "channel",
  "role",
  "mentionable",
  "attachment",
] as const;

export interface BehaviorCommandOption {
  type: (typeof BEHAVIOR_OPTION_TYPES)[number];
  name: string;
  description: string;
  required: boolean;
}

export const PATTERN_KINDS: readonly BehaviorPatternKind[] = [
  "startswith",
  "endswith",
  "regex",
];

export const BehaviorDefinition = sequelize.define(
  "BehaviorDefinition",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    title: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: "",
    },
    enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    systemKey: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: { isIn: [[...SYSTEM_BEHAVIOR_KEYS]] },
    },
    triggerKind: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: { isIn: [["command", "message"]] },
    },
    actionSource: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: { isIn: [["builtin", "webhook"]] },
    },
    // ── command leaf ──
    commandId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: BehaviorCommand, key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    subcommandGroup: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    subcommand: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    leafDescription: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    options: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // ── message trigger ──
    surface: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: { isIn: [["bot_dm", "guild"]] },
    },
    guildId: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    channelId: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    patternKind: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: { isIn: [[...PATTERN_KINDS]] },
    },
    patternValue: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    stopOnMatch: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // guild 訊息是否忽略 bot / webhook 作者；本 bot 自己的訊息一律丟棄
    ignoreBots: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    audienceKind: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "all",
      validate: { isIn: [["all", "user", "group"]] },
    },
    audienceUserId: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    audienceGroupName: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    tableName: "behavior_definitions",
    timestamps: true,
    // 每條規則在所需欄位有 undefined（bulk update 未帶到）時略過。
    validate: {
      triggerShape(this: Record<string, unknown>) {
        const kind = this["triggerKind"];
        if (kind === undefined) return;
        const isSet = (k: string) => this[k] !== undefined && this[k] !== null;
        if (kind === "command") {
          if (!isSet("commandId") || !isSet("subcommand")) {
            throw new Error("command trigger requires commandId + subcommand");
          }
          if (this["subcommandGroup"] !== "") {
            throw new Error("subcommand groups are reserved (must be '')");
          }
          if (isSet("surface") || isSet("patternKind") || isSet("patternValue")) {
            throw new Error("command trigger must not carry message fields");
          }
        } else {
          if (!isSet("surface") || !isSet("patternKind") || !isSet("patternValue")) {
            throw new Error(
              "message trigger requires surface + patternKind + patternValue",
            );
          }
          if (isSet("commandId") || isSet("subcommand") || isSet("subcommandGroup")) {
            throw new Error("message trigger must not carry command fields");
          }
        }
      },
      // 指定伺服器 / 頻道只在 surface='guild'；頻道必須帶伺服器
      placementShape(this: Record<string, unknown>) {
        const { surface, guildId, channelId } = this;
        if (surface === undefined || guildId === undefined || channelId === undefined) {
          return;
        }
        if (surface !== "guild" && (guildId !== null || channelId !== null)) {
          throw new Error("guildId / channelId only apply to surface='guild'");
        }
        if (channelId !== null && guildId === null) {
          throw new Error("channelId requires guildId");
        }
      },
      // 對象：欄位互斥；user / group 只在 bot_dm
      audienceShape(this: Record<string, unknown>) {
        const { audienceKind, audienceUserId, audienceGroupName } = this;
        if (
          audienceKind === undefined ||
          audienceUserId === undefined ||
          audienceGroupName === undefined
        ) {
          return;
        }
        const ok =
          (audienceKind === "all" &&
            audienceUserId === null &&
            audienceGroupName === null) ||
          (audienceKind === "user" &&
            audienceUserId !== null &&
            audienceGroupName === null) ||
          (audienceKind === "group" &&
            audienceGroupName !== null &&
            audienceUserId === null);
        if (!ok) throw new Error("audience fields are inconsistent");
        if (
          audienceKind !== "all" &&
          this["surface"] !== undefined &&
          this["surface"] !== "bot_dm"
        ) {
          throw new Error("audience other than 'all' only applies to bot_dm");
        }
      },
      // builtin ⇔ systemKey；系統登入的訊息觸發只能在與 bot 的私訊
      actionShape(this: Record<string, unknown>) {
        const { actionSource, systemKey } = this;
        if (actionSource === undefined || systemKey === undefined) return;
        if ((actionSource === "builtin") !== (systemKey !== null)) {
          throw new Error("actionSource 'builtin' is exactly the system behaviors");
        }
        if (
          systemKey !== null &&
          this["triggerKind"] === "message" &&
          this["surface"] !== undefined &&
          this["surface"] !== "bot_dm"
        ) {
          throw new Error("the system login's message trigger must be bot_dm");
        }
      },
    },
  },
);

export interface BehaviorDefinitionRow {
  id: number;
  title: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
  systemKey: BehaviorSystemKey | null;
  triggerKind: BehaviorTriggerKind;
  actionSource: BehaviorActionSource;
  commandId: number | null;
  subcommandGroup: string | null;
  subcommand: string | null;
  leafDescription: string | null;
  options: string | null;
  surface: BehaviorMessageSurface | null;
  guildId: string | null;
  channelId: string | null;
  patternKind: BehaviorPatternKind | null;
  patternValue: string | null;
  stopOnMatch: boolean;
  ignoreBots: boolean;
  audienceKind: BehaviorAudienceKind;
  audienceUserId: string | null;
  audienceGroupName: string | null;
  /** last write — the version an admin edit is based on */
  updatedAt: Date;
}

export function rowOfBehaviorDefinition(
  model: InstanceType<typeof BehaviorDefinition>,
): BehaviorDefinitionRow {
  const value = <T>(k: string): T => model.getDataValue(k) as T;
  const nullable = <T>(k: string): T | null =>
    (model.getDataValue(k) as T | null) ?? null;
  return {
    id: value<number>("id"),
    title: value<string>("title"),
    description: value<string>("description") ?? "",
    enabled: !!value("enabled"),
    sortOrder: value<number>("sortOrder"),
    systemKey: nullable<BehaviorSystemKey>("systemKey"),
    triggerKind: value<BehaviorTriggerKind>("triggerKind"),
    actionSource: value<BehaviorActionSource>("actionSource"),
    commandId: nullable<number>("commandId"),
    subcommandGroup: nullable<string>("subcommandGroup"),
    subcommand: nullable<string>("subcommand"),
    leafDescription: nullable<string>("leafDescription"),
    options: nullable<string>("options"),
    surface: nullable<BehaviorMessageSurface>("surface"),
    guildId: nullable<string>("guildId"),
    channelId: nullable<string>("channelId"),
    patternKind: nullable<BehaviorPatternKind>("patternKind"),
    patternValue: nullable<string>("patternValue"),
    stopOnMatch: !!value("stopOnMatch"),
    ignoreBots: !!value("ignoreBots"),
    audienceKind: value<BehaviorAudienceKind>("audienceKind"),
    audienceUserId: nullable<string>("audienceUserId"),
    audienceGroupName: nullable<string>("audienceGroupName"),
    updatedAt: value<Date>("updatedAt"),
  };
}

/**
 * A command leaf's path segments. `subcommandGroup` is reserved ('' in
 * phase 1) and `subcommand` '' is the root leaf; message triggers store
 * null for both, read here as ''.
 */
export interface LeafPath {
  subcommandGroup: string;
  subcommand: string;
}

export function leafPathOf(leaf: {
  subcommandGroup: string | null;
  subcommand: string | null;
}): LeafPath {
  return {
    subcommandGroup: leaf.subcommandGroup ?? "",
    subcommand: leaf.subcommand ?? "",
  };
}

/**
 * A leaf's stored `options` JSON → its options. `null` when the column
 * holds something that is not a JSON array (hand-edited DB etc.); the
 * shape itself was validated on write (the leaf schema + checkLeafOptions).
 */
export function parseLeafOptions(
  raw: string | null,
): BehaviorCommandOption[] | null {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as BehaviorCommandOption[]) : null;
  } catch {
    return null;
  }
}
