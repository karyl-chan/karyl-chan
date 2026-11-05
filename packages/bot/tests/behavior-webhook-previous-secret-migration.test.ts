/**
 * Migration 012 (#99): an upgraded behavior_webhook_actions (created by
 * migration 011's sync before rotation existed) gains previousSecret /
 * previousSecretExpiresAt; existing rows keep their secret and have no
 * rotation in progress. Re-running is a no-op.
 */
import { vi, describe, it, expect, beforeAll } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
});

import { DataTypes, type QueryInterface } from "sequelize";
import { sequelize } from "../src/db.js";
import { up } from "../src/migrations/012-behavior-webhook-previous-secret.js";

const qi = (): QueryInterface => sequelize.getQueryInterface();
const runUp = () =>
  (up as (c: { context: unknown }) => Promise<void>)({ context: qi() });

beforeAll(async () => {
  // the table as migration 011 left it
  await qi().createTable("behavior_webhook_actions", {
    behaviorId: { type: DataTypes.INTEGER, primaryKey: true },
    url: { type: DataTypes.TEXT, allowNull: false },
    secret: { type: DataTypes.TEXT, allowNull: true },
    authMode: { type: DataTypes.STRING, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  const now = new Date();
  await qi().bulkInsert("behavior_webhook_actions", [
    { behaviorId: 1, url: "u", secret: "s", authMode: "hmac", createdAt: now, updatedAt: now },
  ]);
});

describe("migration 012", () => {
  it("adds the rotation columns, empty on existing rows", async () => {
    await runUp();
    const columns = await qi().describeTable("behavior_webhook_actions");
    expect(columns).toHaveProperty("previousSecret");
    expect(columns).toHaveProperty("previousSecretExpiresAt");
    const [row] = (await qi().select(null, "behavior_webhook_actions")) as Array<
      Record<string, unknown>
    >;
    expect(row).toMatchObject({
      secret: "s",
      authMode: "hmac",
      previousSecret: null,
      previousSecretExpiresAt: null,
    });
  });

  it("re-running is a no-op", async () => {
    await expect(runUp()).resolves.toBeUndefined();
  });
});
