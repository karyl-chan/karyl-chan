/**
 * Browser-side JWT helpers used by plugin SPAs. The signature is NEVER
 * verified here — the bot signs with Ed25519 and the plugin server
 * re-verifies on every authenticated request (see
 * `verifyPluginSession` in the Node entry of this package). The browser
 * only needs to read the claims to decide which surface to show
 * (session vs manage) and to recover guildId on tab reload.
 */

export interface JwtClaims {
  /** Discord user id the token authorizes. */
  userId?: string;
  /** Playback-/scope-bound guild id, or null for non-guild (manage) tokens. */
  guildId?: string | null;
  /** Subset of `admin` + `plugin:<key>:*` capabilities at mint time. */
  capabilities?: string[];
  /** Token expiry, seconds since epoch. */
  exp?: number;
  /** Token issued-at, seconds since epoch. */
  iat?: number;
  /** Always `"plugin-session"` for tokens minted by the bot. */
  purpose?: string;
  [key: string]: unknown;
}

function b64urlDecode(s: string): string {
  let r = s.replace(/-/g, "+").replace(/_/g, "/");
  while (r.length % 4) r += "=";
  // UTF-8-safe decode: atob → percent-encode each char → decodeURIComponent.
  // The naive `atob(...)` path drops non-ASCII bytes in the payload (e.g.
  // a username containing CJK characters) — radio's api.ts does the same
  // dance; quest-game and xiangqi got this wrong and would have crashed
  // on non-ASCII claims.
  return decodeURIComponent(
    atob(r)
      .split("")
      .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join(""),
  );
}

/**
 * Parse the payload of a compact JWS without verifying the signature.
 * Returns `null` if the token is malformed, the payload is not JSON, or
 * the payload is not an object.
 */
export function decodeJwt(token: string): JwtClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(b64urlDecode(parts[1]));
    return payload && typeof payload === "object" ? (payload as JwtClaims) : null;
  } catch {
    return null;
  }
}

/**
 * Pull `?token=<jwt>` off the current URL, strip the param from
 * `history` (so the JWT doesn't show in screenshots, server logs, or
 * the browser's address bar after first read), and return it.
 *
 * Returns `null` when no token param is present.
 *
 * Plugin SPA boot pattern:
 *   const urlToken = readTokenFromUrl();
 *   if (urlToken) { … decode → exchange / setSession … }
 *   else          { … fall back to sessionStorage … }
 */
export function readTokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const u = new URL(window.location.href);
  const v = u.searchParams.get("token");
  if (!v) return null;
  u.searchParams.delete("token");
  history.replaceState(
    null,
    "",
    u.pathname + (u.search || "") + (u.hash || ""),
  );
  return v;
}

/**
 * Read and strip an arbitrary URL query param. Useful for plugin SPAs
 * that pass extra context alongside the JWT (e.g. `?c=<channelId>` or
 * `?s=<sessionId>`).
 */
export function readQueryParamAndStrip(name: string): string | null {
  if (typeof window === "undefined") return null;
  const u = new URL(window.location.href);
  const v = u.searchParams.get(name);
  if (!v) return null;
  u.searchParams.delete(name);
  history.replaceState(
    null,
    "",
    u.pathname + (u.search || "") + (u.hash || ""),
  );
  return v;
}
