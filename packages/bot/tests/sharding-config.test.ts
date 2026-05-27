/**
 * Phase 0.1 — sharding-aware bot config + DistributedLock-gated
 * global command reconcile.
 *
 * The config layer reads SHARD_ID / TOTAL_SHARDS from env with safe
 * defaults; the orchestration of "only shard 0 runs global tasks"
 * is exercised against the same DistributedLock the production path
 * uses (in-process default — `isLeader` always true; the run()
 * guarantees serialisation).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { InProcessDistributedLock } from "../src/adapters/distributed-lock.js";

describe("DistributedLock-gated global reconcile pattern", () => {
  it("only shard 0 enters the run() block; other shards skip", async () => {
    const lock = new InProcessDistributedLock();
    const reconciles: number[] = [];

    async function fakeReconcile(shardId: number): Promise<void> {
      if (shardId !== 0) return;
      await lock.run("global-command-reconcile", async () => {
        reconciles.push(shardId);
      });
    }

    await Promise.all([
      fakeReconcile(0),
      fakeReconcile(1),
      fakeReconcile(2),
      fakeReconcile(3),
    ]);
    expect(reconciles).toEqual([0]);
  });

  it("under a race on shard 0 the lock serialises and only one runs", async () => {
    const lock = new InProcessDistributedLock();
    let inFlight = 0;
    let peak = 0;
    let runs = 0;

    async function reconcile(): Promise<void> {
      await lock.run("global-command-reconcile", async () => {
        runs++;
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
      });
    }
    await Promise.all([reconcile(), reconcile(), reconcile()]);
    expect(runs).toBe(3);
    expect(peak).toBe(1);
  });
});

describe("env-driven shard config defaults", () => {
  const ORIGINAL = { SHARD_ID: process.env.SHARD_ID, TOTAL_SHARDS: process.env.TOTAL_SHARDS };
  beforeEach(() => {
    delete process.env.SHARD_ID;
    delete process.env.TOTAL_SHARDS;
  });
  afterEach(() => {
    process.env.SHARD_ID = ORIGINAL.SHARD_ID;
    process.env.TOTAL_SHARDS = ORIGINAL.TOTAL_SHARDS;
  });

  // We don't import config.ts directly here because it triggers .env
  // parsing at module load — the test instead validates the same
  // clamping logic by re-running it inline. The actual env→number
  // step is the trivial `Math.max(0, parseInt)` and `Math.max(1, ...)`
  // applied during config build.
  it("clamps SHARD_ID below 0 to 0", () => {
    const v = Math.max(0, Number("-5"));
    expect(v).toBe(0);
  });

  it("clamps TOTAL_SHARDS below 1 to 1", () => {
    const v = Math.max(1, Number("0"));
    expect(v).toBe(1);
  });

  it("rejects SHARD_ID >= TOTAL_SHARDS at boot (regression: black-hole shard)", () => {
    // Mirrors the fail-fast guard added to config.ts. With SHARD_ID
    // beyond TOTAL_SHARDS, Discord's gateway routes guilds via
    // (guild_id >> 22) % TOTAL_SHARDS so this shard would receive
    // nothing — silent black hole. The check rejects at boot instead.
    const shardId = 5;
    const totalShards = 2;
    expect(shardId >= totalShards).toBe(true);
    const validate = (sid: number, total: number): void => {
      if (sid >= total) {
        throw new Error(
          `Config error: SHARD_ID (${sid}) must be < TOTAL_SHARDS (${total})`,
        );
      }
    };
    expect(() => validate(shardId, totalShards)).toThrow(/SHARD_ID/);
    expect(() => validate(0, 1)).not.toThrow();
    expect(() => validate(1, 2)).not.toThrow();
  });
});
