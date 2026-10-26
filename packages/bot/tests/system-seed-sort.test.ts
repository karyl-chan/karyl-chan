/**
 * system-seed self-heal: 確保 (a) 新建的 system row（admin-login，ADR 0003
 * 後唯一的 system behavior）sortOrder 對齊 seed；(b) 既有 row 的 sortOrder
 * 漂走時，下次開機 self-heal 拉回 seed 值。
 *
 * Admin 用 UI 改不到 system row 的 sortOrder（reorder endpoint 只接受
 * source='custom'），所以這層 self-heal 不會踩到管理員手動的調整。
 */

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { FIXED_TAB_IDS } from "../src/modules/behavior/models/behavior-scope-tab.model.js";
import { ensureFixedScopeTabs } from "../src/modules/behavior/scope-tab-seed.service.js";
import { ensureSystemBehaviors } from "../src/modules/behavior/system-seed.service.js";

beforeAll(async () => {
  await sequelize.sync({ force: true });
  await ensureFixedScopeTabs();
});

beforeEach(async () => {
  await Behavior.destroy({ where: {} });
});

async function readSorted(): Promise<
  { systemKey: string; sortOrder: number }[]
> {
  const rows = await Behavior.findAll({
    where: { source: "system" },
    order: [["sortOrder", "ASC"]],
  });
  return rows.map((r) => ({
    systemKey: r.getDataValue("systemKey") as string,
    sortOrder: r.getDataValue("sortOrder") as number,
  }));
}

describe("system-seed sort order", () => {
  it("fresh boot: seeds only the login row, first in order", async () => {
    const result = await ensureSystemBehaviors();
    expect(result.created).toEqual(["admin-login"]);
    expect(await readSorted()).toEqual([
      { systemKey: "admin-login", sortOrder: -1000 },
    ]);
  });

  it("a drifted sortOrder self-heals on next boot", async () => {
    await ensureSystemBehaviors();
    await Behavior.update(
      { sortOrder: 5 },
      { where: { systemKey: "admin-login" } },
    );
    await ensureSystemBehaviors();
    expect(await readSorted()).toEqual([
      { systemKey: "admin-login", sortOrder: -1000 },
    ]);
  });

  it("idempotent: a second run with the row already at seed values is a no-op", async () => {
    await ensureSystemBehaviors();
    const first = await readSorted();
    const result = await ensureSystemBehaviors();
    expect(result.created).toEqual([]);
    expect(result.existing).toEqual(["admin-login"]);
    expect(await readSorted()).toEqual(first);
  });

  it("self-heal does not touch other system fields when only sortOrder differs", async () => {
    await ensureSystemBehaviors();
    await Behavior.update(
      { sortOrder: 5 },
      { where: { systemKey: "admin-login" } },
    );
    await ensureSystemBehaviors();
    const row = await Behavior.findOne({ where: { systemKey: "admin-login" } });
    expect(row?.getDataValue("sortOrder")).toBe(-1000);
    expect(row?.getDataValue("scopeTabId")).toBe(FIXED_TAB_IDS.all_bot_dms);
  });
});
