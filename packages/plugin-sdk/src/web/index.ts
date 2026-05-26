// @karyl-chan/plugin-sdk/web — browser-side helpers for plugin SPAs.
//
// Lives under the `./web` subpath of the SDK so plugin authors can
// import everything plugin-related from one package:
//   import { definePlugin, ... } from "@karyl-chan/plugin-sdk";          // Node
//   import { API_BASE, createAuthState } from "@karyl-chan/plugin-sdk/web"; // browser

export { API_BASE, joinApiUrl } from "./plugin-base";
export {
  decodeJwt,
  readTokenFromUrl,
  readQueryParamAndStrip,
} from "./jwt";
export type { JwtClaims } from "./jwt";
export {
  createAuthState,
  exchangeJwtForPair,
} from "./auth";
export type {
  AuthState,
  AuthStateBundle,
  BearerPair,
} from "./auth";
export { createPluginApi } from "./api";
export type { PluginApi, PluginApiOptions } from "./api";
export { openSseChannel } from "./sse";
export type { SseChannel, SseChannelOptions } from "./sse";

// One-call orchestrator that composes auth + api into a single
// SessionHandle. Plugin SPAs go from 80-line bootstrap to one await
// call. Pass `exchangeJwt: true` for pages that want the access +
// refresh pair flow; omit for pages that use the boot JWT directly.
export { bootstrapPluginSession } from "./bootstrap";
export type { BootstrapOptions, SessionHandle } from "./bootstrap";
