import { API_BASE } from "./plugin-base.js";
import {
  decodeJwt,
  readQueryParamAndStrip,
  readTokenFromUrl,
  type JwtClaims,
} from "./jwt.js";
import {
  createAuthState,
  exchangeManageJwt,
  type AuthMode,
  type AuthState,
  type ManageTokens,
} from "./auth.js";
import { createPluginApi, type PluginApi } from "./api.js";

/**
 * One-call plugin SPA bootstrap. Absorbs the 50-80 lines of
 * URL→token→decode→exchange→denied wiring every plugin would otherwise
 * hand-roll.
 *
 * Returns a `SessionHandle` that exposes the resolved auth/api bundle
 * plus a `destroy()` for SPA unmount and a `subscribe(handler)` hook
 * for adapters (Vue composables, vanilla DOM listeners) that need to
 * react to mode changes.
 *
 * Designed framework-agnostic — `SessionHandle` is plain data;
 * `@karyl-chan/plugin-sdk/web/vue` wraps it into reactive composables
 * for Vue, but the handle itself works in any UI.
 */

export type AuthSurface = "session" | "manage";

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
   * Per-surface auth mode policy. The bootstrap reads `?surface=...`
   * and looks up its required mode here. Surfaces not listed fall back
   * to "session". Example:
   *   `{ manage: "manage", showcase: "manage", chat: "session" }`.
   */
  surfaces?: Record<string, AuthSurface>;
  /**
   * Additional URL params to read-and-strip at boot. Values land in
   * `SessionHandle.urlParams`. Use for plugin-specific bootstrap state
   * (`c`, `s`, etc.) that should be cleaned out of the address bar
   * so a refresh doesn't re-trigger the side-effect.
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
  /** Auth mode at bootstrap end: `"session" | "manage" | "none"`. */
  readonly mode: AuthMode;
  /** Mode the URL token requested before exchange (`"session" | "manage" | null`). */
  readonly requestedMode: AuthSurface | null;
  /**
   * The decoded JWT claims from the boot token (no signature check —
   * the server is authoritative). Null on tab reload where no URL
   * token was present and we restored from sessionStorage.
   */
  readonly claims: JwtClaims | null;
  /**
   * `?surface=...` URL param value, after read-and-strip. Surface
   * routing is the plugin's concern — the SDK only normalises and
   * returns it.
   */
  readonly surface: string | null;
  /** guildId from the bootstrap claims (or null). */
  readonly guildId: string | null;
  /** Extra URL params requested via `extraUrlParams`, after read-and-strip. */
  readonly urlParams: Record<string, string | null>;
  /** The auth state machine — pass to `createPluginApi` / `openSseChannel`. */
  readonly auth: AuthState;
  /**
   * Pre-built `PluginApi` (auth + apiBase + refresh on 401). Skips
   * the boilerplate of wiring `createPluginApi({auth, apiBase, emitDenied})`
   * in every plugin. The internal `emitDenied` is wired to call
   * `BootstrapOptions.onAccessDenied`.
   */
  readonly api: PluginApi;
  /**
   * Subscribe to mode changes. Returns an unsubscribe. Multiple
   * subscribers fan out from the underlying `AuthState.onModeChange`.
   */
  subscribe(handler: (mode: AuthMode) => void): () => void;
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

  // Strip surface + extras before any work — keep the address bar
  // clean so a refresh doesn't re-trigger side-effects.
  const surface = readQueryParamAndStrip("surface");
  const extraUrlParams: Record<string, string | null> = {};
  for (const k of opts.extraUrlParams ?? []) {
    extraUrlParams[k] = readQueryParamAndStrip(k);
  }

  const token = readTokenFromUrl();
  let claims: JwtClaims | null = null;
  let requestedMode: AuthSurface | null = null;

  if (token) {
    claims = decodeJwt(token);
    // Decide intended mode from the surfaces map; fall back to
    // "session" when not listed. A surface absent from the URL also
    // defaults to "session" — the historically-common case.
    const surfacePolicy = surface ? opts.surfaces?.[surface] : undefined;
    requestedMode = surfacePolicy ?? "session";

    if (requestedMode === "manage") {
      const exchanged: ManageTokens | null = await exchangeManageJwt(
        token,
        apiBase,
      );
      if (exchanged) {
        auth.setManageTokens(exchanged);
      } else {
        // Exchange failed (no manage cap, expired, plugin restart kill-
        // switch). Fire the denied callback so the SPA can route.
        opts.onAccessDenied?.("manage token exchange failed");
      }
    } else {
      auth.setSessionToken(token);
    }
  } else {
    // No URL token — tab reload or initial visit. Try sessionStorage.
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
    get mode() {
      return auth.getMode();
    },
    requestedMode,
    claims,
    surface,
    guildId,
    urlParams: extraUrlParams,
    auth,
    api,
    subscribe(handler) {
      return auth.onModeChange(handler);
    },
    destroy() {
      auth.destroy();
    },
  };
  return handle;
}
