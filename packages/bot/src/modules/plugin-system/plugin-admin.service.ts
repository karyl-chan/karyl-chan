import {
  deletePlugin,
  findPluginById,
  setPluginApprovedGlobalEventSubs,
  setPluginApprovedRpcScopes,
  setPluginConfigSchemaVersion,
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
import {
  configIntake,
  type FieldValidationError,
} from "./config-validator.js";
import { encryptSecret } from "../../utils/crypto.js";
import {
  upsertFeatureRow,
  type PluginGuildFeatureRow,
} from "../feature-toggle/models/plugin-guild-feature.model.js";
import { featureReachResolver } from "../feature-toggle/feature-reach-resolver.js";
import { upsertConfigKey } from "./models/plugin-config.model.js";
import { dispatchLifecycleToPlugin } from "./plugin-lifecycle-dispatch.service.js";

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
 * must stay byte-identical).
 *
 * The delete teardown's refuse-an-active-plugin 409 guard still lives
 * route-side (see #49's note on {@link PluginAdmin.teardown}).
 */
export type AdminRefusal =
  | { kind: "not_found" }
  | { kind: "feature_not_found"; featureKey: string }
  | {
      kind: "validation_failed";
      fieldErrors: FieldValidationError[];
    };

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
  constructor(
    private readonly auth: PluginAuthStore,
    /**
     * For `getScopeState` and the shared row/manifest queries the config
     * writes use. The admin *reads* themselves move here with increment
     * A4; until then, reading them from their current home beats keeping
     * a second copy of the manifest parse.
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
    if (!plugin) return { ok: false, refusal: { kind: "not_found" } };

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
    const plugin = (await this.registry.list()).find((p) => p.id === pluginId);
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
      const pluginRow = await this.registry.findById(pluginId);
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
    const plugin = (await this.registry.list()).find((p) => p.id === pluginId);
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
}

function safeParseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export const pluginAdmin = new PluginAdmin(pluginAuthStore, pluginRegistry);
