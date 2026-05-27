/**
 * Phase 1.1 — RedisSessionStore against an in-memory RedisLike stub.
 *
 * We don't run a real Redis in tests (the WSL dev host can't); the
 * stub implements just enough of the ioredis surface that the store
 * actually calls. Production wires `getRedisClient()` which returns
 * the real ioredis client with the same interface.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setRedisClientForTests,
  __resetRedisClientForTests,
  type RedisLike,
} from "../src/adapters/redis/client.js";
import { RedisSessionStore } from "../src/adapters/redis/session-store.js";

interface StoredValue {
  value: string;
  expiresAt: number | null;
}

function makeStub(): RedisLike {
  const data = new Map<string, StoredValue>();
  const now = () => Date.now();

  function isAlive(k: string): boolean {
    const v = data.get(k);
    if (!v) return false;
    if (v.expiresAt !== null && v.expiresAt <= now()) {
      data.delete(k);
      return false;
    }
    return true;
  }

  return {
    async get(key) {
      return isAlive(key) ? data.get(key)!.value : null;
    },
    async set(key, value, ...args) {
      let expiresAt: number | null = null;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "PX" && typeof args[i + 1] === "number") {
          expiresAt = now() + (args[i + 1] as number);
          break;
        }
        if (args[i] === "EX" && typeof args[i + 1] === "number") {
          expiresAt = now() + (args[i + 1] as number) * 1000;
          break;
        }
      }
      data.set(key, { value, expiresAt });
      return "OK";
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) {
        if (data.delete(k)) n++;
      }
      return n;
    },
    async hset(key, ...args) {
      // We treat hash fields as separate keys to keep the stub small.
      // RedisSessionStore only uses hset for the owner-index where the
      // exact storage doesn't matter — what matters is that hgetall +
      // del clean it up.
      const existing = data.get(key);
      const map: Record<string, string> = existing
        ? (JSON.parse(existing.value) as Record<string, string>)
        : {};
      let added = 0;
      for (let i = 0; i < args.length; i += 2) {
        const f = String(args[i]);
        const v = String(args[i + 1]);
        if (!(f in map)) added++;
        map[f] = v;
      }
      data.set(key, { value: JSON.stringify(map), expiresAt: existing?.expiresAt ?? null });
      return added;
    },
    async hget(key, field) {
      const v = data.get(key);
      if (!v) return null;
      const map = JSON.parse(v.value) as Record<string, string>;
      return map[field] ?? null;
    },
    async hdel(key, ...fields) {
      const v = data.get(key);
      if (!v) return 0;
      const map = JSON.parse(v.value) as Record<string, string>;
      let n = 0;
      for (const f of fields) {
        if (f in map) {
          delete map[f];
          n++;
        }
      }
      data.set(key, { value: JSON.stringify(map), expiresAt: v.expiresAt });
      return n;
    },
    async hgetall(key) {
      const v = data.get(key);
      if (!v) return {};
      return JSON.parse(v.value) as Record<string, string>;
    },
    async expire(key, seconds) {
      const v = data.get(key);
      if (!v) return 0;
      v.expiresAt = now() + seconds * 1000;
      return 1;
    },
    async pexpire(key, ms) {
      const v = data.get(key);
      if (!v) return 0;
      v.expiresAt = now() + ms;
      return 1;
    },
    async pttl(key) {
      const v = data.get(key);
      if (!v) return -2;
      if (v.expiresAt === null) return -1;
      return Math.max(0, v.expiresAt - now());
    },
    async eval(script, _numKeys, ...args) {
      // Emulate the rotateRefresh script: GETDEL refreshKey, else GETDEL
      // rotatedKey. Tagged result matches production semantics.
      if (typeof script === "string" && script.includes("redis.call(\"DEL\", KEYS[1])")) {
        const refreshK = String(args[0]);
        const rotatedK = String(args[1]);
        if (isAlive(refreshK)) {
          const raw = data.get(refreshK)!.value;
          data.delete(refreshK);
          return `R${raw}`;
        }
        if (isAlive(rotatedK)) {
          const raw = data.get(rotatedK)!.value;
          data.delete(rotatedK);
          return `U${raw}`;
        }
        return "";
      }
      return null;
    },
    async scan() {
      return ["0", Array.from(data.keys())];
    },
    async ping() {
      return "PONG";
    },
    async quit() {
      return "OK";
    },
  };
}

beforeEach(() => {
  setRedisClientForTests(makeStub());
});
afterEach(() => {
  setRedisClientForTests(null);
  __resetRedisClientForTests();
  vi.restoreAllMocks();
});

describe("RedisSessionStore", () => {
  it("init() pings the server", async () => {
    const store = new RedisSessionStore();
    await expect(store.init()).resolves.toBeUndefined();
  });

  it("issueTokens then verifyAccessTokenAsync resolves to ownerId", async () => {
    const store = new RedisSessionStore();
    const { accessToken } = await store.issueTokens("user-1");
    const owner = await store.verifyAccessTokenAsync(accessToken);
    expect(owner).toBe("user-1");
  });

  it("verifyAccessTokenAsync returns null for unknown / expired tokens", async () => {
    const store = new RedisSessionStore();
    expect(await store.verifyAccessTokenAsync("nope")).toBeNull();
    const { accessToken } = await store.issueTokens("user-1");
    // Force expiry by passing a future `now`.
    expect(
      await store.verifyAccessTokenAsync(accessToken, Date.now() + 1e9),
    ).toBeNull();
  });

  it("rotateRefresh issues new pair, invalidates old, detects replay", async () => {
    const store = new RedisSessionStore();
    const a = await store.issueTokens("user-1");
    const b = await store.rotateRefresh(a.refreshToken);
    expect(b).not.toBeNull();
    expect(b!.refreshToken).not.toBe(a.refreshToken);
    // Replay the old refresh — should trip the rotated-set, revoke owner.
    const replay = await store.rotateRefresh(a.refreshToken);
    expect(replay).toBeNull();
    // Both old + rotated tokens are now invalid.
    expect(await store.verifyAccessTokenAsync(a.accessToken)).toBeNull();
  });

  it("concurrent rotateRefresh of the same token: only one succeeds", async () => {
    const store = new RedisSessionStore();
    const { refreshToken } = await store.issueTokens("user-1");
    const results = await Promise.all([
      store.rotateRefresh(refreshToken),
      store.rotateRefresh(refreshToken),
      store.rotateRefresh(refreshToken),
    ]);
    const succeeded = results.filter((r) => r !== null);
    expect(succeeded.length).toBe(1);
  });

  it("revokeRefresh returns true on first call, false on the second", async () => {
    const store = new RedisSessionStore();
    const { refreshToken } = await store.issueTokens("u");
    expect(await store.revokeRefresh(refreshToken)).toBe(true);
    expect(await store.revokeRefresh(refreshToken)).toBe(false);
  });

  it("revokeOwner sweeps every token the owner owns", async () => {
    const store = new RedisSessionStore();
    const a = await store.issueTokens("user-1");
    const b = await store.issueTokens("user-1");
    await store.revokeOwner("user-1");
    expect(await store.verifyAccessTokenAsync(a.accessToken)).toBeNull();
    expect(await store.verifyAccessTokenAsync(b.accessToken)).toBeNull();
  });

  it("consumeSseTicketAsync is one-shot", async () => {
    const store = new RedisSessionStore();
    const { ticket } = store.issueSseTicket("user-1");
    // Issue is fire-and-forget; await a tick so the SET lands.
    await new Promise((r) => setTimeout(r, 5));
    expect(await store.consumeSseTicketAsync(ticket)).toBe("user-1");
    expect(await store.consumeSseTicketAsync(ticket)).toBeNull();
  });

  it("sync verifyAccessToken throws (sync API is the in-process legacy)", () => {
    const store = new RedisSessionStore();
    expect(() => store.verifyAccessToken("x")).toThrow(/async/i);
  });

  it("sync consumeSseTicket throws", () => {
    const store = new RedisSessionStore();
    expect(() => store.consumeSseTicket("x")).toThrow(/async/i);
  });
});
