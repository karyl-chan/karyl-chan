import { DataTypes, Op } from "sequelize";
import { sequelize } from "../../../db.js";
import { config } from "../../../config.js";
import { botEventLog } from "../../bot-events/bot-event-log.js";
import { Behavior } from "./behavior.model.js";

// behavior-session.model.ts：v2 schema 不變（PK=userId，FK=behaviorId→behaviors.id）
// v2 behaviors 表名稱相同，FK 仍正確對齊。

/**
 * Active continuous-forward state for a user. Persisted in DB so a bot
 * restart resumes forwarding on the next DM from that user — the
 * contract is "if a session row exists, the next inbound DM gets POSTed
 * to that behavior's webhook regardless of triggers."
 *
 * One row per user (PK = userId): a user can only run one continuous
 * session at a time. Starting a new continuous behavior while a session
 * is active is forbidden by the event handler — the user must /break
 * first or the prior webhook must reply with [BEHAVIOR:END].
 *
 * `channelId` is captured so the relay-back path can DM the user even
 * if Discord's cache cold-misses on a subsequent restart.
 */
export const BehaviorSession = sequelize.define(
  "BehaviorSession",
  {
    userId: {
      type: DataTypes.STRING,
      primaryKey: true,
    },
    behaviorId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: Behavior, key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    channelId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    startedAt: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    // 用 STRING 儲存 ISO 8601 字串。SQLite 無原生 DATE 型別，
    // 用 DataTypes.DATE 配 startSession 寫入 toISOString() 時，
    // Sequelize 在不同情境會回 Date 或 string，rowOf 必須防禦兩種型別。
    // 用 STRING 則 in/out 都是 ISO 字串，lexicographic 比較與 Op.lt/gt
    // 仍正確（ISO 8601 排序語意一致）。
    expiresAt: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    tableName: "behavior_sessions",
    timestamps: true,
    indexes: [
      {
        name: "behavior_sessions_behavior_idx",
        fields: ["behaviorId"],
      },
      {
        name: "behavior_sessions_expires_at_idx",
        fields: ["expiresAt"],
        // 部分索引：expiresAt IS NOT NULL
        where: { expiresAt: { [Op.ne]: null } },
      },
    ],
  },
);

export interface BehaviorSessionRow {
  userId: string;
  behaviorId: number;
  channelId: string;
  startedAt: string;
  /** ISO string when the session expires. null = never expires (legacy rows). */
  expiresAt: string | null;
}

function rowOf(
  model: InstanceType<typeof BehaviorSession>,
): BehaviorSessionRow {
  return {
    userId: model.getDataValue("userId") as string,
    behaviorId: model.getDataValue("behaviorId") as number,
    channelId: model.getDataValue("channelId") as string,
    startedAt: model.getDataValue("startedAt") as string,
    expiresAt: (model.getDataValue("expiresAt") as string | null) ?? null,
  };
}

export const findActiveSession = async (
  userId: string,
): Promise<BehaviorSessionRow | null> => {
  // ISO 8601 字串可 lexicographic 比較（與 DateTime 排序語意一致）。
  // 用 string 而非 Date 物件以對齊 column type，避免 Sequelize 對 STRING
  // 欄位收到 Date 時的隱式轉型行為不一致。
  const nowIso = new Date().toISOString();

  // 先順手清掉已過期的 session（避免殭屍 row 無限累積）
  await BehaviorSession.destroy({
    where: {
      userId,
      expiresAt: { [Op.lt]: nowIso },
    },
  });

  // 讀取 session：只回傳尚未過期（expiresAt IS NULL OR expiresAt > now）
  const row = await BehaviorSession.findOne({
    where: {
      userId,
      [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: nowIso } }],
    },
  });

  return row ? rowOf(row) : null;
};

export const startSession = async (
  userId: string,
  behaviorId: number,
  channelId: string,
): Promise<BehaviorSessionRow> => {
  const startedAt = new Date().toISOString();
  const expireMs = config.behavior.sessionExpireHours * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + expireMs).toISOString();
  await BehaviorSession.upsert({
    userId,
    behaviorId,
    channelId,
    startedAt,
    expiresAt,
  });
  return { userId, behaviorId, channelId, startedAt, expiresAt };
};

export const endSession = async (userId: string): Promise<boolean> => {
  const removed = await BehaviorSession.destroy({ where: { userId } });
  return removed > 0;
};

export const endSessionsForBehavior = async (
  behaviorId: number,
): Promise<void> => {
  await BehaviorSession.destroy({ where: { behaviorId } });
};

/**
 * One-shot migration: rewrite legacy `expiresAt` values stored under
 * the previous `DataTypes.DATE` column type.
 *
 * Why this exists: Sequelize's SQLite DATE adapter stored timestamps as
 * `"YYYY-MM-DD HH:MM:SS.sss +00:00"` (space-separated, explicit offset).
 * The column is now STRING with `new Date().toISOString()` writers
 * (`"YYYY-MM-DDTHH:MM:SS.sssZ"`, T-separated, Zulu suffix). Empirically
 * (verified via a probe test):
 *   ' ' (0x20) < 'T' (0x54)
 * so legacy rows lexicographically compare as ALWAYS LESS than any new
 * `nowIso`. findActiveSession's preflight `Op.lt` cleanup would silently
 * destroy every pre-existing session on first lookup post-deploy.
 *
 * Idempotent: matches only rows whose `expiresAt` contains a literal
 * space (legacy format) and rewrites to canonical ISO. Rows already in
 * ISO format don't have a space and are skipped. Rows with malformed
 * dates that `new Date(...)` can't parse are left alone (parse fails →
 * NaN → skip).
 *
 * Call from boot before any findActiveSession runs.
 */
export async function migrateLegacyExpiresAt(): Promise<number> {
  const legacy = await BehaviorSession.findAll({
    where: { expiresAt: { [Op.like]: "% %" } },
  });
  let migrated = 0;
  for (const row of legacy) {
    const raw = row.getDataValue("expiresAt") as string | null;
    if (raw == null) continue;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) continue;
    await row.update({ expiresAt: parsed.toISOString() });
    migrated++;
  }
  if (migrated > 0) {
    botEventLog.record(
      "info",
      "bot",
      `behavior-session: 將 ${migrated} 條舊格式 expiresAt 重寫為 ISO 8601`,
      { migrated },
    );
  }
  return migrated;
}
