/**
 * PD-4.3 — configSchemaVersion: the manifest config_schema_version a
 * plugin's admin config was last SAVED under, so the admin UI can warn
 * when stored values predate the current schema. It lives on the plugins
 * row (one value per plugin); migration 009 relocated it there from the
 * per-row plugin_configs column added by migration 008.
 *
 * Covers migration 009 (plugin_configs → plugins, idempotent + reversible)
 * and the stamp/read helper.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
});

import { DataTypes } from "sequelize";
import { sequelize } from "../src/db.js";
import {
  Plugin,
  findPluginById,
  setPluginConfigSchemaVersion,
} from "../src/modules/plugin-system/models/plugin.model.js";
import {
  up,
  down,
} from "../src/migrations/009-plugin-config-schema-version-to-plugins.js";
// Register the plugin_configs model so sync() creates that table — the 009
// migration test adds/removes its configSchemaVersion column.
import "../src/modules/plugin-system/models/plugin-config.model.js";

const qi = () => sequelize.getQueryInterface();
const runUp = () =>
  (up as (c: { context: unknown }) => Promise<void>)({ context: qi() });
const runDown = () =>
  (down as (c: { context: unknown }) => Promise<void>)({ context: qi() });

async function pluginsHasColumn(): Promise<boolean> {
  const table = await qi().describeTable("plugins");
  return Boolean(table["configSchemaVersion"]);
}
async function configsHasColumn(): Promise<boolean> {
  const table = await qi().describeTable("plugin_configs");
  return Boolean(table["configSchemaVersion"]);
}

async function makePlugin(): Promise<number> {
  const p = await Plugin.create({
    pluginKey: "k",
    name: "K",
    version: "1.0.0",
    url: "http://x",
    manifestJson: "{}",
    tokenHash: "h",
    status: "active",
    enabled: true,
  });
  return p.getDataValue("id") as number;
}

beforeEach(async () => {
  // Rebuild the schema fresh each case: migration 009 recreates
  // plugin_configs via removeColumn (sqlite has no native DROP COLUMN), so
  // a full sync is the clean baseline that can't inherit a mangled table.
  await sequelize.sync({ force: true });
});

describe("009 migration: configSchemaVersion plugin_configs → plugins", () => {
  it("moves the column to plugins, is idempotent, and reverses", async () => {
    // Simulate a post-008 / pre-009 DB: column on plugin_configs, not plugins.
    await qi().removeColumn("plugins", "configSchemaVersion");
    await qi().addColumn("plugin_configs", "configSchemaVersion", {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
    expect(await pluginsHasColumn()).toBe(false);
    expect(await configsHasColumn()).toBe(true);

    await runUp();
    expect(await pluginsHasColumn()).toBe(true);
    expect(await configsHasColumn()).toBe(false);

    await runUp(); // idempotent — no throw, still converged
    expect(await pluginsHasColumn()).toBe(true);
    expect(await configsHasColumn()).toBe(false);

    await runDown();
    expect(await pluginsHasColumn()).toBe(false);
    expect(await configsHasColumn()).toBe(true);
  });
});

describe("setPluginConfigSchemaVersion", () => {
  it("stamps and reads back the per-plugin version", async () => {
    const id = await makePlugin();
    expect((await findPluginById(id))?.configSchemaVersion).toBeNull();

    await setPluginConfigSchemaVersion(id, 3);
    expect((await findPluginById(id))?.configSchemaVersion).toBe(3);

    // Re-stamping replaces, never accumulates.
    await setPluginConfigSchemaVersion(id, 4);
    expect((await findPluginById(id))?.configSchemaVersion).toBe(4);

    // null clears the staleness signal.
    await setPluginConfigSchemaVersion(id, null);
    expect((await findPluginById(id))?.configSchemaVersion).toBeNull();
  });

  it("returns null for a missing plugin", async () => {
    expect(await setPluginConfigSchemaVersion(999999, 2)).toBeNull();
  });
});
