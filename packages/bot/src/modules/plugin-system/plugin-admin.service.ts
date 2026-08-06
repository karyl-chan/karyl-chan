import {
  deletePlugin,
  findAllPlugins,
  findPluginById,
  findPluginByKey,
  setPluginApprovedGlobalEventSubs,
  setPluginApprovedRpcScopes,
  setPluginConfigSchemaVersion,
  setPluginEnabled as setEnabledModel,
  setPluginSetupSecretHash,
  upsertPluginRegistration,
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
  purgePluginCapabilityGrants,
} from "./plugin-registry.service.js";
import { dropDispatchPoolForPlugin } from "./plugin-event-bridge.service.js";
import {
  clearDispatchHealth,
  getDispatchHealth,
} from "./plugin-dispatch-health.service.js";
import { evaluateSdkCompatFromManifestJson } from "./plugin-sdk-compat.js";
import { evaluateEventSubscriptionsFromManifestJson } from "./plugin-event-subscriptions.js";
import { config } from "../../config.js";
import { kvUsageByPlugin } from "./models/plugin-kv.model.js";
import { quotaForGuildKv } from "./plugin-kv-quota.js";
import { findConfigByPluginAndSource } from "./models/plugin-config.model.js";
import {
  deletePluginCommandsByPlugin,
  findPluginCommandsByPlugin,
  PluginCommand,
} from "./models/plugin-command.model.js";
import { deleteConfigByPlugin } from "./models/plugin-config.model.js";
import { deleteKvByPlugin } from "./models/plugin-kv.model.js";
import { deleteFeatureRowsByPlugin } from "../feature-toggle/models/plugin-guild-feature.model.js";
import { deleteFeatureDefaultsByPlugin } from "../feature-toggle/models/plugin-feature-default.model.js";
import {
  findAllFeatureDefaults,
  upsertFeatureDefault,
  type PluginFeatureDefaultRow,
} from "../feature-toggle/models/plugin-feature-default.model.js";
import { recordAudit } from "../admin/admin-audit.service.js";
import type { CommandReconciler } from "../command-system/reconcile.service.js";
import type { PluginManifest } from "@karyl-chan/plugin-wire";
import {
  configIntake,
  type FieldValidationError,
} from "./config-validator.js";
import { encryptSecret } from "../../utils/crypto.js";
import {
  deleteFeatureRow,
  findFeatureRowsByPlugin,
  upsertFeatureRow,
  type PluginGuildFeatureRow,
} from "../feature-toggle/models/plugin-guild-feature.model.js";
import { featureReachResolver } from "../feature-toggle/feature-reach-resolver.js";
import { upsertConfigKey } from "./models/plugin-config.model.js";
import { dispatchLifecycleToPlugin } from "./plugin-lifecycle-dispatch.service.js";
import { probePluginDispatch } from "./plugin-dispatch-probe.service.js";
import { logger } from "../../logger.js";
import { createHash, randomBytes } from "crypto";

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
 * A discriminated union rather than a string union since A3 (#50):
 * a config save that fails validation is a refusal WITH a payload —
 * the accumulated field errors the admin UI renders — so members carry
 * data and routes switch on `kind`. The exhaustiveness guarantee is
 * unchanged: `switch (outcome.refusal.kind)` with
 * {@link unhandledRefusal} in `default` narrows to `never` only while
 * every member is mapped, so adding a member stops every route from
 * compiling until it says what status code that refusal becomes.
 *
 * Every route maps every member, including members its operation can
 * never return — that is the convention's price, paid so the mapping
 * stays mechanical: each member has one canonical translation
 * (`not_found`/`feature_not_found` → 404, `validation_failed` → 422
 * with `{ error, fieldErrors }`, a shape the frontend parses and which
 * must stay byte-identical; `conflict` → 409 `{ error: message }`;
 * `override_not_found` → 404 `{ error: "no per-guild override to
 * clear" }`; `not_toggleable` → 400 `{ error: message }`). Unreachable
 * members still map to their canonical status — never to
 * `unhandledRefusal` — per the #50 precedent for impossible arms.
 *
 * A5 (#52) closed the set's last route-side hole: the delete teardown's
 * refuse-an-active-plugin 409 guard, deferred by #49, is now the
 * `conflict` member returned by {@link PluginAdmin.teardown} itself.
 */
export type AdminRefusal =
  | { kind: "not_found" }
  | { kind: "feature_not_found"; featureKey: string }
  | {
      kind: "validation_failed";
      fieldErrors: FieldValidationError[];
    }
  /** The operation refuses because of the target's current state (delete of an active plugin). Canonical: 409. */
  | { kind: "conflict"; message: string }
  /** Clearing a Guild Override that doesn't exist. Canonical: 404. */
  | { kind: "override_not_found" }
  /** The target row exists but this operation doesn't apply to it (a feature command toggled via the third-track endpoint). Canonical: 400. */
  | { kind: "not_toggleable"; message: string };

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
  throw new Error(`unhandled Admin Refusal: ${JSON.stringify(refusal)}`);
}

/** A plugin's RPC scope (or global event subscription) approval state. */
export interface PluginScopeState {
  requested: string[];
  approved: string[];
  pending: string[];
}

export class PluginAdmin {
  constructor(private readonly auth: PluginAuthStore) {}

  /**
   * Admin view of a plugin's RPC scope state: what the current manifest
   * requests, what's approved, and the still-pending delta. Returns null
   * if the plugin doesn't exist. Moved from `PluginRegistry` with the
   * A4 admin-reads batch (#51) — it is an admin read, so the actor line
   * puts it here; the constructor's registry dependency went with it.
   */
  async getScopeState(pluginId: number): Promise<PluginScopeState | null> {
    const row = await findPluginById(pluginId);
    if (!row) return null;
    const requested = (() => {
      try {
        return (
          (JSON.parse(row.manifestJson) as PluginManifest).rpc_methods_used ??
          []
        );
      } catch {
        return [];
      }
    })();
    const approved = row.approvedRpcScopes;
    const pending = requested.filter((s) => !approved.includes(s));
    return { requested, approved, pending };
  }

  // ─── Admin reads (A4, #51) ───────────────────────────────────────
  //
  // Decision 2: Plugin Admin is the complete admin-facing entry, reads
  // included, so an admin route depends on this module and nothing
  // else. Each read assembles the exact payload its route used to
  // compose inline — the response bodies are consumed by the frontend
  // and must stay byte-identical, so the assembly functions below are
  // verbatim moves, field order preserved. Reads that can miss return
  // an Admin Refusal like every other operation.

  /**
   * The admin plugin list (GET /api/plugins): every known plugin, each
   * entry assembled from the row plus the four runtime sources — the
   * sdk-compat verdict, the Subscription Verdict, dispatch health, and
   * background command-sync state. A list cannot miss, so this returns
   * the entries directly rather than an {@link AdminOutcome}.
   */
  async listPlugins(): Promise<AdminPluginListEntry[]> {
    const rows = await findAllPlugins();
    return rows.map((p) => assembleAdminListEntry(p));
  }

  /**
   * Single plugin detail (GET /api/plugins/:id): manifest snapshot plus
   * command-sync / dispatch / compat verdicts, with the latest health
   * probe + metrics snapshot inlined so the admin UI doesn't need a
   * second round-trip per plugin card.
   */
  async getPluginDetail(
    pluginId: number,
  ): Promise<AdminOutcome<AdminPluginDetail>> {
    const p = await findPluginById(pluginId);
    if (!p) return { ok: false, refusal: { kind: "not_found" } };
    return { ok: true, value: await assemblePluginDetail(p) };
  }

  /**
   * Plugin detail by key (GET /api/plugins/by-key/:pluginKey) — the
   * plugin 詳情頁 payload: same fields as the by-id detail plus the
   * read-only rpcMethods / scope-approval state and the third-track
   * (featureKey=null) plugin commands.
   */
  async getPluginDetailByKey(
    pluginKey: string,
  ): Promise<AdminOutcome<AdminPluginDetailByKey>> {
    const p = await findPluginByKey(pluginKey);
    if (!p) return { ok: false, refusal: { kind: "not_found" } };
    return { ok: true, value: await assemblePluginDetailByKey(p) };
  }

  /**
   * Every feature offered by every plugin, joined with this guild's
   * override / config state (GET /api/plugins/guilds/:guildId/features).
   * Pure read, aggregated across plugins so the UI doesn't have to N+1
   * the manifest store. An unknown guild simply yields entries with no
   * overrides — not a miss, so no refusal.
   */
  async listGuildFeatures(guildId: string): Promise<AdminGuildFeatureItem[]> {
    const plugins = await findAllPlugins();
    const items: AdminGuildFeatureItem[] = [];
    for (const p of plugins) {
      const manifest = safeParseJson(p.manifestJson) as PluginManifest | null;
      if (!manifest) continue;
      const resolved = await featureReachResolver.resolveGuildFeatures(
        p.id,
        guildId,
        manifest,
      );
      for (const f of manifest.guild_features ?? []) {
        const feature = resolved.get(f.key);
        if (!feature) continue;
        items.push({
          pluginId: p.id,
          pluginKey: p.pluginKey,
          pluginName: p.name,
          featureKey: f.key,
          name: f.name,
          description: f.description,
          icon: f.icon,
          configSchema: f.config_schema ?? [],
          surfaces: f.surfaces ?? ["bot_functions_tab"],
          enabled: feature.enabled,
          overridden: feature.overridden,
          defaultEnabled: feature.defaultEnabled,
          operatorDefault: feature.operatorDefault,
          manifestDefault: feature.manifestDefault,
          config: feature.row
            ? ((safeParseJson(feature.row.configJson) as Record<
                string,
                unknown
              >) ?? {})
            : {},
          metrics: feature.row
            ? ((safeParseJson(feature.row.metricsJson) as Record<
                string,
                unknown
              >) ?? {})
            : {},
          pluginEnabled: p.enabled,
          pluginStatus: p.status,
        });
      }
    }
    return items;
  }

  /**
   * Cross-plugin "All Servers" overview (GET /api/plugins/feature-
   * defaults): every plugin × feature with the manifest default, the
   * operator override (if any), and the per-guild opt-in/out counts.
   * Defaults effective = override ?? manifest_default ?? false.
   */
  async listFeatureDefaults(): Promise<AdminFeatureDefaultItem[]> {
    const plugins = await findAllPlugins();
    const overrides = await findAllFeatureDefaults();
    const overrideByKey = new Map<string, PluginFeatureDefaultRow>(
      overrides.map((o) => [`${o.pluginId}:${o.featureKey}`, o]),
    );
    const items: AdminFeatureDefaultItem[] = [];
    for (const p of plugins) {
      const manifest = safeParseJson(p.manifestJson) as PluginManifest | null;
      if (!manifest) continue;
      const guildRows = await findFeatureRowsByPlugin(p.id);
      for (const f of manifest.guild_features ?? []) {
        const override = overrideByKey.get(`${p.id}:${f.key}`);
        const manifestDefault = !!f.enabled_by_default;
        const effective = override ? override.enabled : manifestDefault;
        const guildRowsForFeature = guildRows.filter(
          (r) => r.featureKey === f.key,
        );
        items.push({
          pluginId: p.id,
          pluginKey: p.pluginKey,
          pluginName: p.name,
          pluginEnabled: p.enabled,
          pluginStatus: p.status,
          featureKey: f.key,
          featureName: f.name,
          featureDescription: f.description,
          featureIcon: f.icon,
          manifestDefault,
          override: override ? override.enabled : null,
          effectiveDefault: effective,
          enabledGuildCount: guildRowsForFeature.filter((r) => r.enabled)
            .length,
          disabledGuildCount: guildRowsForFeature.filter((r) => !r.enabled)
            .length,
        });
      }
    }
    return items;
  }

  /**
   * The admin config editor payload (GET /api/plugins/:id/config): the
   * manifest's config_schema joined with currently-stored values,
   * secrets masked. Plugin-self KV (source='plugin') is excluded —
   * that's the plugin's private state, not admin-controlled.
   */
  async getPluginConfig(
    pluginId: number,
  ): Promise<AdminOutcome<AdminConfigEditorPayload>> {
    const plugin = await findPluginById(pluginId);
    if (!plugin) return { ok: false, refusal: { kind: "not_found" } };
    return { ok: true, value: await buildConfigPayload(plugin) };
  }

  /**
   * One-shot payload for the plugin's "設定" tab (GET
   * /api/plugins/:id/settings, PD-2.2): the config editor payload PLUS
   * the cross-surface overview — which guilds override which features,
   * and per-guild KV usage vs quota (COUNT/bytes only, never values —
   * the PD-2.1 boundary).
   *
   * `resolveGuildName` is passed in like teardown's `getReconciler`:
   * guild names live in the route-injected discord.js client's cache,
   * which is route wiring, not admin state. null = the bot isn't in
   * that guild / cache miss; the UI falls back to the id.
   */
  async getPluginSettings(
    pluginId: number,
    resolveGuildName: (guildId: string) => string | null,
  ): Promise<AdminOutcome<AdminPluginSettings>> {
    const plugin = await findPluginById(pluginId);
    if (!plugin) return { ok: false, refusal: { kind: "not_found" } };
    const [config, kvGuilds, kvQuotaBytes, featureRows] = await Promise.all([
      buildConfigPayload(plugin),
      kvUsageByPlugin(pluginId),
      quotaForGuildKv(pluginId),
      findFeatureRowsByPlugin(pluginId),
    ]);
    const guildNames: Record<string, string | null> = {};
    for (const gid of new Set([
      ...kvGuilds.map((g) => g.guildId),
      ...featureRows.map((r) => r.guildId),
    ])) {
      guildNames[gid] = resolveGuildName(gid);
    }
    return {
      ok: true,
      value: {
        config,
        kv: { quotaBytes: kvQuotaBytes, guilds: kvGuilds },
        featureOverrides: featureRows.map((r) => ({
          guildId: r.guildId,
          featureKey: r.featureKey,
          enabled: r.enabled,
        })),
        guildNames,
      },
    };
  }

  /**
   * Admin toggle. Disabling a plugin revokes its token immediately —
   * any in-flight RPC fails with 401. Re-enabling requires the plugin
   * to re-register (no automatic resurrection).
   *
   * On disable, `setEnabled` 內部呼叫 unregisterAll 刪 DB rows；但
   * global 軌三指令的 discordCommandId=null，deleteOne 無法直接刪
   * Discord 端 — 所以最後觸發 reconcileAll，讓 stale 清除機制從名冊
   * diff 刪除 Discord 端指令（Batch 1 #4）。`getReconciler` is a thunk
   * for the same reason as {@link teardown}'s: the reconciler is
   * route-injected wiring, resolved only at the moment it's needed.
   */
  async setEnabled(
    pluginId: number,
    enabled: boolean,
    actor: string | undefined,
    getReconciler: () => CommandReconciler,
  ): Promise<AdminOutcome<PluginRow>> {
    const row = await setEnabledModel(pluginId, enabled);
    if (!row) return { ok: false, refusal: { kind: "not_found" } };
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
    botEventLog.record(
      "info",
      "bot",
      `Plugin ${enabled ? "enabled" : "disabled"} by admin: ${row.pluginKey}`,
      {
        pluginId,
        pluginKey: row.pluginKey,
        enabled,
        actor,
      },
    );
    if (!enabled) {
      getReconciler()
        .reconcileAll()
        .catch((err: unknown) => {
          botEventLog.record(
            "warn",
            "bot",
            // Kept byte-identical through the A5 move (the log line an
            // operator may already alert on), prefix included.
            `plugin-routes: plugin disable 後 reconcileAll 失敗: ${err instanceof Error ? err.message : String(err)}`,
            { pluginId },
          );
        });
    }
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
    actor?: string,
  ): Promise<AdminOutcome<PluginScopeState>> {
    const state = await this.getScopeState(pluginId);
    if (!state) return { ok: false, refusal: { kind: "not_found" } };
    // Clamp to the requested set and de-dup; an admin can only approve
    // what the manifest declares.
    const approved = [...new Set(scopes)].filter((s) =>
      state.requested.includes(s),
    );
    const row = await setPluginApprovedRpcScopes(pluginId, approved);
    if (!row) return { ok: false, refusal: { kind: "not_found" } };
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
    const value = { requested: state.requested, approved, pending };
    botEventLog.record(
      "info",
      "bot",
      `Plugin RPC scopes set by admin (${approved.length} approved, ${pending.length} pending)`,
      { pluginId, ...value, actor },
    );
    return { ok: true, value };
  }

  /**
   * Approve every scope the plugin currently requests. Convenience over
   * `setApprovedScopes` for the common "approve all" admin action.
   */
  async approveAllScopes(
    pluginId: number,
  ): Promise<AdminOutcome<PluginScopeState>> {
    const state = await this.getScopeState(pluginId);
    if (!state) return { ok: false, refusal: { kind: "not_found" } };
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
    actor?: string,
  ): Promise<AdminOutcome<PluginScopeState>> {
    const plugin = await findPluginById(pluginId);
    if (!plugin) return { ok: false, refusal: { kind: "not_found" } };
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
    if (!row) return { ok: false, refusal: { kind: "not_found" } };
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
    const value = { requested, approved, pending };
    botEventLog.record(
      "info",
      "bot",
      `Plugin global event subscriptions set by admin (${approved.length} approved, ${pending.length} pending)`,
      { pluginId, ...value, actor },
    );
    return { ok: true, value };
  }

  /**
   * The delete teardown (#49) — the one place to read to learn what
   * deleting a plugin does. Eight ordered steps (1, 2, 2b, 2c, 3, 3b,
   * 4, 4b below), four of them drops of caches that don't own their
   * own invalidation. Since #59 the child-table rows are deleted
   * explicitly in 2c — nothing cascades from the plugins row (no FK
   * exists anywhere in this schema slice, despite what older comments
   * claimed). Best-effort steps stay best-effort: a failing cache
   * drop must never block removal of a misbehaving plugin, and each
   * failing step says which one it was via the bot event log.
   *
   * An ACTIVE plugin is refused with the `conflict` refusal (409 at the
   * route): the admin must stop the plugin process and wait ~75s for
   * the heartbeat reaper to mark it inactive. #49 kept that guard
   * route-side to stay a pure move; A5 (#52) moved it in, so the whole
   * "can this delete happen" decision lives here.
   *
   * Caller's responsibility, deliberate: `getReconciler` is passed as a
   * thunk because the reconciler is route-injected wiring; it is
   * resolved at step 3b, exactly where the route resolved it before the
   * move.
   */
  async teardown(
    pluginId: number,
    actor: string | undefined,
    getReconciler: () => CommandReconciler,
  ): Promise<AdminOutcome<void>> {
    const plugin = await findPluginById(pluginId);
    if (!plugin) return { ok: false, refusal: { kind: "not_found" } };
    if (plugin.status === "active") {
      return {
        ok: false,
        refusal: {
          kind: "conflict",
          message:
            "cannot delete active plugin; stop the plugin process and wait ~75s for the heartbeat reaper to mark it inactive",
        },
      };
    }

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
    // (and drop its plugin_capabilities rows). Both halves must be
    // explicit: nothing cascades (see 2c), and the `plugin:<key>:*`
    // tokens stored in admin_role_capabilities are plain strings that
    // would otherwise linger and re-bind if a plugin with the same key
    // is ever registered again.
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

    // 2c. Purge the plugin's child rows explicitly (#59). NOTHING
    // cascades: no plugin child model declares an FK `references`, and
    // the `sequelize.sync` DDL carries no ON DELETE CASCADE — a comment
    // here used to claim otherwise, and a plugin_configs row demonstrably
    // survived its plugin's delete. Same precedent as the capability
    // purge in 2b, extended to every remaining child table. Best-effort
    // per table: orphans are hygiene, not correctness (plugin ids are
    // fresh, so a leaked row can never re-bind), and a failing child
    // purge must never block removal of a misbehaving plugin. The
    // plugin_commands sweep repeats what unregisterAll's DB half does in
    // step 2 — deliberately, so the rows still go when Discord is down
    // and step 2 bailed early.
    await Promise.all(
      (
        [
          ["plugin_configs", () => deleteConfigByPlugin(pluginId)],
          ["plugin_kv", () => deleteKvByPlugin(pluginId)],
          ["plugin_guild_features", () => deleteFeatureRowsByPlugin(pluginId)],
          [
            "plugin_feature_defaults",
            () => deleteFeatureDefaultsByPlugin(pluginId),
          ],
          ["plugin_commands", () => deletePluginCommandsByPlugin(pluginId)],
        ] as const
      ).map(([table, purge]) =>
        purge().catch((err: unknown) => {
          botEventLog.record(
            "warn",
            "bot",
            `plugin-admin: ${table} cleanup failed during delete of ${plugin.pluginKey}: ${err instanceof Error ? err.message : String(err)}`,
            { pluginId },
          );
        }),
      ),
    );

    // 3. Destroy the plugins row itself. Nothing cascades from it (see
    // 2c) — every child table is purged explicitly above.
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

  // ─── The two config writes (A3, #50) ─────────────────────────────
  //
  // Both start with the same Config Intake step (config-validator.ts:
  // normalize → validate → secret sentinel → encryption) and then
  // deliberately part ways — decision 7 converges the FRONT HALF ONLY.
  // `saveGuildFeature` writes ONE JSON document holding native types,
  // then syncs feature commands and emits a Plugin Change;
  // `savePluginConfig` writes one string-valued row PER KEY, then
  // stamps the schema version and logs. No shared persistence, no mode
  // flag. Round-trip caveat (decision 8) documented on `configIntake`.

  /**
   * Upsert one per-guild feature row: the enabled toggle and/or the
   * feature's per-guild config document.
   *
   * `enabled === undefined` means "not given" (config-only save): the
   * row keeps today's *effective* value (per-guild row → operator
   * default → manifest default → false) rather than defaulting to
   * false. NOTE: that does mean a config-only save on a guild with no
   * prior row materialises an explicit (`overridden`) row pinned to the
   * current default — so a later operator-default change won't
   * propagate to it. There's no "follow default" sentinel for
   * `plugin_guild_features.enabled` (it's a plain boolean); accepted
   * for now. (No UI does config-only saves without `enabled` yet —
   * `setGuildFeatureEnabled` always sends it.)
   *
   * Back half, this operation's own: the config document is written
   * wholesale with NATIVE types (a boolean field stores `false`, a
   * number field stores `42`), unknown keys are tolerated and passed
   * through verbatim (old guilds may hold orphaned keys from an older
   * schema version), a sentinel-skipped secret keeps its previously
   * stored (encrypted) value, then guild-scoped commands are synced and
   * a Plugin Change is emitted. The plugin's onEnable/onDisable
   * lifecycle fires only when the toggle actually flipped — an
   * unchanged re-submit of `enabled: true` or a config-only save must
   * not re-fire hooks that aren't perfectly idempotent (duplicate
   * timers, INSERT conflicts on seed rows, double-counted metrics).
   */
  async saveGuildFeature(
    input: {
      pluginId: number;
      guildId: string;
      featureKey: string;
      enabled: boolean | undefined;
      config: Record<string, unknown> | undefined;
    },
    actor: string | undefined,
  ): Promise<AdminOutcome<PluginGuildFeatureRow>> {
    const { pluginId, guildId, featureKey } = input;
    const plugin = await findPluginById(pluginId);
    if (!plugin) return { ok: false, refusal: { kind: "not_found" } };
    const manifest = safeParseJson(plugin.manifestJson) as
      | PluginManifest
      | null;
    const feature = manifest?.guild_features?.find((f) => f.key === featureKey);
    if (!feature) {
      return { ok: false, refusal: { kind: "feature_not_found", featureKey } };
    }
    // Resolve the pre-write state up-front: the effective value backs a
    // config-only save, and the prior row lets us detect a real state
    // change for the lifecycle dispatch below.
    const enabledWasGiven = input.enabled !== undefined;
    const resolved = (
      await featureReachResolver.resolveGuildFeatures(
        pluginId,
        guildId,
        manifest!,
      )
    ).get(featureKey);
    const existingRow = resolved?.row ?? null;
    const enabled = enabledWasGiven
      ? input.enabled!
      : (resolved?.enabled ?? false);
    const enabledChanged = enabledWasGiven && existingRow?.enabled !== enabled;

    let configJson: string | undefined;
    if (input.config !== undefined) {
      // Config Intake — the shared front half. Per-caller policy:
      // per-guild feature config historically tolerates unknown keys
      // (orphaned values from an older schema version — we don't want
      // to break old guilds by tightening here).
      const intake = configIntake(feature.config_schema ?? [], input.config, {
        allowUnknownKeys: true,
        encryptSecret,
      });
      if (!intake.ok) {
        return {
          ok: false,
          refusal: {
            kind: "validation_failed",
            fieldErrors: intake.fieldErrors,
          },
        };
      }
      // This path's own storage form: one JSON document, native types.
      const stored: Record<string, unknown> = {};
      for (const entry of intake.entries) {
        if (entry.kind === "unknown") {
          // Preserve the caller's native value so admin scripts that
          // pass `{flag: false, n: 42}` survive a JSON round-trip.
          stored[entry.key] =
            entry.native === undefined ? entry.value : entry.native;
          continue;
        }
        if (entry.field.type === "boolean") {
          stored[entry.key] = entry.value === "true";
          continue;
        }
        if (entry.field.type === "number") {
          stored[entry.key] =
            entry.value.length === 0 ? null : Number(entry.value);
          continue;
        }
        // Secrets arrive from intake already encrypted (or "" when
        // cleared); everything else is the string verbatim.
        stored[entry.key] = entry.value;
      }
      // The document is replaced wholesale, so a sentinel-skipped
      // secret must carry its previously stored (encrypted) value over
      // — "leave the stored value alone" would otherwise drop the key.
      if (intake.skippedSecretKeys.length > 0) {
        const existingDoc = existingRow
          ? ((safeParseJson(existingRow.configJson) as Record<
              string,
              unknown
            >) ?? {})
          : {};
        for (const key of intake.skippedSecretKeys) {
          if (key in existingDoc) stored[key] = existingDoc[key];
        }
      }
      configJson = JSON.stringify(stored);
    }

    const row = await upsertFeatureRow({
      pluginId,
      guildId,
      featureKey,
      enabled,
      configJson,
    });
    // PM-8: event dispatch + RPC gates cache this resolution —
    // subscribers drop this (plugin, guild)'s cached reach.
    emitPluginChange({ pluginId, guildId });
    // Sync the feature's guild-scoped commands to match: enabled →
    // register them in this guild; disabled → delete them. Idempotent
    // (a config-only save just re-confirms the current state).
    {
      const pluginRow = await findPluginById(pluginId);
      const manifestObj = pluginRow
        ? (safeParseJson(pluginRow.manifestJson) as PluginManifest | null)
        : null;
      if (pluginRow && manifestObj) {
        await pluginCommandRegistry
          .syncFeatureCommandsForGuild(
            pluginRow,
            featureKey,
            guildId,
            enabled,
            manifestObj,
          )
          .catch(() => {
            /* logged inside the registry */
          });
      }
    }
    botEventLog.record(
      "info",
      "bot",
      `plugin guild feature ${enabledWasGiven ? (enabled ? "enabled" : "disabled") : "config updated"}: ${plugin.pluginKey}/${featureKey}@${guildId}`,
      { pluginId, guildId, featureKey, enabled, actor },
    );
    // Notify the plugin so it can run onEnable / onDisable hooks.
    // Fire-and-forget: a slow plugin shouldn't delay the admin UI
    // response.
    if (enabledChanged) {
      dispatchLifecycleToPlugin(
        pluginId,
        enabled ? "plugin.guild.enabled" : "plugin.guild.disabled",
        guildId,
        featureKey,
      );
    }
    return { ok: true, value: row };
  }

  /**
   * Save the plugin-level admin config. The full payload runs through
   * Config Intake BEFORE any persistence, so the admin UI gets every
   * field error in one refusal instead of an early-abort on the first
   * bad key. Per-caller policy: unknown keys are REJECTED here (the
   * plugin-level editor always submits schema keys), unlike the
   * per-guild path.
   *
   * Back half, this operation's own: one string-valued row per key
   * ("" = clear/delete, secrets stored encrypted), then the PD-4.3
   * schema-version stamp — so a later manifest config_schema_version
   * bump surfaces as "stale config" — and the audit log entry. Note
   * the round-trip caveat on `configIntake`: this storage form keeps a
   * decision-8-coerced boolean/number as its string form.
   *
   * Returns which keys were written (`accepted`) and which were left
   * untouched by the secret sentinel (`skipped`).
   */
  async savePluginConfig(
    pluginId: number,
    values: Record<string, unknown>,
    actor: string | undefined,
  ): Promise<AdminOutcome<{ accepted: string[]; skipped: string[] }>> {
    const plugin = await findPluginById(pluginId);
    if (!plugin) return { ok: false, refusal: { kind: "not_found" } };
    const manifest = safeParseJson(plugin.manifestJson) as
      | PluginManifest
      | null;
    const schema = manifest?.config_schema ?? [];
    const intake = configIntake(schema, values, {
      allowUnknownKeys: false,
      encryptSecret,
    });
    if (!intake.ok) {
      return {
        ok: false,
        refusal: { kind: "validation_failed", fieldErrors: intake.fieldErrors },
      };
    }
    // This path's own storage form: one string row per key.
    const accepted: string[] = [];
    for (const entry of intake.entries) {
      // allowUnknownKeys:false ⇒ every entry is a declared field; the
      // value is storage-ready (encrypted secret / "" clear / verbatim).
      await upsertConfigKey(pluginId, entry.key, entry.value, "admin");
      accepted.push(entry.key);
    }
    const skipped = intake.skippedSecretKeys;
    // PD-4.3: stamp the schema version this save was written against.
    await setPluginConfigSchemaVersion(
      pluginId,
      manifest?.config_schema_version ?? null,
    );
    botEventLog.record(
      "info",
      "bot",
      `plugin '${plugin.pluginKey}' admin config updated (${accepted.length} keys)`,
      {
        pluginId,
        keys: accepted,
        skippedSecretKeys: skipped,
        actor,
      },
    );
    return { ok: true, value: { accepted, skipped } };
  }

  // ─── The remaining admin routes (A5, #52) ────────────────────────
  //
  // The last orchestration that still lived route-side, moved verbatim
  // so every admin route is a translation layer: request in, operation
  // called, outcome mapped to a status code. Response bodies and log
  // lines are byte-identical to what the routes produced inline.

  /**
   * 軌三指令 on/off toggle (PATCH /api/plugin-commands/:id/admin-
   * enabled). Only featureKey=null third-track commands are toggleable
   * here — featureKey!=null 的軌一指令由 guild feature toggle 管, and
   * asking anyway is the `not_toggleable` refusal. On success the
   * write is followed by a detached reconcile of that one command
   * (fire-and-forget — the admin response doesn't wait on Discord).
   */
  async setPluginCommandAdminEnabled(
    rowId: number,
    enabled: boolean,
    actor: string | undefined,
    getReconciler: () => CommandReconciler,
  ): Promise<AdminOutcome<void>> {
    const row = await PluginCommand.findByPk(rowId);
    if (!row) return { ok: false, refusal: { kind: "not_found" } };
    const featureKey = row.getDataValue("featureKey") as string | null;
    if (featureKey !== null) {
      return {
        ok: false,
        refusal: {
          kind: "not_toggleable",
          message:
            "cannot toggle feature commands via this endpoint; use guild feature toggle",
        },
      };
    }
    await row.update({ adminEnabled: enabled });
    botEventLog.record(
      "info",
      "bot",
      `plugin command adminEnabled=${enabled}: id=${rowId} name=${row.getDataValue("name")}`,
      { rowId, enabled, actor },
    );
    // 非同步觸發 reconcile，不阻塞回應
    getReconciler()
      .reconcileForPluginCommand(rowId)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        botEventLog.record(
          "warn",
          "bot",
          `reconcileForPluginCommand(${rowId}) failed after adminEnabled toggle: ${msg}`,
        );
      });
    return { ok: true, value: undefined };
  }

  /**
   * Clear the explicit Guild Override for one feature (DELETE
   * /api/plugins/:id/guilds/:guildId/features/:featureKey, PD-1.3):
   * the row is removed — including its per-guild config — and the
   * guild reverts to the operator-default → manifest-default chain.
   * Mirrors `saveGuildFeature`'s back half for whatever effective
   * state results: cached reach is dropped, guild-scoped commands are
   * re-synced, and the plugin's onEnable/onDisable lifecycle fires
   * only when the effective value actually flips. No row to clear is
   * the `override_not_found` refusal.
   *
   * Returns the effective enabled value the guild reverts to.
   */
  async clearGuildFeatureOverride(
    input: { pluginId: number; guildId: string; featureKey: string },
    actor: string | undefined,
  ): Promise<AdminOutcome<{ effective: boolean }>> {
    const { pluginId, guildId, featureKey } = input;
    const plugin = await findPluginById(pluginId);
    if (!plugin) return { ok: false, refusal: { kind: "not_found" } };
    const manifest = safeParseJson(plugin.manifestJson) as
      | PluginManifest
      | null;
    const feature = manifest?.guild_features?.find((f) => f.key === featureKey);
    if (!feature) {
      return { ok: false, refusal: { kind: "feature_not_found", featureKey } };
    }
    const resolved = (
      await featureReachResolver.resolveGuildFeatures(
        pluginId,
        guildId,
        manifest!,
      )
    ).get(featureKey);
    const existingRow = resolved?.row;
    if (!resolved || !existingRow) {
      return { ok: false, refusal: { kind: "override_not_found" } };
    }
    const operatorDefault = resolved.operatorDefault;
    // What the guild reverts to once the Guild Override is gone.
    const effective = resolved.defaultEnabled;
    const enabledChanged = existingRow.enabled !== effective;
    await deleteFeatureRow(pluginId, guildId, featureKey);
    // PM-8: event dispatch + RPC gates cache this resolution —
    // subscribers drop this (plugin, guild)'s cached reach.
    emitPluginChange({ pluginId, guildId });
    {
      const pluginRow = await pluginRegistry.findById(pluginId);
      const manifestObj = pluginRow
        ? (safeParseJson(pluginRow.manifestJson) as PluginManifest | null)
        : null;
      if (pluginRow && manifestObj) {
        await pluginCommandRegistry
          .syncFeatureCommandsForGuild(
            pluginRow,
            featureKey,
            guildId,
            effective,
            manifestObj,
          )
          .catch(() => {
            /* logged inside the registry */
          });
      }
    }
    botEventLog.record(
      "info",
      "bot",
      `plugin guild feature override cleared: ${plugin.pluginKey}/${featureKey}@${guildId} (now follows ${operatorDefault !== null ? "operator" : "manifest"} default = ${effective})`,
      { pluginId, guildId, featureKey, effective, actor },
    );
    if (enabledChanged) {
      dispatchLifecycleToPlugin(
        pluginId,
        effective ? "plugin.guild.enabled" : "plugin.guild.disabled",
        guildId,
        featureKey,
      );
    }
    return { ok: true, value: { effective } };
  }

  /**
   * Operator override of a feature's manifest enabled_by_default (PUT
   * /api/plugins/:id/feature-defaults/:featureKey) — the Operator
   * Default tier. Resolution for a guild is: per-guild row → this
   * operator default → manifest default → false. Changing it therefore
   * takes effect immediately in every guild without an explicit
   * per-guild row: cached resolutions for the plugin are dropped, and
   * the feature's slash commands are re-evaluated across every guild —
   * detached, since that can be one Discord API call per guild (a
   * failing guild is logged, never surfaced to the admin request).
   */
  async setFeatureDefault(
    pluginId: number,
    featureKey: string,
    enabled: boolean,
    actor: string | undefined,
  ): Promise<AdminOutcome<PluginFeatureDefaultRow>> {
    const plugin = await findPluginById(pluginId);
    if (!plugin) return { ok: false, refusal: { kind: "not_found" } };
    const manifest = safeParseJson(plugin.manifestJson) as
      | PluginManifest
      | null;
    const feature = manifest?.guild_features?.find((f) => f.key === featureKey);
    if (!manifest || !feature) {
      return { ok: false, refusal: { kind: "feature_not_found", featureKey } };
    }
    const row = await upsertFeatureDefault(pluginId, featureKey, enabled);
    // PM-8: a default change affects every guild without an explicit
    // row — subscribers drop all cached resolutions for this plugin.
    // (No `row`: the plugin row itself is unchanged, so event routes
    // are unaffected.)
    emitPluginChange({ pluginId });
    if (plugin.enabled && plugin.status === "active") {
      void (async () => {
        try {
          await pluginCommandRegistry.syncFeatureCommandsAcrossGuilds(
            plugin,
            manifest,
            featureKey,
          );
        } catch (err) {
          logger.warn(
            { err, pluginId, featureKey },
            "feature-default change: command re-sync failed",
          );
        }
      })();
    }
    botEventLog.record(
      "info",
      "bot",
      `plugin feature default ${row.enabled ? "enabled" : "disabled"}: ${plugin.pluginKey}/${featureKey}`,
      {
        pluginId,
        featureKey,
        enabled: row.enabled,
        actor,
      },
    );
    return { ok: true, value: row };
  }

  /**
   * Manually fire the signed dispatch probe (POST /api/plugins/:id/
   * dispatch-probe, PM-7.9.4) — the same check that runs automatically
   * after register. Returns the verdict plus the refreshed dispatch-
   * health window so the UI can render both without a second
   * round-trip. Side-effect-free on the plugin (the probe payload 400s
   * before any handler lookup).
   *
   * Gate: inactive plugins (no live endpoint) are skipped without
   * traffic. DISABLED-but-active plugins ARE probed — the probe is a
   * control-plane handshake check the admin explicitly requested
   * (e.g. verifying the signature path BEFORE enabling), not a
   * user-traffic dispatch, so the disabled-means-no-dispatch
   * invariant deliberately doesn't apply here.
   */
  async probeDispatch(pluginId: number): Promise<
    AdminOutcome<{
      probe:
        | Awaited<ReturnType<typeof probePluginDispatch>>
        | { outcome: "skipped"; reason: string };
      dispatch: ReturnType<typeof getDispatchHealth>;
    }>
  > {
    const plugin = await pluginRegistry.findById(pluginId);
    if (!plugin) return { ok: false, refusal: { kind: "not_found" } };
    if (plugin.status !== "active") {
      return {
        ok: true,
        value: {
          probe: { outcome: "skipped", reason: "plugin inactive" },
          dispatch: getDispatchHealth(plugin.pluginKey),
        },
      };
    }
    const probe = await probePluginDispatch(plugin);
    return {
      ok: true,
      value: { probe, dispatch: getDispatchHealth(plugin.pluginKey) },
    };
  }

  /**
   * Pre-provision a per-plugin setup secret (POST /api/plugins/setup-
   * secret). The cleartext is returned exactly once — the bot stores
   * only the SHA-256 hash — and must be placed in the plugin's .env as
   * KARYL_PLUGIN_SETUP_SECRET before it can register.
   *
   * If the pluginKey has no DB row yet, a placeholder row is
   * auto-created (status='inactive', enabled=false) so the secret can
   * be stored before the plugin first registers; the plugin's register
   * call fills in the real manifest, url, and token later.
   *
   * Cannot refuse — an unknown key just means a placeholder — so like
   * `listPlugins` this returns its value directly rather than an
   * {@link AdminOutcome}. `secret` is the operator-supplied cleartext
   * (already validated non-empty by the route) or undefined to have a
   * 32-byte hex secret generated.
   */
  async provisionSetupSecret(
    pluginKey: string,
    secret: string | undefined,
    actor: string | undefined,
  ): Promise<{ pluginKey: string; setupSecret: string; created: boolean }> {
    let pluginRow = await findPluginByKey(pluginKey);
    let created = false;
    if (!pluginRow) {
      pluginRow = await upsertPluginRegistration({
        pluginKey,
        name: pluginKey,
        version: "0.0.0",
        url: "http://placeholder",
        manifestJson: "{}",
        tokenHash: "",
        defaultEnabled: false,
      });
      created = true;
      botEventLog.record(
        "info",
        "bot",
        `Admin created placeholder plugin row for '${pluginKey}' via setup-secret`,
        { pluginKey, actor },
      );
    }

    const cleartext =
      typeof secret === "string" && secret.length > 0
        ? secret
        : randomBytes(32).toString("hex");

    const hash = createHash("sha256").update(cleartext).digest("hex");
    await setPluginSetupSecretHash(pluginRow.id, hash);

    await recordAudit(
      actor ?? "system",
      "plugin.setup_secret",
      String(pluginRow.id),
      {
        pluginKey,
        secretSource: secret ? "supplied" : "generated",
        placeholderCreated: created,
      },
    );
    botEventLog.record(
      "info",
      "bot",
      `Per-plugin setup secret set by admin for ${pluginKey}`,
      {
        pluginId: pluginRow.id,
        pluginKey,
        actor,
        placeholderCreated: created,
      },
    );

    return { pluginKey, setupSecret: cleartext, created };
  }
}

function safeParseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ─── Admin read assembly (A4, #51) ─────────────────────────────────
//
// Verbatim moves of the payload assembly the admin GET routes used to
// do inline. Field order is meaning-bearing here: these bodies are
// consumed by the frontend and must stay byte-identical.
//
// `pluginRegistry` below is the module singleton, not a constructor
// dependency: background command-sync state is in-memory, plugin-
// initiated runtime state the registry owns ("the queries the runtime
// shares") — the admin list merely reports it, exactly as the route
// used to.

/**
 * The RPC methods a plugin's manifest declares (`rpc_methods_used`).
 * These ARE the plugin's granted scopes — surfaced read-only in the
 * admin UI; there's no approval step. Malformed manifest → [].
 */
function manifestRpcMethods(manifestJson: string): string[] {
  const m = safeParseJson(manifestJson) as {
    rpc_methods_used?: unknown;
  } | null;
  if (!m || !Array.isArray(m.rpc_methods_used)) return [];
  return m.rpc_methods_used.filter((s): s is string => typeof s === "string");
}

/** Declared GLOBAL event subscriptions (PM-8) — the requested grant set. */
function manifestGlobalEventSubs(manifestJson: string): string[] {
  const m = safeParseJson(manifestJson) as {
    events_subscribed_global?: unknown;
  } | null;
  if (!m || !Array.isArray(m.events_subscribed_global)) return [];
  return m.events_subscribed_global.filter(
    (s): s is string => typeof s === "string",
  );
}

/** One entry in the admin plugin list (GET /api/plugins). */
function assembleAdminListEntry(p: PluginRow) {
  return {
    id: p.id,
    pluginKey: p.pluginKey,
    name: p.name,
    version: p.version,
    url: p.url,
    status: p.status,
    enabled: p.enabled,
    lastHeartbeatAt: p.lastHeartbeatAt,
    manifest: safeParseJson(p.manifestJson),
    rpcMethods: manifestRpcMethods(p.manifestJson),
    // RPC scope approval state (PM-3.1). rpcMethods are the
    // *requested* scopes; approved is the admin-granted subset the
    // token actually carries; pending is the still-unapproved delta.
    approvedRpcScopes: p.approvedRpcScopes,
    pendingRpcScopes: manifestRpcMethods(p.manifestJson).filter(
      (m) => !p.approvedRpcScopes.includes(m),
    ),
    // Global event subscription grant state (PM-8). Mirrors the RPC
    // scope model; with PLUGIN_AUTO_APPROVE=true nothing is ever
    // pending (the index treats declared as granted).
    approvedGlobalEventSubs: config.plugin.autoApproveScopes
      ? manifestGlobalEventSubs(p.manifestJson)
      : p.approvedGlobalEventSubs,
    pendingGlobalEventSubs: config.plugin.autoApproveScopes
      ? []
      : manifestGlobalEventSubs(p.manifestJson).filter(
          (e) => !p.approvedGlobalEventSubs.includes(e),
        ),
    // Background command-sync state (PM-7.1/7.6). null = no sync
    // attempted since this bot process started (e.g. plugin
    // registered before the last bot restart).
    commandSync: pluginRegistry.getCommandSyncState(p.pluginKey),
    // Dispatch-path health (PM-7.9.1). null = no dispatch attempted
    // since this bot process started. Distinct from liveness: a
    // plugin can heartbeat green while rejecting every dispatch
    // (e.g. HMAC scheme mismatch).
    dispatch: getDispatchHealth(p.pluginKey),
    // SDK wire-format compat verdict (PM-7.9.3). `unknown` on a
    // placeholder row just means "never registered" — combine with
    // version === "0.0.0" before alarming.
    sdkCompat: evaluateSdkCompatFromManifestJson(p.manifestJson),
    // Unknown event-subscription verdict (#29 decisions 4/6/7),
    // rendered on the health card next to sdkCompat. Warn-only this
    // release, so an already-registered plugin with a doomed
    // subscription is visible here before the reject phase lands.
    eventSubscriptions: evaluateEventSubscriptionsFromManifestJson(
      p.manifestJson,
    ),
  };
}

export type AdminPluginListEntry = ReturnType<typeof assembleAdminListEntry>;

/** The by-id detail body (GET /api/plugins/:id). */
async function assemblePluginDetail(p: PluginRow) {
  // Surface latest health probe + metrics snapshot inline so the
  // admin UI doesn't need a second round-trip per plugin card.
  const { getHealth } = await import("./plugin-health-store.js");
  const { getSnapshot } = await import("./plugin-metrics-store.js");
  const health = await getHealth(p.pluginKey);
  const metrics = await getSnapshot(p.pluginKey);
  return {
    plugin: {
      id: p.id,
      pluginKey: p.pluginKey,
      name: p.name,
      version: p.version,
      url: p.url,
      status: p.status,
      enabled: p.enabled,
      lastHeartbeatAt: p.lastHeartbeatAt,
      manifest: safeParseJson(p.manifestJson),
    },
    commandSync: pluginRegistry.getCommandSyncState(p.pluginKey),
    dispatch: getDispatchHealth(p.pluginKey),
    sdkCompat: evaluateSdkCompatFromManifestJson(p.manifestJson),
    eventSubscriptions: evaluateEventSubscriptionsFromManifestJson(
      p.manifestJson,
    ),
    ...(health ? { health } : {}),
    ...(metrics ? { metrics } : {}),
  };
}

export type AdminPluginDetail = Awaited<
  ReturnType<typeof assemblePluginDetail>
>;

/** The by-key detail body (GET /api/plugins/by-key/:pluginKey). */
async function assemblePluginDetailByKey(p: PluginRow) {
  const pluginCommands = await findPluginCommandsByPlugin(p.id);
  // 軌三：featureKey=null；軌一：featureKey!=null（不在此 tab 顯示）
  const thirdTrackCommands = pluginCommands.filter(
    (c) => c.featureKey === null,
  );
  // Surface latest health + metrics inline for the overview tab.
  // Both fields are optional — a plugin that hasn't
  // pushed a metrics snapshot yet (just registered) or hasn't been
  // probed yet (admin opened the page before the first 60 s poll)
  // gets the field omitted.
  const { getHealth } = await import("./plugin-health-store.js");
  const { getSnapshot } = await import("./plugin-metrics-store.js");
  const health = await getHealth(p.pluginKey);
  const metrics = await getSnapshot(p.pluginKey);

  return {
    plugin: {
      id: p.id,
      pluginKey: p.pluginKey,
      name: p.name,
      version: p.version,
      url: p.url,
      status: p.status,
      enabled: p.enabled,
      lastHeartbeatAt: p.lastHeartbeatAt,
      manifest: safeParseJson(p.manifestJson),
      rpcMethods: manifestRpcMethods(p.manifestJson),
      // RPC scope approval state (PM-3.1), same shape as the list route.
      approvedRpcScopes: p.approvedRpcScopes,
      pendingRpcScopes: manifestRpcMethods(p.manifestJson).filter(
        (m) => !p.approvedRpcScopes.includes(m),
      ),
      // Global event subscription grant state (PM-8), same shape as list.
      approvedGlobalEventSubs: config.plugin.autoApproveScopes
        ? manifestGlobalEventSubs(p.manifestJson)
        : p.approvedGlobalEventSubs,
      pendingGlobalEventSubs: config.plugin.autoApproveScopes
        ? []
        : manifestGlobalEventSubs(p.manifestJson).filter(
            (e) => !p.approvedGlobalEventSubs.includes(e),
          ),
      // Server-wide flag (PLUGIN_AUTO_APPROVE, default on): when set,
      // every declared scope/global-sub is granted at register time
      // with no operator review — the Security tab surfaces this so an
      // empty "pending" list reads as "auto-approved", not "vetted".
      autoApproveScopes: config.plugin.autoApproveScopes,
      pluginCommands: thirdTrackCommands.map((c) => ({
        id: c.id,
        name: c.name,
        featureKey: c.featureKey,
        adminEnabled: c.adminEnabled,
        manifestJson: c.manifestJson,
      })),
      dispatch: getDispatchHealth(p.pluginKey),
      sdkCompat: evaluateSdkCompatFromManifestJson(p.manifestJson),
      eventSubscriptions: evaluateEventSubscriptionsFromManifestJson(
        p.manifestJson,
      ),
      ...(health ? { health } : {}),
      ...(metrics ? { metrics } : {}),
    },
  };
}

export type AdminPluginDetailByKey = Awaited<
  ReturnType<typeof assemblePluginDetailByKey>
>;

/**
 * Build the admin config-editor payload for a plugin: the manifest's
 * config_schema, current values (secrets masked), and the current vs
 * last-saved config_schema_version (for the stale-config warning). Shared
 * by GET /config and GET /settings.
 */
async function buildConfigPayload(plugin: PluginRow) {
  const manifest = safeParseJson(plugin.manifestJson) as PluginManifest | null;
  const schema = manifest?.config_schema ?? [];
  const rows = await findConfigByPluginAndSource(plugin.id, "admin");
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return {
    schema,
    // PD-4.3: current schema version vs the one the stored config was last
    // saved under. The UI warns when stored < current (stale).
    configSchemaVersion: manifest?.config_schema_version ?? null,
    storedConfigSchemaVersion: plugin.configSchemaVersion,
    values: schema.map((field) => {
      const row = byKey.get(field.key);
      if (!row) return { key: field.key, set: false, value: null };
      if (field.type === "secret") {
        return { key: field.key, set: true, value: "********" };
      }
      return { key: field.key, set: true, value: row.value };
    }),
  };
}

export type AdminConfigEditorPayload = Awaited<
  ReturnType<typeof buildConfigPayload>
>;

/** GET /api/plugins/:id/settings — the "設定" tab's one-shot payload. */
export interface AdminPluginSettings {
  config: AdminConfigEditorPayload;
  kv: {
    quotaBytes: number;
    guilds: Awaited<ReturnType<typeof kvUsageByPlugin>>;
  };
  featureOverrides: Array<{
    guildId: string;
    featureKey: string;
    enabled: boolean;
  }>;
  guildNames: Record<string, string | null>;
}

/** One row of GET /api/plugins/guilds/:guildId/features. */
export interface AdminGuildFeatureItem {
  pluginId: number;
  pluginKey: string;
  pluginName: string;
  featureKey: string;
  name: string;
  description: string | undefined;
  icon: string | undefined;
  configSchema: unknown;
  surfaces: string[];
  /** Effective on/off for this guild: per-guild row → operator default → manifest default → false. */
  enabled: boolean;
  /** True if there's an explicit per-guild row (i.e. the guild overrides the default). */
  overridden: boolean;
  /** The resolved default this guild falls back to when not overridden (operator default → manifest default → false). */
  defaultEnabled: boolean;
  /** The operator-level default ("All Servers"), or null when none is set — lets the UI name which tier `defaultEnabled` comes from. */
  operatorDefault: boolean | null;
  /** The manifest's enabled_by_default. */
  manifestDefault: boolean;
  config: Record<string, unknown>;
  metrics: Record<string, unknown>;
  pluginEnabled: boolean;
  pluginStatus: "active" | "inactive";
}

/** One row of GET /api/plugins/feature-defaults. */
export interface AdminFeatureDefaultItem {
  pluginId: number;
  pluginKey: string;
  pluginName: string;
  pluginEnabled: boolean;
  pluginStatus: "active" | "inactive";
  featureKey: string;
  featureName: string;
  featureDescription: string | undefined;
  featureIcon: string | undefined;
  manifestDefault: boolean;
  override: boolean | null;
  effectiveDefault: boolean;
  enabledGuildCount: number;
  disabledGuildCount: number;
}

export const pluginAdmin = new PluginAdmin(pluginAuthStore);
