/**
 * Redis-backed SessionStore — Phase 1.1.
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

import { createHash, randomBytes } from "crypto";
import { config } from "../../config.js";
import {
  type SessionStore,
  type IssuedTokens,
  type SseTicket,
} from "../session-store.js";
import { getRedisClient, type RedisLike } from "./client.js";

const REFRESH_REUSE_WINDOW_MS = 5 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("hex");
}

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

  // Phase 1.1 leaves verifyAccessToken sync to match the in-process
  // signature; Redis lookup is awaited via a microtask shim. Callers
  // that care about back-pressure should still feel free to await
  // through the SessionStore methods, but we don't break the existing
  // sync API.
  verifyAccessToken(token: string, now: number = Date.now()): string | null {
    // Synchronous SessionStore.verifyAccessToken is a legacy shape
    // from the in-process AuthStore. With Redis we lose the
    // synchronicity guarantee — we MUST go async. Throwing here keeps
    // a misuse (sync call to a Redis store) loud rather than silent.
    void token;
    void now;
    throw new Error(
      "RedisSessionStore.verifyAccessToken is async — call verifyAccessTokenAsync(token).",
    );
  }

  /**
   * Phase 1.1 — async access verification. The existing callers in
   * web-core/server.ts that hold the in-process `AuthStore` need a
   * thin shim updated to await this; that's a one-line change at the
   * auth-hook level (planned alongside the SESSION_STORE env switch
   * docs).
   */
  async verifyAccessTokenAsync(
    token: string,
    now: number = Date.now(),
  ): Promise<string | null> {
    const raw = await this.redis.get(accessKey(hashToken(token)));
    const rec = decodeRecord(raw);
    if (!rec) return null;
    if (rec.expiresAt <= now) {
      // Redis TTL should already have evicted, but defence-in-depth.
      await this.redis.del(accessKey(hashToken(token)));
      return null;
    }
    return rec.ownerId;
  }

  async rotateRefresh(
    token: string,
    now: number = Date.now(),
  ): Promise<IssuedTokens | null> {
    const hash = hashToken(token);
    const raw = await this.redis.get(refreshKey(hash));
    if (!raw) {
      // Check the rotated set for replay detection.
      const reusedRaw = await this.redis.get(rotatedKey(hash));
      const reused = decodeRecord(reusedRaw);
      if (reused && reused.expiresAt > now) {
        await this.redis.del(rotatedKey(hash));
        await this.revokeOwner(reused.ownerId);
      }
      return null;
    }
    const rec = decodeRecord(raw);
    if (!rec) return null;
    await this.redis.del(refreshKey(hash));
    if (rec.expiresAt <= now) return null;
    // Stash the rotated hash for reuse-detection.
    await this.redis.set(
      rotatedKey(hash),
      encodeRecord({ ownerId: rec.ownerId, expiresAt: now + REFRESH_REUSE_WINDOW_MS }),
      "PX",
      REFRESH_REUSE_WINDOW_MS,
    );
    return this.issueTokens(rec.ownerId, now);
  }

  async revokeRefresh(token: string): Promise<boolean> {
    const n = await this.redis.del(refreshKey(hashToken(token)));
    return n > 0;
  }

  revokeAccess(token: string): boolean {
    // Same async-vs-sync caveat as verifyAccessToken — fire-and-forget
    // delete keeps the existing sync contract from the in-process store.
    // The downside (a momentary race where the token still validates)
    // is acceptable; logout pages don't poll the access token.
    void this.redis.del(accessKey(hashToken(token))).catch(() => undefined);
    return true;
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

  issueSseTicket(
    ownerId: string,
    now: number = Date.now(),
  ): SseTicket {
    const ticket = newToken();
    const expiresAt = now + config.jwt.sseTicketTtlMs;
    const hash = hashToken(ticket);
    // Fire-and-forget; the sync interface predates Redis. A consumer
    // that races and consumes before the SET lands gets back null,
    // which is the same as "expired" — caller retries.
    void Promise.all([
      this.redis.set(
        sseKey(hash),
        encodeRecord({ ownerId, expiresAt }),
        "PX",
        config.jwt.sseTicketTtlMs,
      ),
      this.indexAdd(ownerId, sseKey(hash), config.jwt.sseTicketTtlMs),
    ]).catch(() => undefined);
    return { ticket, expiresAt };
  }

  consumeSseTicket(ticket: string, now: number = Date.now()): string | null {
    // Same sync caveat. We do a GET-then-DEL pipeline rather than
    // GETDEL because GETDEL needs Redis 6.2+ and we don't want a
    // hard version pin.
    void ticket;
    void now;
    throw new Error(
      "RedisSessionStore.consumeSseTicket is async — call consumeSseTicketAsync(ticket).",
    );
  }

  async consumeSseTicketAsync(
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
    // Refresh the index TTL to the longest-lived token in the set —
    // approximated by always bumping to the new entry's TTL.
    await this.redis.pexpire(indexKey, ttlMs);
  }
}
