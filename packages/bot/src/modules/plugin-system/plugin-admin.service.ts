import {
  deletePlugin,
  findPluginById,
  setPluginApprovedGlobalEventSubs,
  setPluginApprovedRpcScopes,
  setPluginEnabled as setEnabledModel,
  type PluginRow,
} from "./models/plugin.model.js";
import { deleteAllCapabilities } from "./models/plugin-capability.model.js";
import { pluginAuthStore, PluginAuthStore } from "./plugin-auth.service.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { emitPluginChange } from "./plugin-changes.js";
import {
  invalidatePluginByKey,
  invalidatePluginById,
} from "./plugin-lookup-cache.js";
import { pluginCommandRegistry } from "./plugin-command-registry.service.js";
import {
  pluginRegistry,
  PluginRegistry,
  purgePluginCapabilityGrants,
} from "./plugin-registry.service.js";
import { dropDispatchPoolForPlugin } from "./plugin-event-bridge.service.js";
import { clearDispatchHealth } from "./plugin-dispatch-health.service.js";
import { recordAudit } from "../admin/admin-audit.service.js";
import type { CommandReconciler } from "../command-system/reconcile.service.js";
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
 * refusal (glossary: Admin Refusal). The delete teardown (#49) also
 * refuses only a missing plugin — its refuse-an-active-plugin 409 guard
 * predates the move and stayed with the route, so that increment could
 * remain a pure move; folding it in as a `conflict` member is a call for
 * a later increment, not a fait accompli. The next member arrives with
 * A3: the config writes refuse a payload that fails validation.
 * Collapsing this to `null` or an exception now would cost the
 * compiler's exhaustiveness check on every route that maps one, which is
 * the whole reason the convention exists.
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

  /**
   * The delete teardown (#49) — the one place to read to learn what
   * deleting a plugin does. Seven ordered steps (1, 2, 2b, 3, 3b, 4,
   * 4b below), four of them drops of caches that don't own their own
   * invalidation. Best-effort steps stay best-effort: a failing cache
   * drop must never block removal of a misbehaving plugin, and each
   * failing step says which one it was via the bot event log.
   *
   * Callers' responsibilities, both deliberate:
   *   - The refuse-an-active-plugin 409 guard stays with the route
   *     (pre-existing behaviour, kept route-side so #49 stayed a pure
   *     move — see the {@link AdminRefusal} comment).
   *   - `getReconciler` is passed as a thunk because the reconciler is
   *     route-injected wiring; it is resolved at step 3b, exactly where
   *     the route resolved it before the move.
   */
  async teardown(
    pluginId: number,
    actor: string | undefined,
    getReconciler: () => CommandReconciler,
  ): Promise<AdminOutcome<void>> {
    const plugin = await findPluginById(pluginId);
    if (!plugin) return { ok: false, refusal: "not_found" };

    // 1. Revoke in-memory token so any lingering bearer auth fails.
    this.auth.revokeByPluginId(pluginId);

    // 2. Unregister Discord commands (best-effort; logs internally).
    // unregisterAll 刪 DB rows + feature 半部 Discord 指令（discordCommandId 有值）。
    // global 軌三指令（discordCommandId=null）無法由 deleteOne 直接刪，
    // 由後續 reconcileAll 透過 stale 清除機制從名冊 diff 刪除 Discord 端（Batch 1 #4）。
    await pluginCommandRegistry.unregisterAll(pluginId).catch(() => {
      /* logged inside unregisterAll */
    });

    // 2b. Purge this plugin's RBAC capability grants from every role
    // (and drop its plugin_capabilities rows). ON DELETE CASCADE would
    // clear the rows anyway, but the `plugin:<key>:*` tokens stored in
    // admin_role_capabilities are plain strings with no FK, so they
    // must be removed explicitly — otherwise they'd linger and re-bind
    // if a plugin with the same key is ever registered again.
    try {
      const capKeys = await deleteAllCapabilities(pluginId);
      await purgePluginCapabilityGrants(plugin.pluginKey, capKeys);
    } catch (err) {
      botEventLog.record(
        "warn",
        "bot",
        `plugin-admin: capability cleanup failed during delete of ${plugin.pluginKey}: ${err instanceof Error ? err.message : String(err)}`,
        { pluginId },
      );
    }

    // 3. Destroy the DB row. ON DELETE CASCADE wipes related tables.
    await deletePlugin(pluginId);

    // 3b. reconcileAll：讓 reconciler stale 清除機制刪除 Discord 端 global 指令。
    // deletePlugin 後 desired set 不含此 plugin 的指令，reconciler diff 會發現名冊有但
    // desired set 沒，自動刪 Discord 端。非同步觸發，不阻擋 204 回應。
    getReconciler()
      .reconcileAll()
      .catch((err: unknown) => {
        botEventLog.record(
          "warn",
          "bot",
          `plugin-admin: plugin delete 後 reconcileAll 失敗: ${err instanceof Error ? err.message : String(err)}`,
          { pluginId },
        );
      });

    // 4. Drop the deleted plugin from the event-dispatch index
    //    (O(1) instead of a full rebuild), the proxy/lookup cache,
    //    and the dispatch pool (so a previously-tripped breaker
    //    doesn't survive a same-URL re-register).
    emitPluginChange({ pluginId, row: null });
    invalidatePluginById(pluginId);
    dropDispatchPoolForPlugin(plugin.pluginKey);
    clearDispatchHealth(plugin.pluginKey);

    // 4b. Clear the health + metrics snapshots keyed by pluginKey. Same
    // rationale as the dispatch-pool drop above: a plugin re-registered
    // under the same key must not inherit the deleted plugin's stale
    // health/metrics (which live up to the store's freshness TTL), and
    // orphaned entries shouldn't linger across delete churn. Best-effort
    // — a store error must not block the delete (the DB row is gone).
    try {
      const { clearHealth } = await import("./plugin-health-store.js");
      const { clearSnapshot } = await import("./plugin-metrics-store.js");
      await Promise.all([
        clearHealth(plugin.pluginKey),
        clearSnapshot(plugin.pluginKey),
      ]);
    } catch (err) {
      botEventLog.record(
        "warn",
        "bot",
        `plugin-admin: health/metrics cleanup failed during delete of ${plugin.pluginKey}: ${err instanceof Error ? err.message : String(err)}`,
        { pluginId },
      );
    }

    // Audit + operation log.
    await recordAudit(actor ?? "system", "plugin.delete", String(pluginId), {
      pluginKey: plugin.pluginKey,
    });
    botEventLog.record(
      "warn",
      "bot",
      `Plugin deleted by admin: ${plugin.pluginKey} (id=${pluginId})`,
      { pluginId, pluginKey: plugin.pluginKey, actor },
    );

    return { ok: true, value: undefined };
  }
}

export const pluginAdmin = new PluginAdmin(pluginAuthStore, pluginRegistry);
