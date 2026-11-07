import { DataTypes, Op } from "sequelize";
import { sequelize } from "../../../db.js";
import { BehaviorDefinition } from "./behavior-definition.model.js";

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
      references: { model: BehaviorDefinition, key: "id" },
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

type CounterColumn = "successCount" | "failureCount" | "consecutiveFailures";

/**
 * `column = column + 1`，在 DB 內遞增，不經過讀回的舊值。欄位名直接當
 * DB 欄位用——這個 model 沒有 `field:` / `underscored` 對應。
 */
function plusOne(column: CounterColumn) {
  const quoted = sequelize.getQueryInterface().quoteIdentifier(column);
  return sequelize.literal(`${quoted} + 1`);
}

/**
 * 記一次 forward 結果。relay 路徑上呼叫——任何 DB 失敗都不可外洩，
 * caller 不需要 try/catch。
 *
 * 兩句各自原子的陳述句，同一 behavior 併發觸發也不會少算：
 *   1. 行不存在就建一列全 0 的（SQLite `INSERT OR IGNORE` / Postgres
 *      `ON CONFLICT DO NOTHING`），第一次觸發的併發建行不會互撞；
 *   2. 計數以 `column + 1` 在 DB 內遞增，而不是讀出來加 1 再寫回。
 */
export async function recordForwardOutcome(
  behaviorId: number,
  ok: boolean,
  error?: string | null,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    await BehaviorStat.bulkCreate([{ behaviorId }], { ignoreDuplicates: true });
    await BehaviorStat.update(
      ok
        ? {
            lastFiredAt: now,
            successCount: plusOne("successCount"),
            consecutiveFailures: 0,
          }
        : {
            lastFiredAt: now,
            failureCount: plusOne("failureCount"),
            consecutiveFailures: plusOne("consecutiveFailures"),
            lastError: (error ?? "unknown").slice(0, 500),
            lastErrorAt: now,
          },
      { where: { behaviorId } },
    );
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
