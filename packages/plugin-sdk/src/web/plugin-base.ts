/**
 * @karyl-chan/plugin-sdk/web — browser-side helpers for plugin SPAs.
 *
 * Mirror of the patterns the three reference plugins (radio, quest-game,
 * xiangqi) duplicated inline in their `web/src/api.ts`. Pulling them into
 * the SDK means new plugins only need to wire a small adapter rather than
 * re-implement JWT decoding, manage-exchange/refresh state machine, and
 * SSE reconnect logic.
 *
 * IMPORTANT: This module is browser-only — no Node imports. It is shipped
 * as the `./web` subpath export of `@karyl-chan/plugin-sdk` and built as
 * source-as-published (no separate compilation step). Consumers using
 * Bundler/ESNext module resolution see the .ts source directly.
 */

declare global {
  interface Window {
    /** Injected by the plugin's HTTP server at SPA-HTML-render time —
     *  the path prefix the plugin is served under (e.g. `/plugin/karyl-radio`).
     *  Empty string when the SPA is hit directly (dev mode). */
    __PLUGIN_BASE__?: string;
  }
}

/**
 * Browser-reachable API base URL for the plugin. Reads the
 * `window.__PLUGIN_BASE__` value the server-side template injection puts
 * in `<head>` before the SPA boot.
 *
 * Production (behind bot proxy): origin + `/plugin/<key>`.
 * Dev / direct access:           origin + ``.
 *
 * Computed once at import time — plugin servers inject the base before
 * the SPA's <script> tag executes, so a stale read isn't possible.
 */
export const API_BASE: string =
  typeof window !== "undefined"
    ? window.location.origin + (window.__PLUGIN_BASE__ ?? "")
    : "";

/** Strip a trailing slash if `API_BASE` happens to be the bare origin. */
export function joinApiUrl(path: string): string {
  if (!path.startsWith("/")) return `${API_BASE}/${path}`;
  return API_BASE + path;
}
