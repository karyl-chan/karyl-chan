/**
 * Redis-backed SessionStore.
 *
 * Replaces the in-process AuthStore Map for deployments where two
 * shard processes need to validate each other's admin sessions.
 * Same SessionStore interface, same `IssuedTokens` / `SseTicket`
 * shapes — boot path swaps the implementation behind a single env
 * var (`SESSION_STORE=redis`).
 *
 * Storage layout:
 *
 *   karyl:session:access:<tokenHash>     → JSON `{ ownerId, expiresAt }`
 *                                          PX = (expiresAt - now)
 *   karyl:session:refresh:<tokenHash>    → JSON `{ ownerId, expiresAt }`
 *                                          PX = (expiresAt - now)
 *   karyl:session:ssetkt:<tokenHash>     → JSON `{ ownerId, expiresAt }`
 *                                          PX = (expiresAt - now)
 *   karyl:session:rotated:<tokenHash>    → JSON `{ ownerId, expiresAt }`
 *                                          PX = REFRESH_REUSE_WINDOW_MS
 *   karyl:session:owner:<ownerId>:tokens → Set of `access:|refresh:|ssetkt:` keys
 *
 * The owner→tokens index is what lets `revokeOwner(ownerId)` work
 * without scanning the whole keyspace. It's maintained as a side
 * effect of `issueTokens` / `issueSseTicket` / `revokeRefresh` etc.
 */

import { config } from "../../config.js";
import { hashToken, newToken } from "../../utils/crypto.js";
import {
  type SessionStore,
  type IssuedTokens,
  type SseTicket,
} from "../session-store.js";
import { getRedisClient, type RedisLike } from "./client.js";

const REFRESH_REUSE_WINDOW_MS = 5 * 60 * 1000;

// Atomic rotateRefresh: GETDEL the refresh key in a single round-trip
// so two concurrent rotations of the same token can't both succeed.
// Result tagging:
//   "R<json>" — caller is the one true rotator, raw refresh record
//   "U<json>" — refresh was already consumed and is in the rotated set
//                (i.e. a replay was detected; caller should revokeOwner)
//   ""       — nothing matched
const ROTATE_SCRIPT =
  `local raw = redis.call("GET", KEYS[1]) ` +
  `if raw then ` +
  `  redis.call("DEL", KEYS[1]) ` +
  `  return "R" .. raw ` +
  `end ` +
  `local reused = redis.call("GET", KEYS[2]) ` +
  `if reused then ` +
  `  redis.call("DEL", KEYS[2]) ` +
  `  return "U" .. reused ` +
  `end ` +
  `return ""`;

const PREFIX = "karyl:session:";
const accessKey = (hash: string) => `${PREFIX}access:${hash}`;
const refreshKey = (hash: string) => `${PREFIX}refresh:${hash}`;
const sseKey = (hash: string) => `${PREFIX}ssetkt:${hash}`;
const rotatedKey = (hash: string) => `${PREFIX}rotated:${hash}`;
const ownerIndexKey = (ownerId: string) =>
  `${PREFIX}owner:${ownerId}:tokens`;

interface StoredRecord {
  ownerId: string;
  expiresAt: number;
}

function encodeRecord(r: StoredRecord): string {
  return JSON.stringify(r);
}
function decodeRecord(raw: string | null): StoredRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StoredRecord;
    if (typeof v.ownerId === "string" && typeof v.expiresAt === "number") {
      return v;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: RedisLike = getRedisClient()) {}

  async init(_now: number = Date.now()): Promise<void> {
    // Redis is authoritative — nothing to seed. We verify the
    // connection by pinging so a misconfigured deployment fails loudly
    // at boot rather than at first request.
    await this.redis.ping();
  }

  async issueTokens(
    ownerId: string,
    now: number = Date.now(),
  ): Promise<IssuedTokens> {
    const accessToken = newToken();
    const refreshToken = newToken();
    const accessExpiresAt = now + config.jwt.accessTtlMs;
    const refreshExpiresAt = now + config.jwt.refreshTtlMs;
    const aHash = hashToken(accessToken);
    const rHash = hashToken(refreshToken);
    await Promise.all([
      this.redis.set(
        accessKey(aHash),
        encodeRecord({ ownerId, expiresAt: accessExpiresAt }),
        "PX",
        config.jwt.accessTtlMs,
      ),
      this.redis.set(
        refreshKey(rHash),
        encodeRecord({ ownerId, expiresAt: refreshExpiresAt }),
        "PX",
        config.jwt.refreshTtlMs,
      ),
      this.indexAdd(ownerId, accessKey(aHash), config.jwt.accessTtlMs),
      this.indexAdd(ownerId, refreshKey(rHash), config.jwt.refreshTtlMs),
    ]);
    return {
      accessToken,
      accessExpiresAt,
      refreshToken,
      refreshExpiresAt,
      ownerId,
    };
  }

  /**
   * SessionStore.verifyAccessToken returns string | null sync for the
   * InProcess default, Promise<string|null> for Redis. The interface
   * is `T | Promise<T>` — callers must await.
   */
  async verifyAccessToken(
    token: string,
    now: number = Date.now(),
  ): Promise<string | null> {
    const key = accessKey(hashToken(token));
    const raw = await this.redis.get(key);
    const rec = decodeRecord(raw);
    if (!rec) return null;
    if (rec.expiresAt <= now) {
      // Redis TTL should already have evicted, but defence-in-depth.
      await this.redis.del(key);
      return null;
    }
    return rec.ownerId;
  }

  async rotateRefresh(
    token: string,
    now: number = Date.now(),
  ): Promise<IssuedTokens | null> {
    const hash = hashToken(token);
    // Atomic GETDEL — only one concurrent rotation gets "R<raw>". The
    // others see "" (refresh already consumed) or "U<raw>" (replay
    // detected, the rotated marker had not yet expired).
    const tagged = (await this.redis.eval(
      ROTATE_SCRIPT,
      2,
      refreshKey(hash),
      rotatedKey(hash),
    )) as string | null;
    if (!tagged) return null;
    const tag = tagged.charAt(0);
    const payload = tagged.slice(1);
    if (tag === "U") {
      const reused = decodeRecord(payload);
      if (reused && reused.expiresAt > now) {
        await this.revokeOwner(reused.ownerId);
      }
      return null;
    }
    if (tag !== "R") return null;
    const rec = decodeRecord(payload);
    if (!rec) return null;
    // Don't arm reuse-detection on an already-expired token: it can't
    // be "replayed" in any meaningful sense, and the refresh key is
    // gone now anyway.
    if (rec.expiresAt <= now) return null;
    await this.redis.set(
      rotatedKey(hash),
      encodeRecord({
        ownerId: rec.ownerId,
        expiresAt: now + REFRESH_REUSE_WINDOW_MS,
      }),
      "PX",
      REFRESH_REUSE_WINDOW_MS,
    );
    return this.issueTokens(rec.ownerId, now);
  }

  async revokeRefresh(token: string): Promise<boolean> {
    const n = await this.redis.del(refreshKey(hashToken(token)));
    return n > 0;
  }

  async revokeAccess(token: string): Promise<boolean> {
    const n = await this.redis.del(accessKey(hashToken(token)));
    return n > 0;
  }

  async revokeOwner(ownerId: string): Promise<void> {
    const indexKey = ownerIndexKey(ownerId);
    const indexRaw = await this.redis.hgetall(indexKey);
    const tokenKeys = Object.keys(indexRaw);
    if (tokenKeys.length > 0) {
      await this.redis.del(...tokenKeys);
    }
    await this.redis.del(indexKey);
  }

  async issueSseTicket(
    ownerId: string,
    now: number = Date.now(),
  ): Promise<SseTicket> {
    const ticket = newToken();
    const expiresAt = now + config.jwt.sseTicketTtlMs;
    const hash = hashToken(ticket);
    await Promise.all([
      this.redis.set(
        sseKey(hash),
        encodeRecord({ ownerId, expiresAt }),
        "PX",
        config.jwt.sseTicketTtlMs,
      ),
      this.indexAdd(ownerId, sseKey(hash), config.jwt.sseTicketTtlMs),
    ]);
    return { ticket, expiresAt };
  }

  async consumeSseTicket(
    ticket: string,
    now: number = Date.now(),
  ): Promise<string | null> {
    const hash = hashToken(ticket);
    const raw = await this.redis.get(sseKey(hash));
    const rec = decodeRecord(raw);
    await this.redis.del(sseKey(hash));
    if (!rec) return null;
    if (rec.expiresAt <= now) return null;
    return rec.ownerId;
  }

  stop(): void {
    // Lifecycle of the underlying client is managed centrally in
    // adapters/redis/client.ts; nothing to do here.
  }

  private async indexAdd(
    ownerId: string,
    tokenKey: string,
    ttlMs: number,
  ): Promise<void> {
    const indexKey = ownerIndexKey(ownerId);
    await this.redis.hset(indexKey, tokenKey, "1");
    // Only extend the index TTL if the new entry outlives the current
    // remaining TTL. Otherwise adding a short-lived SSE ticket (60 s)
    // on top of a 7-day refresh entry would shrink the index window
    // to 60 s, after which revokeOwner finds an empty hash and the
    // still-valid refresh token survives revocation.
    const currentPtl = await this.redis.pttl(indexKey);
    // PTTL: -2 = no key, -1 = no TTL, >=0 = remaining ms. Anything
    // shorter than the new entry → extend; otherwise leave alone.
    if (currentPtl === -2 || (currentPtl >= 0 && currentPtl < ttlMs)) {
      await this.redis.pexpire(indexKey, ttlMs);
    }
  }
}
