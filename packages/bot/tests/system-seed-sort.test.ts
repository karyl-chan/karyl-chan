/**
 * system-seed self-heal: 確保 (a) 新建 3 條 system row 的 sortOrder 對齊
 * seed；(b) 既有 row 但 sortOrder 還在舊值（legacy: manual=-999, break=-998）
 * 會被 self-heal 拉到新值（break=-999, manual=-998）。
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
import {
  BehaviorScopeTab,
  FIXED_TAB_IDS,
} from "../src/modules/behavior/models/behavior-scope-tab.model.js";
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
  it("fresh boot: rows seeded in protected-first order (login, break, manual)", async () => {
    const result = await ensureSystemBehaviors();
    expect(result.created.sort()).toEqual(
      ["admin-login", "break", "manual"].sort(),
    );
    const sorted = await readSorted();
    expect(sorted.map((s) => s.systemKey)).toEqual([
      "admin-login",
      "break",
      "manual",
    ]);
    expect(sorted.map((s) => s.sortOrder)).toEqual([-1000, -999, -998]);
  });

  it("legacy rows (manual=-999, break=-998) self-heal on next boot", async () => {
    // Boot once to create the rows.
    await ensureSystemBehaviors();
    // Then mimic an old install by reverting to the legacy ordering.
    await Behavior.update(
      { sortOrder: -999 },
      { where: { systemKey: "manual" } },
    );
    await Behavior.update(
      { sortOrder: -998 },
      { where: { systemKey: "break" } },
    );
    // Re-run seed; self-heal should pull both back to current values.
    await ensureSystemBehaviors();
    const sorted = await readSorted();
    expect(sorted.map((s) => s.systemKey)).toEqual([
      "admin-login",
      "break",
      "manual",
    ]);
    expect(sorted.map((s) => s.sortOrder)).toEqual([-1000, -999, -998]);
  });

  it("idempotent: a second run with rows already at seed values is a no-op", async () => {
    await ensureSystemBehaviors();
    const first = await readSorted();
    const result = await ensureSystemBehaviors();
    expect(result.created).toEqual([]);
    expect(result.existing.sort()).toEqual(
      ["admin-login", "break", "manual"].sort(),
    );
    const second = await readSorted();
    expect(second).toEqual(first);
  });

  it("self-heal does not touch other system fields when only sortOrder differs", async () => {
    await ensureSystemBehaviors();
    const tabId = (
      await Behavior.findOne({ where: { systemKey: "break" } })
    )?.getDataValue("scopeTabId");
    expect(tabId).toBe(FIXED_TAB_IDS.all_bot_dms);

    await Behavior.update(
      { sortOrder: -998 },
      { where: { systemKey: "break" } },
    );
    await ensureSystemBehaviors();
    const row = await Behavior.findOne({ where: { systemKey: "break" } });
    expect(row?.getDataValue("sortOrder")).toBe(-999);
    expect(row?.getDataValue("scopeTabId")).toBe(FIXED_TAB_IDS.all_bot_dms);
  });
});

// Avoid an unused-import warning on BehaviorScopeTab — referenced for type imports.
void BehaviorScopeTab;
