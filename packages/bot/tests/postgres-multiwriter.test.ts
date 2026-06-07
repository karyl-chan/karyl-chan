/**
 * PR-2.1 — Postgres multi-writer acceptance.
 *
 * Under a multi-shard deployment with DB_URL=postgres, every shard runs
 * the idempotent boot seeds concurrently and admin/auth writes can land on
 * any shard via the load balancer. This test proves the real write paths
 * are correct under genuine concurrent writers against a REAL Postgres —
 * no lost updates, no duplicate rows, no unhandled unique-violation crash.
 *
 * Gated on TEST_PG_URL so the normal `pnpm test` run (no Postgres) skips it
 * and stays green. To run it:
 *
 *   docker run -d --name pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=karyltest \
 *     -p 55432:5432 postgres:16
 *   TEST_PG_URL=postgres://postgres:test@localhost:55432/karyltest \
 *     pnpm test postgres-multiwriter
 *
 * Why these paths: under guild-sharding each shard owns disjoint guilds, so
 * guild-scoped writes don't collide across shards. The genuine cross-shard
 * collision surface is (a) the boot seeds every shard runs and (b) the
 * findOrCreate sites reachable from any shard. We exercise both.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Sequelize } from "sequelize";

const PG_URL = process.env.TEST_PG_URL;
const WRITERS = 24; // simulate 24 concurrent shard/request writers

describe.skipIf(!PG_URL)("PR-2.1 Postgres multi-writer", () => {
  let sequelize: Sequelize;
  let seedDefaultRoles: () => Promise<void>;
  let grantRoleCapability: (role: string, cap: string) => Promise<void>;
  let AdminRole: any;
  let AdminRoleCapability: any;

  beforeAll(async () => {
    // MUST be set before db.js is imported — it builds the Sequelize
    // instance from these at module-load time. Hence dynamic imports.
    process.env.DB_URL = PG_URL!;
    process.env.BOT_TOKEN ??= "test-token";
    process.env.ENCRYPTION_KEY ??= "0".repeat(64);
    process.env.JWT_SECRET ??= "0".repeat(64);

    const db = await import("../src/db.js");
    sequelize = db.sequelize;
    expect(db.dbDialect).toBe("postgres");

    AdminRole = (await import("../src/modules/admin/models/admin-role.model.js"))
      .AdminRole;
    AdminRoleCapability = (
      await import("../src/modules/admin/models/admin-role-capability.model.js")
    ).AdminRoleCapability;
    const svc = await import("../src/modules/admin/authorized-user.service.js");
    seedDefaultRoles = svc.seedDefaultRoles;
    grantRoleCapability = svc.grantRoleCapability as typeof grantRoleCapability;

    // Fresh schema on the throwaway DB.
    await sequelize.sync({ force: true });
  }, 60_000);

  afterAll(async () => {
    await sequelize?.close();
  });

  it("concurrent boot seeds are idempotent (no dup roles, no crash)", async () => {
    // Every shard runs seedDefaultRoles() at boot — fire them all at once.
    await Promise.all(Array.from({ length: WRITERS }, () => seedDefaultRoles()));
    const total = await AdminRole.count();
    const distinct: Array<{ name: string }> = await AdminRole.findAll({
      attributes: ["name"],
      raw: true,
    });
    const names = new Set(distinct.map((r) => r.name));
    // bulkCreate(ignoreDuplicates) → exactly one row per default role.
    expect(total).toBe(names.size);
    expect(total).toBeGreaterThan(0);

    // Running it again must not change the count (idempotent).
    await Promise.all(Array.from({ length: WRITERS }, () => seedDefaultRoles()));
    expect(await AdminRole.count()).toBe(total);
  });

  it("concurrent findOrCreate on a composite PK yields exactly one row", async () => {
    // grantRoleCapability() is one of the three real findOrCreate sites;
    // its where {role, capability} is backed by the composite PK, so a
    // racing INSERT hits a unique violation that Sequelize catches and
    // re-finds. Prove it: many writers, one key, one row.
    await AdminRole.upsert({ name: "pr2-role", description: "test" });

    await Promise.all(
      Array.from({ length: WRITERS }, () =>
        grantRoleCapability("pr2-role", "pr2:cap"),
      ),
    );

    const rows = await AdminRoleCapability.count({
      where: { role: "pr2-role", capability: "pr2:cap" },
    });
    expect(rows).toBe(1);
  });

  it("concurrent upsert converges without lost-update crash", async () => {
    // AdminRole.upsert → Postgres INSERT ... ON CONFLICT DO UPDATE.
    // Many writers racing the same PK with different payloads must all
    // succeed and leave exactly one row whose value is one of the writes.
    const writes = Array.from({ length: WRITERS }, (_, i) =>
      AdminRole.upsert({ name: "pr2-upsert", description: `desc-${i}` }),
    );
    await expect(Promise.all(writes)).resolves.toBeDefined();

    const rows = await AdminRole.findAll({
      where: { name: "pr2-upsert" },
      raw: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toMatch(/^desc-\d+$/);
  });
});
