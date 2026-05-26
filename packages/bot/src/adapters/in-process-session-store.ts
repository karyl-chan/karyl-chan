/**
 * InProcessSessionStore — Phase 0.2 documented the interface; this
 * commit (Phase 1.1) ships the concrete InProcess wrapper around
 * the existing `AuthStore` class. The wrapper exists so the registry
 * factory can return a uniformly-typed `SessionStore` regardless of
 * `SESSION_STORE` env — the rest of the bot reads `getSessionStore()`
 * and the implementation difference is invisible.
 *
 * The legacy `authStore` singleton in
 * `modules/web-core/auth-store.service.ts` keeps its existing call
 * sites; this wrapper holds a reference to that same instance to
 * avoid a forked source of truth during the rollout. A follow-up
 * commit can replace `authStore.*` call sites with
 * `getSessionStore().*` once every caller has been audited for the
 * sync→async signature change (verifyAccessToken / consumeSseTicket).
 */

import { authStore } from "../modules/web-core/auth-store.service.js";
import {
  type SessionStore,
  type IssuedTokens,
  type SseTicket,
} from "./session-store.js";

export class InProcessSessionStore implements SessionStore {
  async init(now?: number): Promise<void> {
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
