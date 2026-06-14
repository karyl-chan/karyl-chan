/**
 * PM-0.2 — schema-drift guard (dual-track).
 *
 * The bug class: `sequelize.sync()` only CREATEs missing tables, it never
 * ALTERs an existing one (see db-migrations.ts). So a fresh install gets
 * every column straight from the model, but a long-lived production DB
 * only gains a NEW column if a migration adds it. Add a column to a model
 * and forget the migration → fresh DBs are fine, production is missing the
 * column, and the route that reads it 500s in prod only.
 *
 * This test runs both tracks and asserts they converge:
 *   (a) fresh   — `sync({force})` → the model's full column set.
 *   (b) migrated— recreate the table at its FROZEN pre-migration shape,
 *                 run that table's column migrations, and assert the
 *                 result matches (a).
 *
 * The frozen OLD_* column sets below are a deliberate snapshot of a past
 * production schema. Do NOT add a column here when you add one to the
 * model — add a migration and wire it into the table's migration list.
 * That omission is exactly what turns track (b) red.
 *
 * Scope: the `plugins` table (migrations 001 + 007 add columns). Other
 * column-migration tables (e.g. `behaviors`: 004/005/006) extend the same
 * TABLES array; `behavior_sessions` (003) is a table-shape migration with
 * its own dedicated test (behavior-session-channel-pk-migration.test.ts).
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
});

import { DataTypes, type QueryInterface } from "sequelize";
import { sequelize } from "../src/db.js";
import { Plugin } from "../src/modules/plugin-system/models/plugin.model.js";
import { up as up001 } from "../src/migrations/001-plugin-approved-rpc-scopes.js";
import { up as up007 } from "../src/migrations/007-plugin-approved-global-event-subs.js";

const qi = (): QueryInterface => sequelize.getQueryInterface();

type MigrationUp = (ctx: { context: QueryInterface }) => Promise<void>;
const runMigration = (up: unknown) => (up as MigrationUp)({ context: qi() });

async function columnNames(table: string): Promise<string[]> {
  return Object.keys(await qi().describeTable(table)).sort();
}

/**
 * Frozen pre-migration column shape per table + the migrations that bring
 * it up to today. The column TYPES here only need to be valid for
 * createTable — the assertion compares column NAME sets, the axis the
 * "missing column in prod" bug lives on.
 */
const T = DataTypes;
const TABLES: {
  name: string;
  oldColumns: Record<string, unknown>;
  migrations: unknown[];
}[] = [
  {
    name: "plugins",
    // plugins as it stood before 001 (approvedRpcScopes) and 007
    // (approvedGlobalEventSubs).
    oldColumns: {
      id: { type: T.INTEGER, autoIncrement: true, primaryKey: true },
      pluginKey: { type: T.TEXT, allowNull: false },
      name: { type: T.TEXT, allowNull: false },
      version: { type: T.TEXT, allowNull: false },
      url: { type: T.TEXT, allowNull: false },
      manifestJson: { type: T.TEXT, allowNull: false },
      status: { type: T.TEXT, allowNull: false },
      tokenHash: { type: T.TEXT, allowNull: true },
      enabled: { type: T.BOOLEAN, allowNull: false, defaultValue: true },
      lastHeartbeatAt: { type: T.DATE, allowNull: true },
      setupSecretHash: { type: T.TEXT, allowNull: true },
      dispatchHmacKey: { type: T.TEXT, allowNull: true },
      createdAt: { type: T.DATE, allowNull: false },
      updatedAt: { type: T.DATE, allowNull: false },
    },
    migrations: [up001, up007],
  },
];

describe("PM-0.2 schema-drift: model columns are reachable on an old DB via migrations", () => {
  beforeEach(async () => {
    // Fresh, full-model schema — track (a).
    await sequelize.sync({ force: true });
  });

  for (const { name, oldColumns, migrations } of TABLES) {
    it(`${name}: a fresh sync and an old-DB + migrations converge on the same columns`, async () => {
      const fresh = await columnNames(name);

      // Sanity: the frozen snapshot must actually be OLDER than fresh —
      // i.e. the migrations have real columns to add. A snapshot that
      // already matches fresh would make this test vacuous (and silently
      // stop guarding new drift).
      expect(Object.keys(oldColumns).length).toBeLessThan(fresh.length);

      // Track (b): rebuild the table at its frozen pre-migration shape,
      // then let the migrations carry it forward.
      await qi().dropTable(name);
      await qi().createTable(name, oldColumns as Parameters<QueryInterface["createTable"]>[1]);
      for (const up of migrations) await runMigration(up);

      const migrated = await columnNames(name);
      expect(migrated).toEqual(fresh);
    });
  }

  // Guards the test itself: `Plugin` must be the model backing `plugins`,
  // so a fresh sync really did create the table we snapshot against.
  it("the Plugin model maps to the plugins table", () => {
    expect(Plugin.getTableName()).toBe("plugins");
  });
});
