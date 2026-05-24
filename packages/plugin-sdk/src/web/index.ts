// @karyl-chan/plugin-sdk/web — browser-side helpers for plugin SPAs.
//
// Lives under the `./web` subpath of the SDK so plugin authors can
// import everything plugin-related from one package:
//   import { definePlugin, ... } from "@karyl-chan/plugin-sdk";        // Node
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
  exchangeManageJwt,
} from "./auth";
export type { AuthMode, AuthState, ManageTokens } from "./auth";
export { createPluginApi } from "./api";
export type { PluginApi, PluginApiOptions } from "./api";
export { openSseChannel } from "./sse";
export type { SseChannel, SseChannelOptions } from "./sse";
