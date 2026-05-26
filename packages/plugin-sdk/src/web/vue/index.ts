/**
 * Vue 3 adapter for `@karyl-chan/plugin-sdk/web`'s SessionHandle.
 *
 * `useSession(handle)` lifts the handle's mode + claims into a reactive
 * `ref<AuthMode>` and `ref<JwtClaims | null>` so Vue templates can
 * react without manual `subscribe()` plumbing. The underlying handle
 * is unaffected — vanilla DOM SPAs still use it directly without
 * touching this adapter.
 *
 * Imports `vue` as a peer dep. Plugin SPAs that already depend on Vue
 * pick this up via `import { useSession } from "@karyl-chan/plugin-sdk/web/vue"`.
 */

import {
  onBeforeUnmount,
  readonly,
  ref,
  type DeepReadonly,
  type Ref,
} from "vue";
import type {
  AuthMode,
  AuthState,
  JwtClaims,
  PluginApi,
  SessionHandle,
} from "../index.js";

export interface UseSessionResult {
  /** Reactive auth mode — updates on every setSessionToken / setManageTokens / clear / refresh. */
  mode: DeepReadonly<Ref<AuthMode>>;
  /**
   * Reactive JWT claims. Static after bootstrap — the SDK does not
   * re-decode on refresh. Plugins that need the freshest claims should
   * call `decodeJwt(handle.auth.getSessionToken() ?? "")` themselves.
   */
  claims: DeepReadonly<Ref<JwtClaims | null>>;
  /** Convenience accessor for the API client — same instance as handle.api. */
  api: PluginApi;
  /** Underlying auth state for advanced callers. */
  auth: AuthState;
  /** Underlying handle for advanced callers (e.g. raw subscribe). */
  handle: SessionHandle;
}

/**
 * Bind a `SessionHandle` into Vue reactivity. Call from a component's
 * setup() and discard the return on unmount — the adapter wires
 * `onBeforeUnmount` to drop the mode-change subscription. Does NOT
 * call `handle.destroy()` — the handle is typically app-scoped, not
 * component-scoped; the caller decides when to tear it down.
 */
export function useSession(handle: SessionHandle): UseSessionResult {
  const mode = ref<AuthMode>(handle.mode);
  const claims = ref<JwtClaims | null>(handle.claims);
  const unsubscribe = handle.subscribe((next) => {
    mode.value = next;
  });
  onBeforeUnmount(() => {
    unsubscribe();
  });
  return {
    mode: readonly(mode),
    claims: readonly(claims),
    api: handle.api,
    auth: handle.auth,
    handle,
  };
}
