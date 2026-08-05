import {
  findPluginById,
  setPluginApprovedGlobalEventSubs,
  setPluginApprovedRpcScopes,
  setPluginEnabled as setEnabledModel,
  type PluginRow,
} from "./models/plugin.model.js";
import { pluginAuthStore, PluginAuthStore } from "./plugin-auth.service.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { emitPluginChange } from "./plugin-changes.js";
import {
  invalidatePluginByKey,
  invalidatePluginById,
} from "./plugin-lookup-cache.js";
import { pluginCommandRegistry } from "./plugin-command-registry.service.js";
import { pluginRegistry, PluginRegistry } from "./plugin-registry.service.js";
import type { PluginManifest } from "@karyl-chan/plugin-wire";

/**
 * Plugin Admin — the entry point for everything an operator does *to* a
 * plugin. Membership is decided by who initiates the action and by
 * nothing else: operator-initiated work lives here, plugin-initiated
 * work (register, heartbeat, deregister, the reaper, the queries the
 * runtime shares) stays with {@link PluginRegistry}.
 *
 * The actor line, and why two error conventions coexist either side of
 * it, are recorded in `docs/adr/0002-plugin-admin-actor-line.md`. Spec of
 * record: the consensus comment on issue #30.
 */

/**
 * The closed set of Admin Refusals — the expected, operator-facing
 * outcomes a Plugin Admin operation can return instead of a value.
 *
 * **It currently has exactly one member, and that is not a mistake.** The
 * operations moved in the first increment (#47) can only fail by naming a
 * plugin that does not exist: their auth guard and their request parsing
 * both resolve *before* the operation is reached, so neither produces a
 * refusal (glossary: Admin Refusal). Later increments add members — the
 * delete teardown refuses an active plugin (conflict), and the config
 * writes refuse a payload that fails validation. Collapsing this to
 * `null` or an exception now would cost the compiler's exhaustiveness
 * check on every route that maps one, which is the whole reason the
 * convention exists.
 */
export type AdminRefusal = "not_found";

/**
 * What a Plugin Admin operation returns: a value, or an Admin Refusal.
 * Routes translate the refusal into a status code and are forced by the
 * compiler to cover every member — see {@link unhandledRefusal}.
 */
export type AdminOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: AdminRefusal };

/**
 * Exhaustiveness guard for a route's refusal mapping. Put it in the
 * `default` arm of the switch: while every member is handled the
 * argument narrows to `never` and this compiles; the moment a member is
 * added to {@link AdminRefusal} without a matching arm, the call stops
 * type-checking. That is the "enforced by the compiler, not by review"
 * part of the convention.
 */
export function unhandledRefusal(refusal: never): never {
  throw new Error(`unhandled Admin Refusal: ${String(refusal)}`);
}

/** A plugin's RPC scope (or global event subscription) approval state. */
export interface PluginScopeState {
  requested: string[];
  approved: string[];
  pending: string[];
}

export class PluginAdmin {
  constructor(
    private readonly auth: PluginAuthStore,
    /**
     * Only for `getScopeState`, which is an admin *read* and therefore
     * moves here with the rest of the admin reads in increment A4. Until
     * then, reading it from its current home beats keeping a second copy
     * of the manifest parse.
     */
    private readonly registry: PluginRegistry,
  ) {}

  /**
   * Admin toggle. Disabling a plugin revokes its token immediately —
   * any in-flight RPC fails with 401. Re-enabling requires the plugin
   * to re-register (no automatic resurrection).
   */
  async setEnabled(
    pluginId: number,
    enabled: boolean,
  ): Promise<AdminOutcome<PluginRow>> {
    const row = await setEnabledModel(pluginId, enabled);
    if (!row) return { ok: false, refusal: "not_found" };
    if (!enabled) {
      this.auth.revokeByPluginId(pluginId);
      // Strip Discord-side commands for the disabled plugin so users
      // don't see ghost commands they can't invoke.
      await pluginCommandRegistry.unregisterAll(pluginId).catch(() => {
        /* logged inside the registry */
      });
    } else {
      // Re-enable: re-sync commands. The plugin row's manifestJson
      // is still authoritative even though the plugin process may
      // have heartbeat-expired. If status='inactive' we skip — sync
      // will run again when the plugin re-registers.
      if (row.status === "active") {
        const manifest = (() => {
          try {
            return JSON.parse(row.manifestJson) as PluginManifest;
          } catch {
            return null;
          }
        })();
        if (manifest) {
          await pluginCommandRegistry.sync(row, manifest).catch(() => {
            /* logged inside the registry */
          });
        }
      }
    }
    // Toggling enabled flips whether this plugin appears in event
    // dispatch fan-out — subscribers apply the delta from the post-
    // mutation row instead of walking every plugin.
    emitPluginChange({ pluginId, row });
    // Invalidate proxy/lookup cache so the next request sees the
    // new enabled / status.
    invalidatePluginByKey(row.pluginKey);
    return { ok: true, value: row };
  }

  /**
   * Set a plugin's approved RPC scope set (admin approve / deny). The
   * approved set is intersected with what the manifest actually requests
   * — an admin can't grant a scope the plugin never declared. Persists
   * the result and updates the plugin's live token in place so the change
   * takes effect immediately, without waiting for a re-register.
   */
  async setApprovedScopes(
    pluginId: number,
    scopes: string[],
  ): Promise<AdminOutcome<PluginScopeState>> {
    const state = await this.registry.getScopeState(pluginId);
    if (!state) return { ok: false, refusal: "not_found" };
    // Clamp to the requested set and de-dup; an admin can only approve
    // what the manifest declares.
    const approved = [...new Set(scopes)].filter((s) =>
      state.requested.includes(s),
    );
    const row = await setPluginApprovedRpcScopes(pluginId, approved);
    if (!row) return { ok: false, refusal: "not_found" };
    // Live-update the cached token's scopes so RPC calls see the new
    // grant at once. No-op if the plugin has no live token (it'll pick
    // the set up from the persisted column on its next register).
    this.auth.setScopesByPluginId(pluginId, approved);
    invalidatePluginById(pluginId);
    botEventLog.record(
      "info",
      "bot",
      `Plugin '${row.pluginKey}' approved RPC scopes updated: [${approved.join(", ")}]`,
      { pluginId, approved },
    );
    const pending = state.requested.filter((s) => !approved.includes(s));
    return {
      ok: true,
      value: { requested: state.requested, approved, pending },
    };
  }

  /**
   * Approve every scope the plugin currently requests. Convenience over
   * `setApprovedScopes` for the common "approve all" admin action.
   */
  async approveAllScopes(
    pluginId: number,
  ): Promise<AdminOutcome<PluginScopeState>> {
    const state = await this.registry.getScopeState(pluginId);
    if (!state) return { ok: false, refusal: "not_found" };
    return this.setApprovedScopes(pluginId, state.requested);
  }

  /**
   * Set the admin-approved GLOBAL event subscription grant (PM-8) —
   * mirrors setApprovedScopes: clamps to what the manifest declares,
   * persists, and re-indexes event routes so the change takes effect
   * without a re-register. Only meaningful with PLUGIN_AUTO_APPROVE=false
   * (auto-approve grants the declared set at index build regardless).
   */
  async setApprovedGlobalEventSubs(
    pluginId: number,
    subs: string[],
  ): Promise<AdminOutcome<PluginScopeState>> {
    const plugin = await findPluginById(pluginId);
    if (!plugin) return { ok: false, refusal: "not_found" };
    const requested = (() => {
      try {
        return (
          (JSON.parse(plugin.manifestJson) as PluginManifest)
            .events_subscribed_global ?? []
        ).filter((e): e is string => typeof e === "string" && e.length > 0);
      } catch {
        return [];
      }
    })();
    const approved = [...new Set(subs)].filter((e) => requested.includes(e));
    const row = await setPluginApprovedGlobalEventSubs(pluginId, approved);
    if (!row) return { ok: false, refusal: "not_found" };
    // Routes are derived from the grant at index build — re-apply now.
    emitPluginChange({ pluginId, row });
    invalidatePluginById(pluginId);
    botEventLog.record(
      "info",
      "bot",
      `Plugin '${row.pluginKey}' approved global event subscriptions updated: [${approved.join(", ")}]`,
      { pluginId, approved },
    );
    const pending = requested.filter((e) => !approved.includes(e));
    return { ok: true, value: { requested, approved, pending } };
  }
}

export const pluginAdmin = new PluginAdmin(pluginAuthStore, pluginRegistry);
