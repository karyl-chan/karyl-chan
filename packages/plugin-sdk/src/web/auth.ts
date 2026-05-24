/**
 * Plugin-WebUI auth state machine.
 *
 * Two modes:
 *  - "session" — bot's plugin-session JWT (guildId-scoped, no capabilities).
 *    Used verbatim as the Bearer for every authenticated request. Stored
 *    in sessionStorage so tab reloads survive.
 *  - "manage"  — the SPA POSTs the bot's manage JWT to `/api/manage/exchange`
 *    once on first load, receives an access(5min)+refresh(24h) pair
 *    issued by the plugin's own HS256 secret, then lives on those tokens.
 *    The pair lives in sessionStorage for tab-reload survival; on
 *    plugin server restart the HS256 secret is regenerated and every
 *    outstanding manage session invalidates at once (kill-switch).
 *
 * State is created per-plugin via `createAuthState(storageKeyPrefix)` —
 * two plugins sharing one origin (via bot proxy iframes, hypothetically)
 * keep their token stores isolated. The previous module-level singleton
 * in radio/quest/xiangqi would have collided.
 */

export type AuthMode = "none" | "session" | "manage";

export interface ManageTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;  // ms epoch
  refreshExpiresAt: number; // ms epoch
}

export interface AuthState {
  /** Currently active mode, derived from in-memory state. */
  getMode(): AuthMode;
  /** Bearer token to send on the wire (or null). */
  bearerToken(): string | null;
  /** Set a session JWT (bot-issued, guildId-scoped). Clears any manage state. */
  setSessionToken(token: string | null): void;
  /** Currently-cached session token, if any. Useful for re-decoding claims. */
  getSessionToken(): string | null;
  /** Cache a freshly-exchanged manage pair. Clears any session state. */
  setManageTokens(t: ManageTokens): void;
  /** Manage refresh tokens still live (returns false otherwise). */
  hasUsableRefresh(): boolean;
  /**
   * Try to rotate a stale manage access token using its refresh half.
   * Mutates state on success. Returns true if the pair was refreshed —
   * callers (the api wrapper) should retry the original request once.
   * Concurrent calls share a single in-flight `/refresh` round-trip.
   */
  tryRefresh(apiBase: string): Promise<boolean>;
  /** Drop both stores. */
  clear(): void;
  /** Restore from sessionStorage on tab reload. Returns the active mode. */
  loadStored(): AuthMode;
  /** Register a callback fired when the server returns 401/403. */
  onAccessDenied(handler: (message: string) => void): void;
}

/**
 * The factory's return value: a public `state` (the API surface the SPA
 * consumes) plus a package-internal `emitDenied` the api wrapper uses
 * to fan denial signals into whatever subscribers the SPA registered
 * via `state.onAccessDenied(...)`. Keeping `emitDenied` off `AuthState`
 * means consumers can't accidentally fire it from view code.
 */
export interface AuthStateBundle {
  state: AuthState;
  emitDenied: (message: string) => void;
}

/**
 * Create a fresh auth state scoped to a storage-key prefix.
 *
 * Storage keys:
 *  - `<prefix>:session`  — single string (the JWT)
 *  - `<prefix>:manage`   — JSON-stringified ManageTokens
 *
 * Pick a prefix unique per plugin (e.g. `karyl-radio` or `karyl-example`)
 * so two plugins sharing an origin don't trample each other.
 */
export function createAuthState(storageKeyPrefix: string): AuthStateBundle {
  const sessionKey = `${storageKeyPrefix}:session`;
  const manageKey = `${storageKeyPrefix}:manage`;

  let mode: AuthMode = "none";
  let sessionToken: string | null = null;
  let manage: ManageTokens | null = null;
  let deniedHandler: ((message: string) => void) | null = null;
  // De-duplicates concurrent 401-retry refreshes — two API calls that
  // both 401 will share one /refresh round-trip instead of racing.
  // Cleared as soon as the in-flight promise settles.
  let refreshInFlight: Promise<boolean> | null = null;

  function bearerToken(): string | null {
    if (mode === "session") return sessionToken;
    if (mode === "manage") return manage?.accessToken ?? null;
    return null;
  }

  function setSessionToken(token: string | null): void {
    sessionToken = token;
    mode = token ? "session" : "none";
    if (token) sessionStorage.setItem(sessionKey, token);
    else sessionStorage.removeItem(sessionKey);
    // Switching modes — drop the other store so a stale token doesn't
    // resurrect after a clear().
    if (token) sessionStorage.removeItem(manageKey);
  }

  function setManageTokens(t: ManageTokens): void {
    manage = t;
    mode = "manage";
    sessionStorage.setItem(manageKey, JSON.stringify(t));
    sessionStorage.removeItem(sessionKey);
  }

  async function tryRefresh(apiBase: string): Promise<boolean> {
    if (mode !== "manage" || !manage) return false;
    if (manage.refreshExpiresAt <= Date.now()) return false;
    if (refreshInFlight) return refreshInFlight;
    const refreshToken = manage.refreshToken;
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${apiBase}/api/manage/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return false;
        const next = (await res.json()) as ManageTokens;
        setManageTokens(next);
        return true;
      } catch {
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  function clear(): void {
    mode = "none";
    sessionToken = null;
    manage = null;
    sessionStorage.removeItem(sessionKey);
    sessionStorage.removeItem(manageKey);
  }

  function loadStored(): AuthMode {
    // Manage first: a tab that was in manage mode should resume manage,
    // not fall back to an older session token that may also be in
    // storage from a previous run.
    const m = sessionStorage.getItem(manageKey);
    if (m) {
      try {
        const parsed = JSON.parse(m) as ManageTokens;
        if (
          typeof parsed.refreshToken === "string" &&
          typeof parsed.refreshExpiresAt === "number" &&
          parsed.refreshExpiresAt > Date.now()
        ) {
          manage = parsed;
          mode = "manage";
          return "manage";
        }
      } catch {
        // Fall through and clear.
      }
      sessionStorage.removeItem(manageKey);
    }
    const s = sessionStorage.getItem(sessionKey);
    if (s) {
      sessionToken = s;
      mode = "session";
      return "session";
    }
    return "none";
  }

  const state: AuthState = {
    getMode: () => mode,
    bearerToken,
    setSessionToken,
    getSessionToken: () => (mode === "session" ? sessionToken : null),
    setManageTokens,
    hasUsableRefresh: () => !!manage && manage.refreshExpiresAt > Date.now(),
    tryRefresh,
    clear,
    loadStored,
    onAccessDenied(handler) {
      deniedHandler = handler;
    },
  };
  return {
    state,
    emitDenied(message) {
      deniedHandler?.(message);
    },
  };
}

/**
 * POST the bot's manage JWT to `/api/manage/exchange` on the plugin
 * server to receive a plugin-issued access+refresh pair. The plugin's
 * exchange route is expected to gate on the manage capability and
 * return the pair as JSON. Returns null on any failure.
 */
export async function exchangeManageJwt(
  botJwt: string,
  apiBase: string,
): Promise<ManageTokens | null> {
  try {
    const res = await fetch(`${apiBase}/api/manage/exchange`, {
      method: "POST",
      headers: { Authorization: `Bearer ${botJwt}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as ManageTokens;
  } catch {
    return null;
  }
}
