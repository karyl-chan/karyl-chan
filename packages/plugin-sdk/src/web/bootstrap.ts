import { API_BASE } from "./plugin-base.js";
import {
  decodeJwt,
  readQueryParamAndStrip,
  readTokenFromUrl,
  type JwtClaims,
} from "./jwt.js";
import {
  createAuthState,
  exchangeJwtForPair,
  type AuthState,
  type BearerPair,
} from "./auth.js";
import { createPluginApi, type PluginApi } from "./api.js";

/**
 * One-call plugin SPA bootstrap.
 *
 * Absorbs the URL→token→decode→(maybe exchange)→denied wiring every
 * plugin SPA would otherwise hand-roll, and returns a `SessionHandle`
 * exposing the resolved auth/api bundle plus a `destroy()` for SPA
 * unmount and a `subscribe(handler)` hook for adapters that need to
 * react to auth transitions.
 *
 * Two boolean knobs decide the token flow:
 *
 *   - `exchangeJwt: true` — POST the boot JWT to the plugin's
 *     `/api/manage/exchange` route and live on the returned access +
 *     refresh pair. The plugin server gates the exchange (only certain
 *     bot-JWT kinds, only with the right cap, etc.) — the SDK is
 *     neutral on what "kind" of JWT this is.
 *
 *   - `exchangeJwt: false` (default) — use the boot JWT verbatim as
 *     the Bearer. No refresh; the session ends when the JWT expires.
 *
 * The boot JWT itself comes from `?token=…` in the URL (the bot's
 * link emitter); the SDK reads it once, strips it from the address
 * bar, and stores the resulting credential in sessionStorage so a
 * tab reload restores cleanly.
 *
 * The handle is framework-agnostic plain data;
 * `@karyl-chan/plugin-sdk/web/vue` wraps it into reactive composables
 * for Vue, but the handle itself works in any UI.
 */

export interface BootstrapOptions {
  /**
   * Plugin key — used as the sessionStorage prefix so two plugins on
   * the same origin (admin UI iframes, etc.) don't collide.
   */
  pluginKey: string;
  /**
   * Optional API base override. Defaults to `API_BASE` resolved from
   * `<base href>` or `window.location.pathname`. Pass when the plugin's
   * SPA is served from a non-standard mount.
   */
  apiBase?: string;
  /**
   * When true, POST the boot JWT to the plugin's `/api/manage/exchange`
   * route and live on the access + refresh pair the plugin server
   * returns. When false (default), use the boot JWT verbatim as the
   * bearer with no refresh.
   *
   * The flag is intentionally orthogonal to any notion of "manage" vs
   * "session" semantics. The plugin SPA tells the SDK what flow it
   * wants based on its own routing (e.g. the /admin/ page asks for
   * `exchangeJwt: true`; the /play/ page doesn't). The route name
   * `/api/manage/exchange` is preserved from history for backward
   * compatibility with existing plugin servers.
   */
  exchangeJwt?: boolean;
  /**
   * Additional URL params to read-and-strip at boot. Values land in
   * `SessionHandle.urlParams`. Use for plugin-specific bootstrap state
   * (`c`, `s`, etc.) that should be cleaned out of the address bar so
   * a refresh doesn't re-trigger the side-effect.
   *
   * RESERVED NAME: `"token"` is consumed by the SDK itself and is
   * silently skipped if passed here.
   */
  extraUrlParams?: string[];
  /**
   * Called when the session is irrecoverably denied — 401/403 after
   * refresh, or revoked mid-session. Subscribe here to route to an
   * error view. The handler can fire multiple times if the SPA stays
   * mounted and retries.
   */
  onAccessDenied?: (message: string) => void;
}

export interface SessionHandle {
  /** Resolved API base URL. */
  readonly apiBase: string;
  /** True iff bootstrap established a usable bearer (either via the
   *  URL token, the exchange, or a sessionStorage restore). */
  readonly isAuthenticated: boolean;
  /** True iff `exchangeJwt: true` was passed AND the exchange succeeded
   *  AND the SPA has a refresh half it can spend. */
  readonly hasRefreshPair: boolean;
  /**
   * True iff bootstrap could not establish the requested session —
   * e.g. the exchange returned null, or the URL token failed to
   * decode. Authoritative: callers should branch on this rather than
   * relying on a synchronous side-effect in `onAccessDenied`. False
   * on both successful bootstrap AND tab-reload-with-no-token (the
   * latter is `isAuthenticated === false` but not a denial).
   */
  readonly denied: boolean;
  /** Message describing the denial when `denied` is true; otherwise null. */
  readonly deniedReason: string | null;
  /**
   * The decoded JWT claims from the boot token (no signature check —
   * the server is authoritative). Null on tab reload where no URL
   * token was present and we restored from sessionStorage.
   */
  readonly claims: JwtClaims | null;
  /** `guildId` from the bootstrap claims, if any. */
  readonly guildId: string | null;
  /** Extra URL params requested via `extraUrlParams`, after read-and-strip. */
  readonly urlParams: Record<string, string | null>;
  /** The auth state machine — pass to `createPluginApi` / `openSseChannel`. */
  readonly auth: AuthState;
  /**
   * Pre-built `PluginApi` (auth + apiBase + refresh on 401). Skips the
   * boilerplate of wiring `createPluginApi({auth, apiBase, emitDenied})`
   * in every plugin. The internal `emitDenied` is wired to call
   * `BootstrapOptions.onAccessDenied`.
   */
  readonly api: PluginApi;
  /**
   * Subscribe to auth transitions (false → true on a successful
   * exchange/restore; true → false on denial/destroy). Returns an
   * unsubscribe. Multiple subscribers fan out from the underlying
   * `AuthState.onAuthChange`.
   */
  subscribe(handler: (authenticated: boolean) => void): () => void;
  /**
   * Tear down: cancel preemptive refresh timer + clear subscribers.
   * Safe to call from SPA unmount. After destroy(), `api` calls still
   * work but auto-refresh is disabled.
   */
  destroy(): void;
}

export async function bootstrapPluginSession(
  opts: BootstrapOptions,
): Promise<SessionHandle> {
  const apiBase = (opts.apiBase ?? API_BASE).replace(/\/+$/, "");
  const bundle = createAuthState(opts.pluginKey);
  const auth = bundle.state;
  auth.configureRefresh(apiBase);
  if (opts.onAccessDenied) {
    auth.onAccessDenied(opts.onAccessDenied);
  }

  // Strip extras before any work — keep the address bar clean so a
  // refresh doesn't re-trigger side-effects. "token" is reserved
  // (consumed by the SDK itself); silently drop it from extraUrlParams
  // to avoid a race where the caller's strip beats the SDK's.
  const extraUrlParams: Record<string, string | null> = {};
  for (const k of opts.extraUrlParams ?? []) {
    if (k === "token") continue;
    extraUrlParams[k] = readQueryParamAndStrip(k);
  }

  const token = readTokenFromUrl();
  let claims: JwtClaims | null = null;
  let denied = false;
  let deniedReason: string | null = null;
  const recordDenial = (msg: string): void => {
    denied = true;
    deniedReason = msg;
    opts.onAccessDenied?.(msg);
  };

  if (token) {
    claims = decodeJwt(token);
    if (!claims) {
      recordDenial("URL token is malformed");
    } else if (opts.exchangeJwt) {
      const exchanged: BearerPair | null = await exchangeJwtForPair(
        token,
        apiBase,
      );
      if (exchanged) {
        auth.setBearerPair(exchanged);
      } else {
        // Exchange failed (server rejected, network blip, etc.).
        // Record on the handle so callers branching on `handle.denied`
        // see it without relying on the synchronous onAccessDenied
        // side-effect.
        recordDenial("JWT exchange failed");
      }
    } else {
      auth.setBearer(token);
    }
  } else {
    // No URL token — tab reload or initial visit. Try sessionStorage.
    // Not a denial — a fresh-tab visitor with no token just has
    // `isAuthenticated === false`.
    auth.loadStored();
  }

  // Wire the API once, sharing the auth state and the denied fanout.
  const api = createPluginApi({
    apiBase,
    auth,
    emitDenied: (msg) => bundle.emitDenied(msg),
  });

  const guildId = claims?.guildId ?? null;

  const handle: SessionHandle = {
    apiBase,
    get isAuthenticated() {
      return auth.isAuthenticated();
    },
    get hasRefreshPair() {
      return auth.hasRefreshPair();
    },
    denied,
    deniedReason,
    claims,
    guildId,
    urlParams: extraUrlParams,
    auth,
    api,
    subscribe(handler) {
      return auth.onAuthChange(handler);
    },
    destroy() {
      auth.destroy();
    },
  };
  return handle;
}
