import { DataTypes, Op } from "sequelize";
import { sequelize } from "../../../db.js";
import { Behavior } from "./behavior.model.js";

/**
 * BH-6.1 — per-behavior forward 統計。admin UI 用來回答「這條 behavior
 * 上次什麼時候動過、最近健不健康」，不是計費級的精確計數（寫入失敗
 * 靜默吞掉，不能影響 relay 路徑）。
 */
export const BehaviorStat = sequelize.define(
  "BehaviorStat",
  {
    behaviorId: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: { model: Behavior, key: "id" },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    lastFiredAt: { type: DataTypes.STRING, allowNull: true },
    successCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    failureCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    /** 連續失敗數 — 成功即歸零；UI 以此標健康警示（BH-6.4）。 */
    consecutiveFailures: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    lastErrorAt: { type: DataTypes.STRING, allowNull: true },
  },
  { tableName: "behavior_stats", timestamps: true },
);

export interface BehaviorStatRow {
  behaviorId: number;
  lastFiredAt: string | null;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

function rowOf(model: InstanceType<typeof BehaviorStat>): BehaviorStatRow {
  return {
    behaviorId: model.getDataValue("behaviorId") as number,
    lastFiredAt: (model.getDataValue("lastFiredAt") as string | null) ?? null,
    successCount: (model.getDataValue("successCount") as number) ?? 0,
    failureCount: (model.getDataValue("failureCount") as number) ?? 0,
    consecutiveFailures:
      (model.getDataValue("consecutiveFailures") as number) ?? 0,
    lastError: (model.getDataValue("lastError") as string | null) ?? null,
    lastErrorAt: (model.getDataValue("lastErrorAt") as string | null) ?? null,
  };
}

/**
 * 記一次 forward 結果。relay 路徑上呼叫——任何 DB 失敗都不可外洩，
 * caller 不需要 try/catch。
 */
export async function recordForwardOutcome(
  behaviorId: number,
  ok: boolean,
  error?: string | null,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    const [row] = await BehaviorStat.findOrCreate({
      where: { behaviorId },
      defaults: { behaviorId },
    });
    if (ok) {
      await row.update({
        lastFiredAt: now,
        successCount: (row.getDataValue("successCount") as number) + 1,
        consecutiveFailures: 0,
      });
    } else {
      await row.update({
        lastFiredAt: now,
        failureCount: (row.getDataValue("failureCount") as number) + 1,
        consecutiveFailures:
          (row.getDataValue("consecutiveFailures") as number) + 1,
        lastError: (error ?? "unknown").slice(0, 500),
        lastErrorAt: now,
      });
    }
  } catch {
    // stats are best-effort; never break the relay path
  }
}

export async function findStatsBulk(
  behaviorIds: number[],
): Promise<Map<number, BehaviorStatRow>> {
  if (behaviorIds.length === 0) return new Map();
  const rows = await BehaviorStat.findAll({
    where: { behaviorId: { [Op.in]: behaviorIds } },
  });
  return new Map(rows.map((r) => [r.getDataValue("behaviorId") as number, rowOf(r)]));
}
