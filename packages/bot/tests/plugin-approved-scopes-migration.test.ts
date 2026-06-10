/**
 * PM-3.1 migration: 001-plugin-approved-rpc-scopes adds
 * `plugins.approvedRpcScopes` to existing DBs. Fresh installs already
 * have it from the model via sync(), so the migration must no-op there.
 * Coverage:
 *   1. existing DB missing the column → up() adds it
 *   2. up() is idempotent (column already present → no-op, no throw)
 *   3. down() removes it and is idempotent
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
});

import { sequelize } from "../src/db.js";
import { Plugin } from "../src/modules/plugin-system/models/plugin.model.js";
import {
  up,
  down,
} from "../src/migrations/001-plugin-approved-rpc-scopes.js";

const qi = () => sequelize.getQueryInterface();
const runUp = () => (up as (c: { context: unknown }) => Promise<void>)({ context: qi() });
const runDown = () => (down as (c: { context: unknown }) => Promise<void>)({ context: qi() });

async function hasColumn(): Promise<boolean> {
  const table = await qi().describeTable("plugins");
  return Boolean(table["approvedRpcScopes"]);
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  // Ensure a clean baseline with the column present (fresh-install shape).
  if (!(await hasColumn())) {
    await qi().addColumn("plugins", "approvedRpcScopes", {
      type: (await import("sequelize")).DataTypes.TEXT,
      allowNull: true,
    });
  }
});

describe("001-plugin-approved-rpc-scopes", () => {
  it("1. adds the column to an existing DB that lacks it", async () => {
    await qi().removeColumn("plugins", "approvedRpcScopes");
    expect(await hasColumn()).toBe(false);
    await runUp();
    expect(await hasColumn()).toBe(true);
  });

  it("2. up() is a no-op when the column already exists (fresh install)", async () => {
    expect(await hasColumn()).toBe(true);
    await expect(runUp()).resolves.toBeUndefined();
    expect(await hasColumn()).toBe(true);
  });

  it("3. down() removes the column and is idempotent", async () => {
    await runDown();
    expect(await hasColumn()).toBe(false);
    // Second down() must not throw on the already-absent column.
    await expect(runDown()).resolves.toBeUndefined();
  });

  it("4. the model can read/write the column round-trip after up()", async () => {
    if (!(await hasColumn())) await runUp();
    await Plugin.destroy({ where: {} });
    const created = await Plugin.create({
      pluginKey: "m-plugin",
      name: "M",
      version: "1.0.0",
      url: "http://localhost:1",
      manifestJson: "{}",
      tokenHash: "h",
      status: "active",
      enabled: true,
      approvedRpcScopes: JSON.stringify(["a.b"]),
    } as Record<string, unknown>);
    const reread = await Plugin.findByPk(created.getDataValue("id") as number);
    expect(reread?.getDataValue("approvedRpcScopes")).toBe('["a.b"]');
  });
});
