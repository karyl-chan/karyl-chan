/**
 * Plugin-WebUI auth state machine.
 *
 * The SPA holds one of:
 *   - a single bearer JWT (used as-is for every authenticated request), or
 *   - an access + refresh pair (access is the active bearer; refresh
 *     trades for a new pair on demand).
 *
 * Which one the SPA holds is decided by `bootstrapPluginSession`'s
 * `exchangeJwt` flag — when true the boot JWT is POSTed to the
 * plugin's `/api/manage/exchange` route and the returned pair becomes
 * the auth state. The plugin server is free to accept any kind of
 * bot-issued JWT at that route; the SDK is neutral on what the JWT
 * means semantically.
 *
 * Storage:
 *   - `<prefix>:bearer` — single string (the JWT)
 *   - `<prefix>:pair`   — JSON-stringified BearerPair
 *
 * One prefix per plugin so two SPAs sharing an origin don't trample
 * each other.
 */

/**
 * Plugin-issued access + refresh pair returned by `/api/manage/exchange`.
 * The HTTP route is named after the historical "manage exchange" flow
 * but the SDK no longer treats this pair as semantically meaning
 * "admin" — it's just a refreshable credential.
 */
export interface BearerPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;  // ms epoch
  refreshExpiresAt: number; // ms epoch
}

export interface AuthState {
  /** True iff a usable bearer is currently set. */
  isAuthenticated(): boolean;
  /** True iff the auth state has a refresh half it can spend. */
  hasRefreshPair(): boolean;
  /** Bearer token to send on the wire (or null). */
  bearerToken(): string | null;
  /** Cache a single bearer JWT (used verbatim — no refresh). */
  setBearer(token: string | null): void;
  /** Currently-cached single bearer, if any. Useful for re-decoding claims. */
  getStoredBearer(): string | null;
  /** Cache a freshly-exchanged access + refresh pair. */
  setBearerPair(t: BearerPair): void;
  /**
   * Try to rotate a stale access token using the refresh half. Mutates
   * state on success. Returns true if the pair was refreshed — callers
   * (the api wrapper) should retry the original request once.
   * Concurrent calls share a single in-flight `/refresh` round-trip.
   * Resolves to false when there's no refresh pair to spend.
   */
  tryRefresh(apiBase: string): Promise<boolean>;
  /** Drop all auth state. */
  clear(): void;
  /**
   * Restore from sessionStorage on tab reload. Returns true if a
   * usable credential was found (pair wins over single bearer).
   */
  loadStored(): boolean;
  /** Register a callback fired when the server returns 401/403. */
  onAccessDenied(handler: (message: string) => void): void;
  /**
   * Multi-subscriber hook fired whenever `isAuthenticated()` transitions.
   * Adapters (Vue composables, vanilla DOM listeners) subscribe here
   * to drive reactivity. Returns an unsubscribe.
   */
  onAuthChange(handler: (authenticated: boolean) => void): () => void;
  /**
   * Configure the API base URL used by the preemptive refresh timer.
   * Should be called once after `createAuthState`, before the first
   * `setBearerPair`. Without this, pair-mode tokens still refresh
   * on demand via `tryRefresh(apiBase)` but the preemptive timer is
   * disabled (no API base to call). `bootstrapPluginSession` wires
   * this for you.
   */
  configureRefresh(apiBase: string): void;
  /**
   * Tear down: cancel the preemptive refresh timer + drop subscribers.
   * Safe to call from SPA unmount.
   */
  destroy(): void;
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
 * Pick a prefix unique per plugin (e.g. `karyl-radio` or `karyl-example`)
 * so two plugins sharing an origin don't trample each other.
 */
export function createAuthState(storageKeyPrefix: string): AuthStateBundle {
  const bearerKey = `${storageKeyPrefix}:bearer`;
  const pairKey = `${storageKeyPrefix}:pair`;

  let bearer: string | null = null;
  let pair: BearerPair | null = null;
  let deniedHandler: ((message: string) => void) | null = null;
  // De-duplicates concurrent 401-retry refreshes — two API calls that
  // both 401 will share one /refresh round-trip instead of racing.
  // Cleared as soon as the in-flight promise settles.
  let refreshInFlight: Promise<boolean> | null = null;
  // Multi-subscriber auth-change fanout. Adapters (Vue composables,
  // vanilla DOM listeners) push subscribers; emit below fires them
  // synchronously after the state mutation. The set is a Set so
  // unsubscribe is O(1).
  const authSubs = new Set<(authenticated: boolean) => void>();
  let lastAuthenticated = false;
  // Preemptive refresh — when a pair is set the SDK schedules a refresh
  // 60 s before access-token expiry so plugin requests don't eat a 401
  // round-trip. Configured via configureRefresh().
  let refreshApiBase: string | null = null;
  let preemptiveTimer: ReturnType<typeof setTimeout> | null = null;
  const PREEMPTIVE_REFRESH_LEAD_MS = 60_000;
  // Set true by destroy(); guards both the timer callback and any
  // setBearerPair flow triggered by a tryRefresh that was already
  // in flight when destroy ran.
  let destroyed = false;

  function isAuthenticated(): boolean {
    return !!bearer || !!pair;
  }

  function hasRefreshPair(): boolean {
    return !!pair && pair.refreshExpiresAt > Date.now();
  }

  function emitAuthChange(): void {
    const now = isAuthenticated();
    if (now === lastAuthenticated) return;
    lastAuthenticated = now;
    for (const sub of authSubs) {
      try {
        sub(now);
      } catch {
        /* subscriber threw — don't break the loop */
      }
    }
  }

  function cancelPreemptiveTimer(): void {
    if (preemptiveTimer) {
      clearTimeout(preemptiveTimer);
      preemptiveTimer = null;
    }
  }

  function schedulePreemptiveRefresh(): void {
    cancelPreemptiveTimer();
    if (destroyed) return;
    if (!refreshApiBase || !pair) return;
    const delay = pair.accessExpiresAt - Date.now() - PREEMPTIVE_REFRESH_LEAD_MS;
    if (delay <= 0) {
      // Already inside the lead window — fire right away.
      void tryRefresh(refreshApiBase);
      return;
    }
    preemptiveTimer = setTimeout(() => {
      preemptiveTimer = null;
      if (destroyed) return;
      if (refreshApiBase) void tryRefresh(refreshApiBase);
    }, delay);
  }

  function bearerToken(): string | null {
    if (pair) return pair.accessToken;
    return bearer;
  }

  function setBearer(token: string | null): void {
    bearer = token;
    pair = null;
    if (token) {
      sessionStorage.setItem(bearerKey, token);
      sessionStorage.removeItem(pairKey);
    } else {
      sessionStorage.removeItem(bearerKey);
    }
    cancelPreemptiveTimer();
    emitAuthChange();
  }

  function setBearerPair(t: BearerPair): void {
    pair = t;
    bearer = null;
    sessionStorage.setItem(pairKey, JSON.stringify(t));
    sessionStorage.removeItem(bearerKey);
    schedulePreemptiveRefresh();
    emitAuthChange();
  }

  async function tryRefresh(apiBase: string): Promise<boolean> {
    if (!pair) return false;
    if (pair.refreshExpiresAt <= Date.now()) return false;
    if (refreshInFlight) return refreshInFlight;
    const refreshToken = pair.refreshToken;
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${apiBase}/api/manage/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return false;
        const next = (await res.json()) as BearerPair;
        setBearerPair(next);
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
    bearer = null;
    pair = null;
    sessionStorage.removeItem(bearerKey);
    sessionStorage.removeItem(pairKey);
    cancelPreemptiveTimer();
    emitAuthChange();
  }

  function loadStored(): boolean {
    // Pair first: a tab that was holding a refreshable pair should
    // resume that, not fall back to an older single bearer that may
    // also be in storage from a previous boot.
    const p = sessionStorage.getItem(pairKey);
    if (p) {
      try {
        const parsed = JSON.parse(p) as BearerPair;
        if (
          typeof parsed.refreshToken === "string" &&
          typeof parsed.refreshExpiresAt === "number" &&
          parsed.refreshExpiresAt > Date.now()
        ) {
          pair = parsed;
          schedulePreemptiveRefresh();
          emitAuthChange();
          return true;
        }
      } catch {
        // Fall through and clear.
      }
      sessionStorage.removeItem(pairKey);
    }
    const b = sessionStorage.getItem(bearerKey);
    if (b) {
      bearer = b;
      emitAuthChange();
      return true;
    }
    return false;
  }

  const state: AuthState = {
    isAuthenticated,
    hasRefreshPair,
    bearerToken,
    setBearer,
    getStoredBearer: () => bearer,
    setBearerPair,
    tryRefresh,
    clear,
    loadStored,
    onAccessDenied(handler) {
      deniedHandler = handler;
    },
    onAuthChange(handler) {
      authSubs.add(handler);
      return () => authSubs.delete(handler);
    },
    configureRefresh(apiBase) {
      refreshApiBase = apiBase.replace(/\/+$/, "");
      // If we already have a pair (e.g. loadStored ran first), schedule
      // the preemptive refresh now.
      if (pair) schedulePreemptiveRefresh();
    },
    destroy() {
      // Order matters: clear state BEFORE wiping subscribers so a final
      // "false" auth-change event reaches them (lets adapters clean up
      // UI state on SPA unmount). Then cancel the timer and null
      // refreshApiBase so an in-flight tryRefresh that resolves after
      // this point can't re-arm the timer.
      if (!destroyed && isAuthenticated()) {
        bearer = null;
        pair = null;
        emitAuthChange();
      }
      destroyed = true;
      cancelPreemptiveTimer();
      refreshApiBase = null;
      authSubs.clear();
      deniedHandler = null;
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
 * POST a bot-issued JWT to `/api/manage/exchange` on the plugin server
 * to receive a plugin-issued access + refresh pair. The plugin's
 * exchange route decides what kind of bot JWTs to accept and what
 * capabilities the resulting pair carries — the SDK is neutral. The
 * route name is preserved from the historical "manage exchange" flow
 * so existing plugin servers keep working without renaming.
 * Returns null on any failure.
 */
export async function exchangeJwtForPair(
  botJwt: string,
  apiBase: string,
): Promise<BearerPair | null> {
  try {
    const res = await fetch(`${apiBase}/api/manage/exchange`, {
      method: "POST",
      headers: { Authorization: `Bearer ${botJwt}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as BearerPair;
  } catch {
    return null;
  }
}
