/**
 * InProcessSessionStore — concrete InProcess wrapper around the
 * existing `AuthStore` class. The wrapper exists so the registry
 * factory can return a uniformly-typed `SessionStore` regardless of
 * `SESSION_STORE` env — the rest of the bot reads `getSessionStore()`
 * and the implementation difference is invisible.
 *
 * The session-verb call sites (the web auth hook + auth routes in
 * `web-core/server.ts`, and `revokeOwner` in
 * `admin/authorized-user.service.ts`) now route through
 * `getSessionStore()`, so the Redis store can transparently take over
 * cross-shard. This wrapper holds a reference to the same `authStore`
 * singleton so the in-process path keeps one source of truth, and owns
 * the in-process-only refresh-store durability wiring in `init()` (so
 * the bootstrap layer never reaches past the `SessionStore` interface).
 */

import { authStore } from "../modules/web-core/auth-store.service.js";
import { sequelizeRefreshStore } from "../modules/web-core/refresh-token.repository.js";
import {
  type SessionStore,
  type IssuedTokens,
  type SseTicket,
} from "./session-store.js";

export class InProcessSessionStore implements SessionStore {
  async init(now?: number): Promise<void> {
    // Refresh-token durability across restarts is an in-process-only
    // concern (the Redis store keeps its own state), so it's owned here
    // rather than wired from the bootstrap layer. Attaching at init()
    // time — invoked once at boot after migrations — keeps it off the
    // import path and guarantees the DB is ready before init() loads.
    authStore.attach(sequelizeRefreshStore);
    await authStore.init(now);
  }

  issueTokens(ownerId: string, now?: number): Promise<IssuedTokens> {
    return authStore.issueTokens(ownerId, now);
  }

  verifyAccessToken(token: string, now?: number): string | null {
    return authStore.verifyAccessToken(token, now);
  }

  rotateRefresh(
    token: string,
    now?: number,
  ): Promise<IssuedTokens | null> {
    return authStore.rotateRefresh(token, now);
  }

  revokeRefresh(token: string): Promise<boolean> {
    return authStore.revokeRefresh(token);
  }

  revokeAccess(token: string): boolean {
    return authStore.revokeAccess(token);
  }

  revokeOwner(ownerId: string): Promise<void> {
    return authStore.revokeOwner(ownerId);
  }

  issueSseTicket(ownerId: string, now?: number): SseTicket {
    return authStore.issueSseTicket(ownerId, now);
  }

  consumeSseTicket(ticket: string, now?: number): string | null {
    return authStore.consumeSseTicket(ticket, now);
  }

  stop(): void {
    authStore.stop();
  }
}
