import { DataTypes } from "sequelize";
import { sequelize } from "../../../db.js";

/**
 * In-process feature on/off state.
 *
 * The operator-default row uses `guildId = ''` (empty-string sentinel);
 * concrete-guild rows use the real guild id and override the default.
 * The helper API still speaks `guildId: string | null` (`null` = the
 * operator default) and translates null ↔ '' at the DB boundary, so
 * callers never see the sentinel.
 *
 * `guildId` is NOT NULL so the UNIQUE(guildId, featureKey) index truly
 * enforces one row per (scope, feature); SQLite would otherwise treat
 * NULLs as distinct and let duplicate operator-default rows through.
 *
 * Reads go through resolveBuiltinFeatureEnabled which encodes the
 * default-vs-per-guild precedence.
 */
export const BotFeatureState = sequelize.define(
  "BotFeatureState",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    // operator default 以 '' 表示（NOT NULL 讓 UNIQUE index 真正生效）
    guildId: { type: DataTypes.STRING, allowNull: false, defaultValue: "" },
    featureKey: { type: DataTypes.STRING, allowNull: false },
    enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    tableName: "bot_feature_state",
    timestamps: true,
    indexes: [
      {
        name: "bot_feature_state_by_feature",
        fields: ["featureKey"],
      },
      {
        // One row per (guildId, featureKey). guildId is NOT NULL — the
        // operator default uses the '' sentinel — so this plain UNIQUE
        // index genuinely enforces uniqueness, including for the
        // operator-default row (no functional IFNULL index needed since
        // there are no NULLs to make distinct).
        name: "bot_feature_state_unique",
        unique: true,
        fields: ["guildId", "featureKey"],
      },
    ],
  },
);

export interface BotFeatureStateRow {
  id: number;
  guildId: string | null;
  featureKey: string;
  enabled: boolean;
  updatedAt: Date;
}

function rowOf(m: InstanceType<typeof BotFeatureState>): BotFeatureStateRow {
  return {
    id: m.getDataValue("id") as number,
    // '' sentinel（operator default）對外還原成 null
    guildId: (m.getDataValue("guildId") as string) || null,
    featureKey: m.getDataValue("featureKey") as string,
    enabled: !!m.getDataValue("enabled"),
    updatedAt: m.getDataValue("updatedAt") as Date,
  };
}

/**
 * The frozen list of in-process built-in features, mirroring the
 * frontend's guild-feature registry. Adding a new built-in feature
 * means appending here AND registering its UI in
 * `frontend/src/modules/guild-features/registry.ts`.
 */
export const BUILTIN_FEATURE_KEYS = [
  "todo",
  "picture-only",
  "role-emoji",
  "rcon",
  "voice",
] as const;
export type BuiltinFeatureKey = (typeof BUILTIN_FEATURE_KEYS)[number];

export function isKnownBuiltinFeature(key: string): key is BuiltinFeatureKey {
  return (BUILTIN_FEATURE_KEYS as readonly string[]).includes(key);
}

export const findStateRow = async (
  guildId: string | null,
  featureKey: string,
): Promise<BotFeatureStateRow | null> => {
  // null（operator default）對應 DB 的 '' sentinel
  const row = await BotFeatureState.findOne({
    where: { featureKey, guildId: guildId ?? "" },
  });
  return row ? rowOf(row) : null;
};

export const findAllStateRows = async (): Promise<BotFeatureStateRow[]> => {
  const rows = await BotFeatureState.findAll();
  return rows.map(rowOf);
};

export const findStateRowsByGuild = async (
  guildId: string,
): Promise<BotFeatureStateRow[]> => {
  const rows = await BotFeatureState.findAll({ where: { guildId } });
  return rows.map(rowOf);
};

export const upsertStateRow = async (
  guildId: string | null,
  featureKey: string,
  enabled: boolean,
): Promise<BotFeatureStateRow> => {
  const existing = await findStateRow(guildId, featureKey);
  if (existing) {
    const m = await BotFeatureState.findByPk(existing.id);
    if (m) {
      await m.update({ enabled });
      return rowOf(m);
    }
  }
  const created = await BotFeatureState.create({
    guildId: guildId ?? "",
    featureKey,
    enabled,
  });
  return rowOf(created);
};

/**
 * Resolve effective enabled state for a feature in a specific guild.
 * Precedence:
 *   1. (guildId, featureKey) row → use its `enabled`
 *   2. (NULL, featureKey) row    → operator default
 *   3. true                       → built-ins default ON unless told otherwise
 *
 * Falls back to true on DB error so a transient outage doesn't black
 * out every feature; the next call after recovery sees the real state.
 */
export const resolveBuiltinFeatureEnabled = async (
  featureKey: string,
  guildId: string | null,
): Promise<boolean> => {
  try {
    if (guildId !== null) {
      const perGuild = await findStateRow(guildId, featureKey);
      if (perGuild) return perGuild.enabled;
    }
    const def = await findStateRow(null, featureKey);
    if (def) return def.enabled;
    return true;
  } catch {
    return true;
  }
};
