import { DataTypes, Op } from "sequelize";
import { sequelize } from "../../../db.js";

// ── v2 列舉型別 ──────────────────────────────────────────────────────────────

export type BehaviorSource = "custom" | "system";
export type BehaviorTriggerType = "slash_command" | "message_pattern";
export type BehaviorMessagePatternKind = "startswith" | "endswith" | "regex";
export type BehaviorForwardType = "one_time" | "continuous";
export type BehaviorScope = "global" | "guild";
export type BehaviorAudienceKind = "all" | "user" | "group";
export type BehaviorWebhookAuthMode = "token" | "hmac";
export type BehaviorSystemKey = "admin-login" | "manual" | "break";

// ── system behavior 常數（供 main.ts + dispatcher 用）─────────────────────────

export const SYSTEM_BEHAVIOR_KEY_LOGIN = "admin-login" as const;
export const SYSTEM_BEHAVIOR_KEY_MANUAL = "manual" as const;
export const SYSTEM_BEHAVIOR_KEY_BREAK = "break" as const;

export const SYSTEM_BEHAVIOR_KEYS = [
  SYSTEM_BEHAVIOR_KEY_LOGIN,
  SYSTEM_BEHAVIOR_KEY_MANUAL,
  SYSTEM_BEHAVIOR_KEY_BREAK,
] as const;

// ── Sequelize model 定義 ──────────────────────────────────────────────────────

/**
 * v2 behaviors 表。軌二 webhook 接口層的核心表，source ∈ {custom, system}。
 *
 * 欄位對應 A-schema §1.2 DDL（破壞性遷移版，無 legacyId）。
 * 單欄位列舉 CHECK 由 ENUM 欄位型別在 SQLite 層強制；slashCommandName 格式與
 * 跨欄位 invariant 則為 model-level validate（app-level，DB 不再強制）—
 * 詳見下方 validate 區塊。
 *
 * 注意：integrationTypes / contexts 為 lexicographically-sorted comma-joined string，
 * 應用層在 INSERT/UPDATE 前必須強制 sort+dedup 後才寫入。
 */
export const Behavior = sequelize.define(
  "Behavior",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    // 基本元資料
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
    stopOnMatch: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // BH-3：guild 頻道 pattern 是否忽略 bot/webhook 作者的訊息。預設忽略
    // （防 bot 迴圈）；取消勾選也擋不掉本 bot 自身訊息（matcher 無條件丟棄）。
    ignoreBots: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    forwardType: {
      // ENUM → sync() 發出 CHECK(forwardType IN ('one_time','continuous'))
      type: DataTypes.ENUM("one_time", "continuous"),
      allowNull: false,
      defaultValue: "one_time",
    },
    // 三維分類
    source: {
      type: DataTypes.ENUM("custom", "system"),
      allowNull: false,
    },
    triggerType: {
      type: DataTypes.ENUM("slash_command", "message_pattern"),
      allowNull: false,
    },
    // message_pattern 子型
    messagePatternKind: {
      type: DataTypes.ENUM("startswith", "endswith", "regex"),
      allowNull: true,
    },
    messagePatternValue: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // slash_command 子欄位
    slashCommandName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    slashCommandDescription: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // BH-2.2C：slash 指令的 options 定義（JSON 陣列，ManifestCommandOption
    // 的扁平 scalar 子集）。null = 無參數。pattern 行為一律 null。
    slashCommandOptions: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // 三軸
    scope: {
      type: DataTypes.ENUM("global", "guild"),
      allowNull: false,
      defaultValue: "global",
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
    // placement
    placementGuildId: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    placementChannelId: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // audience
    audienceKind: {
      type: DataTypes.ENUM("all", "user", "group"),
      allowNull: false,
      defaultValue: "all",
    },
    audienceUserId: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    audienceGroupName: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // source-specific：custom
    webhookUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    webhookSecret: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    webhookAuthMode: {
      type: DataTypes.ENUM("token", "hmac"),
      allowNull: true,
    },
    // source-specific：system
    systemKey: {
      type: DataTypes.ENUM("admin-login", "manual", "break"),
      allowNull: true,
    },
    // scope tab FK (added by migration 20260508010000)
    scopeTabId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
  },
  {
    tableName: "behaviors",
    timestamps: true,
    indexes: [
      {
        name: "behaviors_dispatch_idx",
        fields: ["triggerType", "enabled", "scope", "sortOrder"],
      },
      {
        name: "behaviors_audience_user_idx",
        fields: ["audienceUserId"],
        where: { audienceKind: "user" },
      },
      {
        name: "behaviors_audience_group_idx",
        fields: ["audienceGroupName"],
        where: { audienceKind: "group" },
      },
      {
        name: "behaviors_placement_idx",
        fields: ["placementGuildId", "placementChannelId"],
        // 部分索引：placementGuildId IS NOT NULL
        where: { placementGuildId: { [Op.ne]: null } },
      },
      {
        name: "behaviors_scope_tab_idx",
        fields: ["scopeTabId"],
      },
      {
        name: "behaviors_slash_uq",
        unique: true,
        fields: ["slashCommandName", "scope", "contexts"],
        where: { triggerType: "slash_command", enabled: true },
      },
      {
        name: "behaviors_system_uq",
        unique: true,
        fields: ["systemKey"],
        where: { source: "system" },
      },
    ],
    // ── 跨欄位 / 格式 CHECK invariant ───────────────────────────────────────
    // SQLite 層的 9 個 CHECK 中，8 個單欄位列舉 CHECK 已由 ENUM 欄位型別表達；
    // 其餘無法由 Sequelize 欄位定義表達者（slashCommandName 格式 + 7 個跨欄位
    // table-level CHECK）下放為 model-level validate 函式。
    // 注意：這是 app-level downgrade — DB 不再強制這些 invariant，
    // 僅在 Sequelize create/update 時於應用層檢查。
    //
    // 每個跨欄位 validate 函式在「所需欄位中有任一為 undefined」時直接 return：
    // Sequelize 的 bulk update（Behavior.update({...})）只會把被 SET 的欄位帶進
    // validate context，未變動欄位皆為 undefined。此時無法評估跨欄位 invariant，
    // 故略過 —— 與 SQLite CHECK 只在「整列可見」時才有意義一致。
    //
    // ⚠ 因此：任何會更動 invariant 相關欄位的寫入，必須用 instance 寫法
    //   （load → 改 → save()），讓整列進入 validate context，不可用靜態
    //   Behavior.update()。目前僅有的靜態 update 只動 sortOrder / scopeTabId，
    //   不涉任何 invariant，故安全。
    validate: {
      // CHECK：slashCommandName 格式（1-32 字、僅 a-z0-9_-、全小寫）
      slashCommandNameFormat(this: { slashCommandName?: string | null }) {
        const v = this.slashCommandName;
        if (v == null) return;
        if (
          v.length < 1 ||
          v.length > 32 ||
          !/^[a-z0-9_-]+$/.test(v) ||
          v !== v.toLowerCase()
        ) {
          throw new Error(
            "slashCommandName must be 1-32 chars, lowercase, [a-z0-9_-] only",
          );
        }
      },
      // CHECK：triggerType ↔ message_pattern / slash_command 子欄位互斥
      triggerTypeShape(this: {
        triggerType?: string;
        messagePatternKind?: string | null;
        messagePatternValue?: string | null;
        slashCommandName?: string | null;
      }) {
        if (this.triggerType === undefined) return;
        const ok =
          (this.triggerType === "message_pattern" &&
            this.messagePatternKind != null &&
            this.messagePatternValue != null &&
            this.slashCommandName == null) ||
          (this.triggerType === "slash_command" &&
            this.slashCommandName != null &&
            this.messagePatternKind == null &&
            this.messagePatternValue == null);
        if (!ok) {
          throw new Error(
            "triggerType-specific fields are inconsistent (message_pattern vs slash_command)",
          );
        }
      },
      // CHECK：source ↔ custom/system 的 webhook/systemKey 互斥
      sourceShape(this: {
        source?: string;
        webhookUrl?: string | null;
        webhookSecret?: string | null;
        systemKey?: string | null;
      }) {
        if (this.source === undefined) return;
        const ok =
          (this.source === "custom" &&
            this.webhookUrl != null &&
            this.systemKey == null) ||
          (this.source === "system" &&
            this.systemKey != null &&
            this.webhookUrl == null &&
            this.webhookSecret == null);
        if (!ok) {
          throw new Error(
            "source-specific fields are inconsistent (custom vs system)",
          );
        }
      },
      // CHECK：webhookSecret ↔ webhookAuthMode 同生同滅，且 system 不可有 secret
      webhookSecretShape(this: {
        source?: string;
        webhookSecret?: string | null;
        webhookAuthMode?: string | null;
      }) {
        if (
          this.source === undefined ||
          this.webhookSecret === undefined ||
          this.webhookAuthMode === undefined
        ) {
          return;
        }
        const ok =
          (this.webhookSecret == null && this.webhookAuthMode == null) ||
          (this.webhookSecret != null &&
            this.webhookAuthMode != null &&
            this.source !== "system");
        if (!ok) {
          throw new Error(
            "webhookSecret and webhookAuthMode must be set together (and not on system source)",
          );
        }
      },
      // CHECK：guild scope 時不可帶 user_install / BotDM / PrivateChannel
      scopeInstallContexts(this: {
        source?: string;
        scope?: string;
        integrationTypes?: string;
        contexts?: string;
      }) {
        if (this.scope === undefined) return;
        if (this.source === "system") return;
        const ok =
          this.scope === "global" ||
          (this.scope === "guild" &&
            !(this.integrationTypes ?? "").includes("user_install") &&
            !(this.contexts ?? "").includes("BotDM") &&
            !(this.contexts ?? "").includes("PrivateChannel"));
        if (!ok) {
          throw new Error(
            "guild-scoped behavior must not use user_install / BotDM / PrivateChannel",
          );
        }
      },
      // CHECK：audienceKind ↔ audienceUserId / audienceGroupName 互斥
      audienceShape(this: {
        audienceKind?: string;
        audienceUserId?: string | null;
        audienceGroupName?: string | null;
      }) {
        if (this.audienceKind === undefined) return;
        const ok =
          (this.audienceKind === "all" &&
            this.audienceUserId == null &&
            this.audienceGroupName == null) ||
          (this.audienceKind === "user" &&
            this.audienceUserId != null &&
            this.audienceGroupName == null) ||
          (this.audienceKind === "group" &&
            this.audienceGroupName != null &&
            this.audienceUserId == null);
        if (!ok) {
          throw new Error(
            "audience-specific fields are inconsistent (all vs user vs group)",
          );
        }
      },
      // CHECK：placementChannelId 不可在無 placementGuildId 時出現
      placementShape(this: {
        placementGuildId?: string | null;
        placementChannelId?: string | null;
      }) {
        if (
          this.placementGuildId === undefined ||
          this.placementChannelId === undefined
        ) {
          return;
        }
        const ok =
          (this.placementGuildId == null &&
            this.placementChannelId == null) ||
          this.placementGuildId != null;
        if (!ok) {
          throw new Error(
            "placementChannelId requires placementGuildId to be set",
          );
        }
      },
      // CHECK：有 placementGuildId 時 scope 必為 'guild'
      placementScope(this: {
        placementGuildId?: string | null;
        scope?: string;
      }) {
        if (this.placementGuildId === undefined || this.scope === undefined) {
          return;
        }
        if (this.placementGuildId != null && this.scope !== "guild") {
          throw new Error("placementGuildId requires scope = 'guild'");
        }
      },
      // （BH-3 移除舊的 messagePatternContexts CHECK：guild 頻道 pattern
      //   已是正式能力，contexts 可含 'Guild'。）
    },
  },
);

// ── Row 型別 ──────────────────────────────────────────────────────────────────

export interface BehaviorRow {
  id: number;
  title: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
  stopOnMatch: boolean;
  ignoreBots: boolean;
  forwardType: BehaviorForwardType;
  source: BehaviorSource;
  triggerType: BehaviorTriggerType;
  messagePatternKind: BehaviorMessagePatternKind | null;
  messagePatternValue: string | null;
  slashCommandName: string | null;
  slashCommandDescription: string | null;
  slashCommandOptions: string | null;
  scope: BehaviorScope;
  integrationTypes: string;
  contexts: string;
  placementGuildId: string | null;
  placementChannelId: string | null;
  audienceKind: BehaviorAudienceKind;
  audienceUserId: string | null;
  audienceGroupName: string | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
  webhookAuthMode: BehaviorWebhookAuthMode | null;
  systemKey: BehaviorSystemKey | null;
  scopeTabId: number;
}

export function rowOfBehavior(
  model: InstanceType<typeof Behavior>,
): BehaviorRow {
  return {
    id: model.getDataValue("id") as number,
    title: model.getDataValue("title") as string,
    description: (model.getDataValue("description") as string) ?? "",
    enabled: !!model.getDataValue("enabled"),
    sortOrder: model.getDataValue("sortOrder") as number,
    stopOnMatch: !!model.getDataValue("stopOnMatch"),
    ignoreBots: !!model.getDataValue("ignoreBots"),
    forwardType: model.getDataValue("forwardType") as BehaviorForwardType,
    source: model.getDataValue("source") as BehaviorSource,
    triggerType: model.getDataValue("triggerType") as BehaviorTriggerType,
    messagePatternKind:
      (model.getDataValue(
        "messagePatternKind",
      ) as BehaviorMessagePatternKind | null) ?? null,
    messagePatternValue:
      (model.getDataValue("messagePatternValue") as string | null) ?? null,
    slashCommandName:
      (model.getDataValue("slashCommandName") as string | null) ?? null,
    slashCommandDescription:
      (model.getDataValue("slashCommandDescription") as string | null) ?? null,
    slashCommandOptions:
      (model.getDataValue("slashCommandOptions") as string | null) ?? null,
    scope: model.getDataValue("scope") as BehaviorScope,
    integrationTypes: model.getDataValue("integrationTypes") as string,
    contexts: model.getDataValue("contexts") as string,
    placementGuildId:
      (model.getDataValue("placementGuildId") as string | null) ?? null,
    placementChannelId:
      (model.getDataValue("placementChannelId") as string | null) ?? null,
    audienceKind: model.getDataValue("audienceKind") as BehaviorAudienceKind,
    audienceUserId:
      (model.getDataValue("audienceUserId") as string | null) ?? null,
    audienceGroupName:
      (model.getDataValue("audienceGroupName") as string | null) ?? null,
    webhookUrl: (model.getDataValue("webhookUrl") as string | null) ?? null,
    webhookSecret:
      (model.getDataValue("webhookSecret") as string | null) ?? null,
    webhookAuthMode:
      (model.getDataValue(
        "webhookAuthMode",
      ) as BehaviorWebhookAuthMode | null) ?? null,
    systemKey:
      (model.getDataValue("systemKey") as BehaviorSystemKey | null) ?? null,
    scopeTabId: (model.getDataValue("scopeTabId") as number) ?? 1,
  };
}

// ── Query helpers ─────────────────────────────────────────────────────────────

export const findBehaviorById = async (
  id: number,
): Promise<BehaviorRow | null> => {
  const row = await Behavior.findByPk(id);
  return row ? rowOfBehavior(row) : null;
};

/**
 * 查詢所有 source='system' 的 behavior rows。
 * 供 main.ts interactionCreate dispatcher 使用。
 */
export const findAllSystemBehaviors = async (): Promise<BehaviorRow[]> => {
  const rows = await Behavior.findAll({ where: { source: "system" } });
  return rows.map(rowOfBehavior);
};

/**
 * 查詢所有 enabled=1 且 triggerType='slash_command' 的 slashCommandName。
 * 用於 CR-4：assertNoCollisions 防止 plugin command 與 behavior slash trigger 名稱碰撞。
 * NULL slashCommandName 的 row 自動過濾，回傳的全為非空字串。
 */
export const findEnabledSlashCommandNames = async (): Promise<string[]> => {
  const rows = await Behavior.findAll({
    where: {
      triggerType: "slash_command",
      enabled: true,
    },
    attributes: ["slashCommandName"],
  });
  return rows
    .map((r) => r.getDataValue("slashCommandName") as string | null)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
};
