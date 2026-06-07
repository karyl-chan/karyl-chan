/**
 * PR-2.2 — SQLite → Postgres data migration: type-correctness + sequence reset.
 *
 * Proves migrateData() lands SQLite's loosely-typed storage (0/1 booleans,
 * TEXT json, ISO-string timestamps) into Postgres's strict columns
 * correctly, and resets the identity sequence so the next insert doesn't
 * collide with copied PKs.
 *
 * Gated on TEST_PG_URL (skipped in the normal suite). Run with:
 *   TEST_PG_URL=postgres://postgres:test@localhost:55432/karyltest \
 *     pnpm test migrate-sqlite-to-pg
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Sequelize, QueryTypes } from "sequelize";
import { migrateData } from "../src/scripts/migrate-sqlite-to-pg.js";

const PG_URL = process.env.TEST_PG_URL;
const SQLITE_PATH = join(tmpdir(), `mig-test-${process.pid}.sqlite`);

describe.skipIf(!PG_URL)("PR-2.2 migrate-sqlite-to-pg", () => {
  let source: Sequelize;
  let target: Sequelize;

  beforeAll(async () => {
    source = new Sequelize({ dialect: "sqlite", storage: SQLITE_PATH, logging: false });
    target = new Sequelize(PG_URL!, { dialect: "postgres", logging: false });

    // Target schema (strict types) — as the bot's sync() would create it.
    await target.query('DROP TABLE IF EXISTS "MigDemo"');
    await target.query(
      `CREATE TABLE "MigDemo" (
         id     SERIAL PRIMARY KEY,
         flag   BOOLEAN NOT NULL,
         meta   JSONB,
         ts     TIMESTAMPTZ,
         name   TEXT
       )`,
    );

    // Source schema (SQLite loose types) + rows mimicking real storage:
    // booleans as 0/1, json as TEXT, timestamps as ISO strings.
    await source.query(
      `CREATE TABLE "MigDemo" (
         id INTEGER PRIMARY KEY, flag INTEGER, meta TEXT, ts TEXT, name TEXT
       )`,
    );
    await source.query(
      `INSERT INTO "MigDemo" (id, flag, meta, ts, name) VALUES
         (1, 1, '{"a":1}', '2026-06-07T10:00:00.000Z', 'alpha'),
         (2, 0, '{"b":[2,3]}', '2026-06-07T11:30:00.000Z', 'beta'),
         (3, 1, NULL, NULL, 'gamma')`,
    );
  }, 60_000);

  afterAll(async () => {
    await target?.query('DROP TABLE IF EXISTS "MigDemo"').catch(() => {});
    await source?.close();
    await target?.close();
    rmSync(SQLITE_PATH, { force: true });
  });

  it("copies rows with correct Postgres types and resets the sequence", async () => {
    const res = await migrateData(source, target);
    expect(res.copied["MigDemo"]).toBe(3);
    expect(res.sequencesReset).toContain("MigDemo.id");

    // Types landed strictly: boolean column is a real boolean, jsonb is an
    // object, timestamptz is a Date.
    const rows = await target.query<{
      id: number;
      flag: boolean;
      meta: unknown;
      ts: Date | null;
      name: string;
    }>('SELECT * FROM "MigDemo" ORDER BY id', { type: QueryTypes.SELECT });

    expect(rows).toHaveLength(3);
    expect(rows[0].flag).toBe(true);
    expect(rows[1].flag).toBe(false);
    expect(rows[0].meta).toEqual({ a: 1 });
    expect(rows[1].meta).toEqual({ b: [2, 3] });
    expect(rows[2].meta).toBeNull();
    expect(rows[0].ts).toBeInstanceOf(Date);
    expect(rows[2].ts).toBeNull();

    // Sequence reset: a fresh insert (no id) must get id = 4, not collide.
    const [inserted] = await target.query<{ id: number }>(
      `INSERT INTO "MigDemo" (flag, name) VALUES (true, 'delta') RETURNING id`,
      { type: QueryTypes.SELECT },
    );
    expect(inserted.id).toBe(4);
  });

  it("is row-level idempotent (ON CONFLICT DO NOTHING)", async () => {
    // Re-running the copy must not duplicate or error.
    const res = await migrateData(source, target);
    expect(res.copied["MigDemo"]).toBe(3);
    const count = await target.query<{ c: string }>(
      `SELECT COUNT(*)::int AS c FROM "MigDemo" WHERE id <= 3`,
      { type: QueryTypes.SELECT },
    );
    expect(Number(count[0].c)).toBe(3);
  });
});
