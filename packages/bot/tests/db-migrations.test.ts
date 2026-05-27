/**
 * Smoke test for the umzug-backed migration runner. We don't load the
 * bot's real Sequelize instance (depends on sqlite3 native + .env);
 * an in-memory SQLite is enough to prove that:
 *
 *   1. SequelizeMeta is created on first run
 *   2. The baseline 000-migrate-legacy-expires-at migration is picked
 *      up by the file glob
 *   3. Re-running runMigrations is idempotent (no second apply)
 */

import { describe, expect, it } from "vitest";
import { Sequelize, DataTypes } from "sequelize";
import { buildUmzug } from "../src/db-migrations.js";

describe("db-migrations runner", () => {
  it("applies pending migrations exactly once", async () => {
    const sequelize = new Sequelize("sqlite::memory:", { logging: false });
    // The 000 baseline migration imports behavior-session.model which
    // expects a `behavior_sessions` table to exist for the legacy
    // scan. Create the minimal shape so the SELECT doesn't error.
    sequelize.define(
      "BehaviorSession",
      {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        ownerId: { type: DataTypes.STRING, allowNull: false },
        scope: { type: DataTypes.STRING, allowNull: false },
        scopeKey: { type: DataTypes.STRING, allowNull: false },
        category: { type: DataTypes.STRING, allowNull: false },
        slug: { type: DataTypes.STRING, allowNull: false },
        startedAt: { type: DataTypes.STRING, allowNull: false },
        expiresAt: { type: DataTypes.STRING, allowNull: true },
        endedAt: { type: DataTypes.STRING, allowNull: true },
        endedReason: { type: DataTypes.STRING, allowNull: true },
      },
      { tableName: "behavior_sessions", timestamps: false },
    );
    await sequelize.sync();

    const umzug = buildUmzug(sequelize);
    const firstPass = await umzug.up();
    expect(firstPass.length).toBeGreaterThan(0);
    expect(firstPass.map((m) => m.name)).toContain(
      "000-migrate-legacy-expires-at",
    );

    // Second pass should be a no-op.
    const secondPass = await umzug.up();
    expect(secondPass.length).toBe(0);

    // SequelizeMeta records the applied migration.
    const executed = await umzug.executed();
    expect(executed.map((m) => m.name)).toContain(
      "000-migrate-legacy-expires-at",
    );

    await sequelize.close();
  });
});
