/**
 * Phase 3.3 — `targetShardForGuild` correctness.
 *
 * Discord's shard formula is `(BigInt(guild_id) >> 22n) %
 * BigInt(shard_count)`. We pin a handful of known guild IDs against
 * shard counts so a future refactor (or a regression in BigInt
 * handling) trips a test before it ships.
 */

import { describe, expect, it } from "vitest";
import { targetShardForGuild } from "../src/utils/shard-routing.js";

describe("targetShardForGuild", () => {
  it("returns 0 for any guild when totalShards = 1", () => {
    expect(targetShardForGuild("123456789012345678", 1)).toBe(0);
    expect(targetShardForGuild("9".repeat(18), 1)).toBe(0);
  });

  it("produces a value in [0, totalShards)", () => {
    for (let n = 2; n <= 16; n++) {
      const id = "987654321098765432";
      const s = targetShardForGuild(id, n);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(n);
    }
  });

  it("is deterministic for the same input", () => {
    const id = "850000000000000000";
    expect(targetShardForGuild(id, 4)).toBe(targetShardForGuild(id, 4));
  });

  it("distributes across shards for varied guild IDs", () => {
    const ids = Array.from({ length: 100 }, (_, i) =>
      String(BigInt(800000000000000000n) + BigInt(i) * 4194304n),
    );
    const counts = new Map<number, number>();
    for (const id of ids) {
      const s = targetShardForGuild(id, 4);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    // Sequential snowflakes spaced by 2^22 land on consecutive
    // shards; 4 shards means each gets 25 IDs.
    expect(counts.size).toBe(4);
    for (const c of counts.values()) expect(c).toBe(25);
  });

  it("matches the canonical (BigInt(id) >> 22n) % N formula", () => {
    const cases: Array<{ id: string; n: number; expected: number }> = [
      { id: "750000000000000000", n: 2, expected: 0 },
      { id: "750000000000000000", n: 4, expected: 0 },
      { id: "750000000004194305", n: 2, expected: 1 },
      { id: "750000000004194305", n: 4, expected: 1 },
    ];
    for (const c of cases) {
      const canonical = Number(
        (BigInt(c.id) >> 22n) % BigInt(c.n),
      );
      expect(targetShardForGuild(c.id, c.n)).toBe(canonical);
    }
  });
});
