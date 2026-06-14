/**
 * PD-4.3 — plugin_configs.configSchemaVersion: records the manifest
 * config_schema_version a plugin's admin config was last saved under, so
 * the admin UI can warn when stored values predate the current schema.
 *
 * Covers migration 008 (adds the column to an existing DB, idempotent,
 * reversible) and the stamp/read helpers (admin rows only; max-of-set;
 * plugin-self KV untouched).
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
});

import { sequelize } from "../src/db.js";
import {
  PluginConfig,
  upsertConfigKey,
  setAdminConfigSchemaVersion,
  getAdminConfigSchemaVersion,
} from "../src/modules/plugin-system/models/plugin-config.model.js";
import { up, down } from "../src/migrations/008-plugin-config-schema-version.js";

const qi = () => sequelize.getQueryInterface();
const runUp = () =>
  (up as (c: { context: unknown }) => Promise<void>)({ context: qi() });
const runDown = () =>
  (down as (c: { context: unknown }) => Promise<void>)({ context: qi() });

async function hasColumn(): Promise<boolean> {
  const table = await qi().describeTable("plugin_configs");
  return Boolean(table["configSchemaVersion"]);
}

const PLUGIN = 7;

beforeEach(async () => {
  // Rebuild the table fresh each case: the migration test below recreates
  // plugin_configs via removeColumn/addColumn (sqlite has no native DROP
  // COLUMN), so a full sync is the clean baseline that can't inherit a
  // mangled unique index from a prior case.
  await sequelize.sync({ force: true });
});

describe("008 migration", () => {
  it("adds the column to an existing DB, is idempotent, and reverses", async () => {
    // Simulate a pre-008 DB.
    await qi().removeColumn("plugin_configs", "configSchemaVersion");
    expect(await hasColumn()).toBe(false);

    await runUp();
    expect(await hasColumn()).toBe(true);
    await runUp(); // idempotent — no throw, still present
    expect(await hasColumn()).toBe(true);

    await runDown();
    expect(await hasColumn()).toBe(false);
    await runDown(); // idempotent
    expect(await hasColumn()).toBe(false);

    // Restore for the remaining cases.
    await runUp();
  });
});

describe("config schema version stamp/read", () => {
  it("stamps every admin row and reads back the version; null when none", async () => {
    expect(await getAdminConfigSchemaVersion(PLUGIN)).toBeNull();

    await upsertConfigKey(PLUGIN, "a", "1", "admin");
    await upsertConfigKey(PLUGIN, "b", "2", "admin");
    await setAdminConfigSchemaVersion(PLUGIN, 3);

    expect(await getAdminConfigSchemaVersion(PLUGIN)).toBe(3);

    // A later save under a newer schema re-stamps the set.
    await setAdminConfigSchemaVersion(PLUGIN, 4);
    expect(await getAdminConfigSchemaVersion(PLUGIN)).toBe(4);
  });

  it("leaves plugin-self KV rows untouched (admin-only signal)", async () => {
    await upsertConfigKey(PLUGIN, "kv", "x", "plugin");
    await upsertConfigKey(PLUGIN, "a", "1", "admin");
    await setAdminConfigSchemaVersion(PLUGIN, 5);

    // The plugin-self row never gets a version → not counted.
    const kv = await PluginConfig.findOne({
      where: { pluginId: PLUGIN, key: "kv" },
    });
    expect(kv?.getDataValue("configSchemaVersion")).toBeNull();
    expect(await getAdminConfigSchemaVersion(PLUGIN)).toBe(5);
  });

  it("null version (manifest declares none) clears the signal", async () => {
    await upsertConfigKey(PLUGIN, "a", "1", "admin");
    await setAdminConfigSchemaVersion(PLUGIN, 2);
    expect(await getAdminConfigSchemaVersion(PLUGIN)).toBe(2);
    await setAdminConfigSchemaVersion(PLUGIN, null);
    expect(await getAdminConfigSchemaVersion(PLUGIN)).toBeNull();
  });
});
