/**
 * SessionStore — issuance, verification, and revocation of admin
 * access / refresh / SSE-ticket tokens, and the record of used login
 * links.
 *
 * The InProcess default IS the existing `AuthStore` class in
 * `modules/web-core/auth-store.service.ts` — these methods name the
 * subset of its API the rest of the bot relies on. A Redis-backed
 * implementation can swap in so two shard processes can validate
 * each other's sessions (in single-shard mode an admin's login dies
 * the moment their next request lands on a different shard).
 *
 * The interface intentionally mirrors `AuthStore` 1-for-1; the
 * RefreshStoreAdapter pattern that already exists on `AuthStore` is
 * orthogonal — it persists rotation state across process restarts
 * within a single shard, whereas SessionStore is about sharing state
 * across shards.
 */

export interface IssuedTokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  ownerId: string;
}

export interface SseTicket {
  ticket: string;
  expiresAt: number;
}

export interface SessionStore {
  /**
   * Replay any persisted refresh-token state into memory. Called
   * once at boot, after migrations. No-op for stores that keep
   * everything in their own backing service (Redis).
   */
  init(now?: number): Promise<void>;

  issueTokens(ownerId: string, now?: number): Promise<IssuedTokens>;
  /**
   * Sync for the InProcess default; async for any cross-shard
   * implementation (Redis). Callers should `await` defensively — an
   * `await` on a non-Promise resolves on the next microtask.
   */
  verifyAccessToken(
    token: string,
    now?: number,
  ): (string | null) | Promise<string | null>;
  rotateRefresh(token: string, now?: number): Promise<IssuedTokens | null>;
  revokeRefresh(token: string): Promise<boolean>;
  revokeAccess(token: string): boolean | Promise<boolean>;
  revokeOwner(ownerId: string): Promise<void>;

  issueSseTicket(
    ownerId: string,
    now?: number,
  ): SseTicket | Promise<SseTicket>;
  consumeSseTicket(
    ticket: string,
    now?: number,
  ): (string | null) | Promise<string | null>;

  /**
   * Use up a login link's `jti` (#216): true the first time, false while
   * the `jti` is remembered — until `expiresAt`, the link's own expiry.
   * Must be atomic, so two concurrent exchanges of one link can't both
   * get true.
   */
  consumeLoginJti(
    jti: string,
    expiresAt: number,
    now?: number,
  ): boolean | Promise<boolean>;

  /** Stop background timers. Called on graceful shutdown. */
  stop(): void;
}
