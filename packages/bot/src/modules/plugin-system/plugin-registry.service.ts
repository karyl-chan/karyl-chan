import {
  expireStalePlugins,
  findAllPlugins,
  findPluginById,
  findPluginByKey,
  setPluginApprovedGlobalEventSubs,
  setPluginApprovedRpcScopes,
  setPluginEnabled as setEnabledModel,
  setPluginDispatchHmacKey,
  touchHeartbeat,
  upsertPluginRegistration,
  type PluginRow,
} from "./models/plugin.model.js";
import { config } from "../../config.js";
import { pluginAuthStore, PluginAuthStore } from "./plugin-auth.service.js";
import { evaluateSdkCompat } from "./plugin-sdk-compat.js";
import {
  evaluateEventSubscriptions,
  type EventSubscriptionCheck,
} from "./plugin-event-subscriptions.js";
import { scheduleRegisterProbe } from "./plugin-dispatch-probe.service.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { moduleLogger } from "../../logger.js";
import { dropDispatchPoolForPlugin } from "./plugin-event-bridge.service.js";
import { emitPluginChange } from "./plugin-changes.js";
import {
  invalidatePluginByKey,
  invalidatePluginById,
} from "./plugin-lookup-cache.js";
import { pluginEndpointRegistry } from "./plugin-endpoint-registry.js";
import { deactivatePluginByKey } from "./models/plugin.model.js";
import {
  CommandSyncRateLimitedError,
  pluginCommandRegistry,
} from "./plugin-command-registry.service.js";
import {
  assertPluginTarget,
  HostPolicyError,
} from "../../utils/host-policy.js";
import {
  deleteStaleCapabilities,
  upsertPluginCapability,
} from "./models/plugin-capability.model.js";
import { AdminRoleCapability } from "../admin/models/admin-role-capability.model.js";
import { invalidateCapabilityCache } from "../admin/authorized-user.service.js";
import {
  makePluginCapabilityToken,
  parsePluginCapabilityToken,
} from "../admin/admin-capabilities.js";
import { Op } from "sequelize";
import { withBusyRetry } from "../../db.js";
import { randomBytes } from "crypto";

const log = moduleLogger("plugin-registry");

/**
 * Plugin lifecycle owner. Sits between the HTTP layer (plugin-routes)
 * and the model layer (plugin.model). Holds:
 *   - the heartbeat reaper interval
 *   - cached parsed manifests for fast event-dispatch path
 *   - the wiring to revoke tokens on admin disable / on stale-out
 *
 * Manifest validation is gated here too — we'd rather fail a
 * registration with a clear error than store a malformed manifest
 * that breaks event dispatch later. The protocol rules themselves are
 * the wire contract's (`@karyl-chan/plugin-wire`); this module adds the
 * host-policy check that needs bot state.
 */

// A plugin must heartbeat at least this often, otherwise we mark it
// inactive and stop dispatching events to it. Tuned 2× the plugin's
// own 30s heartbeat cadence so a single missed beat doesn't trigger.
const HEARTBEAT_TIMEOUT_MS = config.plugin.heartbeatTimeoutMs;
const REAPER_INTERVAL_MS = config.plugin.reaperIntervalMs;

// Manifest types are owned by `@karyl-chan/plugin-wire` (the single home
// for the bot↔plugin wire contract). The re-export below preserves every
// existing `import { PluginManifest, ManifestCommand, ... } from
// "./plugin-registry.service.js"` site across the codebase. The bot's
// historical `ManifestCapabilityDecl` name is kept as a local alias for
// the wire's `ManifestCapability`.
export type {
  ManifestCommandOption,
  ManifestCommand,
  ManifestConfigField,
  ManifestGuildFeature,
  ManifestCapability as ManifestCapabilityDecl,
  ManifestPluginCommand,
  ManifestValidation,
  PluginManifest,
} from "@karyl-chan/plugin-wire";

import type {
  ManifestCapability as ManifestCapabilityDecl,
  ManifestValidation,
  PluginManifest,
} from "@karyl-chan/plugin-wire";

// The Protocol Rules half of manifest validation; the Host Policy half
// is this module's own (see `validateManifest` below).
import { validateManifestProtocol } from "@karyl-chan/plugin-wire";

/**
 * Purge `plugin:<pluginKey>:<capKey>` capability tokens from every
 * admin role and invalidate the capability cache so the cut is
 * instant. No-op when `capKeys` is empty.
 */
export async function purgePluginCapabilityGrants(
  pluginKey: string,
  capKeys: string[],
): Promise<void> {
  if (capKeys.length === 0) return;
  const tokens = capKeys.map((k) => makePluginCapabilityToken(pluginKey, k));
  await AdminRoleCapability.destroy({
    where: { capability: { [Op.in]: tokens } },
  });
  invalidateCapabilityCache();
}

/**
 * Drop any `plugin:<pluginKey>:*` grant whose capKey is NOT in
 * `keepKeys`. Unlike `purgePluginCapabilityGrants` (which deletes a
 * known list), this is a full sweep against the role table — it
 * self-heals a grant that a previous reconcile / delete failed to
 * purge (so a retired capability can't silently re-bind on a future
 * re-register). Returns the tokens it removed.
 */
async function sweepOrphanPluginGrants(
  pluginKey: string,
  keepKeys: string[],
): Promise<string[]> {
  const keep = new Set(keepKeys);
  const rows = await AdminRoleCapability.findAll({
    where: { capability: { [Op.like]: `plugin:${pluginKey}:%` } },
    attributes: ["capability"],
  });
  const stale = [
    ...new Set(
      rows
        .map((r) => r.getDataValue("capability") as string)
        .filter((tok) => {
          const parsed = parsePluginCapabilityToken(tok);
          return (
            parsed !== null &&
            parsed.pluginKey === pluginKey &&
            !keep.has(parsed.capKey)
          );
        }),
    ),
  ];
  if (stale.length > 0) {
    await AdminRoleCapability.destroy({
      where: { capability: { [Op.in]: stale } },
    });
    invalidateCapabilityCache();
  }
  return stale;
}

/**
 * Reconcile a plugin's manifest-declared capabilities against what's
 * persisted in `plugin_capabilities`:
 *   - declared ∖ stored → inserted
 *   - declared ∩ stored → description refreshed if changed
 *   - stored ∖ declared → row deleted
 *   - role grants for any `plugin:<pluginKey>:*` not in `declared`
 *     are swept from `admin_role_capabilities` (full sync, not just
 *     the rows removed this run)
 *
 * Returns the removed capKeys (for the audit log).
 */
async function reconcilePluginCapabilities(
  pluginId: number,
  pluginKey: string,
  declared: ManifestCapabilityDecl[],
): Promise<string[]> {
  for (const c of declared) {
    await upsertPluginCapability(pluginId, c.key, c.description);
  }
  const declaredKeys = declared.map((c) => c.key);
  const removed = await deleteStaleCapabilities(pluginId, declaredKeys);
  await sweepOrphanPluginGrants(pluginKey, declaredKeys);
  return removed;
}

/**
 * Validate a plugin manifest: the wire contract's Protocol Rules, then
 * the one check that needs bot state.
 *
 * Protocol (V-02 ~ V-08, V-C1 ~ V-C3, capabilities, config_schema,
 * web_ui) lives in `@karyl-chan/plugin-wire` so the SDK's
 * `buildManifest` enforces exactly the same rules at build time — an
 * author sees a bad manifest at plugin startup, not as a 400 here.
 *
 * The SSRF guard stays: whether `plugin.url` resolves to a target this
 * bot is allowed to reach is Host Policy (DNS + operator allowlist),
 * not something a plugin author can check from their own machine.
 *
 * Ordering note: host policy used to run mid-protocol, right after the
 * URL parse. It now runs after the full protocol pass, so a manifest
 * that is BOTH malformed and pointed at a blocked host reports the
 * protocol error first. Deliberate — a malformed manifest is wrong
 * wherever it points, and the author can fix it without an operator.
 */
export async function validateManifest(
  input: unknown,
): Promise<ManifestValidation> {
  const protocol = validateManifestProtocol(input);
  if (!protocol.ok) return protocol;

  // V-03 (bot half)：plugin.url 已確認是可解析的 http(s) URL，這裡再過
  // SSRF guard。
  const parsedUrl = new URL(protocol.manifest.plugin.url);
  const pluginPort = parsedUrl.port
    ? Number(parsedUrl.port)
    : parsedUrl.protocol === "https:"
      ? 443
      : 80;
  try {
    await assertPluginTarget(parsedUrl.hostname, pluginPort);
  } catch (err) {
    const msg =
      err instanceof HostPolicyError ? err.message : "Plugin 目標不被允許";
    return { ok: false, error: `manifest.plugin.url: ${msg}` };
  }

  return protocol;
}

export interface RegisterResult {
  plugin: PluginRow;
  manifest: PluginManifest;
  /** Cleartext token; never stored, only returned to the plugin once. */
  token: string;
  /**
   * Cleartext dispatch HMAC key for this plugin. Returned once at registration;
   * never returned again. The plugin SDK (A-2) uses this key to verify inbound
   * dispatch signatures from the bot.
   */
  dispatchHmacKey: string;
  /**
   * Verdict on the manifest's event subscriptions (#29 decisions 4/6/7).
   * Warn-only this release, so a non-`ok` status still got here — the
   * route echoes it back so the plugin author sees the doomed
   * subscription in their own startup log, not only in the admin UI.
   */
  eventSubscriptions: EventSubscriptionCheck;
}

/**
 * Background command-sync bookkeeping (PM-7.1). In-memory by design:
 * a bot restart re-runs reconcileAll() from the ready handler, which
 * makes any persisted state stale immediately. Multi-replica setups
 * see per-replica state only — acceptable because only the replica
 * that accepted the register performs the sync.
 */
export type CommandSyncStatus = "pending" | "ok" | "failed" | "rate_limited";

export interface CommandSyncState {
  status: CommandSyncStatus;
  /** Epoch ms when the current/most recent sync run started. */
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export class PluginRegistry {
  private reaperTimer: NodeJS.Timeout | null = null;
  private auth: PluginAuthStore;
  /** pluginKey → latest sync state, for admin UI / diagnostics. */
  private commandSyncStates = new Map<string, CommandSyncState>();
  /**
   * pluginKey → in-flight marker. Presence means a sync loop is
   * running for that plugin; `pending` holds the latest manifest that
   * arrived while it ran (older intermediates are dropped —
   * latest-wins). This is the single-flight guard that keeps a
   * re-register storm from racing concurrent syncs (whose stale-row
   * cleanup would delete each other's writes) and from amplifying
   * into Discord rate-limit pressure.
   */
  private commandSyncRuns = new Map<
    string,
    { pending: { plugin: PluginRow; manifest: PluginManifest } | null }
  >();

  constructor(auth: PluginAuthStore) {
    this.auth = auth;
  }

  getCommandSyncState(pluginKey: string): CommandSyncState | null {
    return this.commandSyncStates.get(pluginKey) ?? null;
  }

  /**
   * Run pluginCommandRegistry.sync in the background, single-flight
   * per pluginKey with latest-wins coalescing. Never throws; outcomes
   * land in `commandSyncStates` + botEventLog. Callers (register) get
   * their HTTP response without waiting on any Discord REST call.
   */
  private scheduleCommandSync(plugin: PluginRow, manifest: PluginManifest): void {
    const key = plugin.pluginKey;
    const inFlight = this.commandSyncRuns.get(key);
    if (inFlight) {
      inFlight.pending = { plugin, manifest };
      this.commandSyncStates.set(key, {
        status: "pending",
        startedAt: Date.now(),
      });
      return;
    }
    const marker: {
      pending: { plugin: PluginRow; manifest: PluginManifest } | null;
    } = { pending: null };
    this.commandSyncRuns.set(key, marker);
    void (async () => {
      let task: { plugin: PluginRow; manifest: PluginManifest } | null = {
        plugin,
        manifest,
      };
      while (task) {
        const startedAt = Date.now();
        this.commandSyncStates.set(key, { status: "pending", startedAt });
        try {
          await pluginCommandRegistry.sync(task.plugin, task.manifest);
          this.commandSyncStates.set(key, {
            status: "ok",
            startedAt,
            finishedAt: Date.now(),
          });
        } catch (err) {
          if (err instanceof CommandSyncRateLimitedError) {
            // Clamp Discord's retry hint: ≥5s so we never busy-loop,
            // ≤15min so a pathological reset time can't park the
            // plugin for hours without a fresh attempt.
            const retryMs = Math.min(
              Math.max(err.retryAfterMs, 5_000),
              900_000,
            );
            this.commandSyncStates.set(key, {
              status: "rate_limited",
              startedAt,
              finishedAt: Date.now(),
              error: `Discord rate limit; retrying in ${Math.ceil(retryMs / 1000)}s`,
            });
            botEventLog.record(
              "warn",
              "bot",
              `plugin-commands: sync for ${key} rate limited by Discord; retrying in ${Math.ceil(retryMs / 1000)}s`,
              { pluginId: task.plugin.id },
            );
            // Re-queue THIS manifest after the window — unless a newer
            // one already arrived (it supersedes the failed attempt).
            if (!marker.pending) {
              const retryTask = task;
              setTimeout(() => {
                this.scheduleCommandSync(retryTask.plugin, retryTask.manifest);
              }, retryMs).unref();
            }
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            this.commandSyncStates.set(key, {
              status: "failed",
              startedAt,
              finishedAt: Date.now(),
              error: msg,
            });
            log.error(
              { err },
              `plugin-commands: background sync failed for ${key}`,
            );
            botEventLog.record(
              "warn",
              "bot",
              `plugin-commands: background sync failed for ${key}: ${msg}`,
              { pluginId: task.plugin.id },
            );
          }
        }
        task = marker.pending;
        marker.pending = null;
      }
      this.commandSyncRuns.delete(key);
    })();
  }

  /**
   * Idempotent registration. Re-registers (e.g. plugin restart) just
   * issue a fresh token and update the manifest snapshot — admin's
   * `enabled` flag stays where they last set it.
   *
   * RPC scopes: the manifest's declared `rpc_methods_used` are the
   * *requested* scopes. The token is signed with only the *approved*
   * subset (`plugins.approvedRpcScopes`), so the per-RPC-call scope
   * check (`requireScope`) rejects any method that isn't both declared
   * and approved. With `config.plugin.autoApproveScopes` on (self-host /
   * dev default) every requested scope is approved on the spot; with it
   * off, newly-requested scopes stay pending until an admin approves
   * them and only the previously-approved subset is granted meanwhile.
   */
  async register(rawManifest: unknown): Promise<RegisterResult> {
    const v = await validateManifest(rawManifest);
    if (!v.ok) {
      throw new ManifestError(v.error);
    }
    const manifest = v.manifest;

    // ── Unknown event subscriptions (#29 decisions 4/6/7) ──────────
    // Host policy, not a Protocol Rule: whether a name is one this
    // BUILD knows is unanswerable from the author's machine, so the
    // wire classifies and this module decides. The gate sits before
    // anything is persisted so phase 2 leaves no half-registered row.
    // `status` can only be "reject" once
    // `REJECT_UNKNOWN_EVENT_SUBSCRIPTIONS` (plugin-event-subscriptions.ts)
    // is flipped, so in this warn-only release the throw is unreachable.
    const eventSubscriptions = evaluateEventSubscriptions(manifest);
    if (eventSubscriptions.status === "reject") {
      throw new ManifestError(
        eventSubscriptions.unknown
          .filter((u) => u.verdict === "reject")
          .map((u) => u.message)
          .join(" "),
      );
    }

    // ── Requested vs approved RPC scopes ───────────────────────────
    // Requested = what this manifest declares. Approved = what the
    // token will actually carry. Under auto-approve they're equal;
    // otherwise approval is sticky across re-registers: keep the
    // previously-approved scopes that are still requested (drop ones the
    // manifest no longer asks for), and leave any newly-requested scope
    // pending for an admin to approve.
    const requestedScopes = manifest.rpc_methods_used ?? [];
    const existing = await findPluginByKey(manifest.plugin.id);
    // Command-name collision check runs BEFORE anything is persisted
    // (this is what its doc comment always promised): a manifest that
    // shadows a reserved command or another plugin's command gets an
    // immediate 400 and leaves no row/token behind. Previously this
    // ran after the upsert with the error swallowed, so a colliding
    // plugin registered "successfully" with its commands silently
    // skipped. ManifestCommandError propagates to the route → 400.
    await pluginCommandRegistry.assertNoCollisions(
      manifest.plugin.id,
      existing?.id ?? -1,
      manifest,
    );
    const prevApproved = existing?.approvedRpcScopes ?? [];
    const approvedScopes = config.plugin.autoApproveScopes
      ? requestedScopes
      : requestedScopes.filter((s) => prevApproved.includes(s));
    const pendingScopes = requestedScopes.filter(
      (s) => !approvedScopes.includes(s),
    );
    // ── Requested vs approved GLOBAL event subscriptions (PM-8) ────
    // Same approval discipline as RPC scopes: global subscriptions are
    // a firehose grant (DM / guild-less / cross-guild events), so they
    // need the operator's nod when auto-approve is off. Feature-scoped
    // subscriptions need none — they're gated per guild by the feature
    // toggle at dispatch time.
    const requestedGlobalSubs = (
      manifest.events_subscribed_global ?? []
    ).filter((e): e is string => typeof e === "string" && e.length > 0);
    const prevApprovedGlobal = existing?.approvedGlobalEventSubs ?? [];
    const approvedGlobalSubs = config.plugin.autoApproveScopes
      ? requestedGlobalSubs
      : requestedGlobalSubs.filter((e) => prevApprovedGlobal.includes(e));
    const pendingGlobalSubs = requestedGlobalSubs.filter(
      (e) => !approvedGlobalSubs.includes(e),
    );

    // ── Token issue ────────────────────────────────────────────────
    // Mint token first, persist hash. Cleartext goes back to the
    // plugin in the response and is never stored.
    // Token is signed with the *approved* scopes only.
    // Stable id for token cache: we can't use the not-yet-known
    // plugins.id row id, so we use pluginKey as identity here, then
    // reissue with the real id once we have it. The auth store keys
    // by tokenHash so the second issue() supersedes the first.
    const placeholderToken = this.auth.issue({
      pluginId: -1,
      pluginKey: manifest.plugin.id,
      scopes: approvedScopes,
    });
    const persisted = await upsertPluginRegistration({
      pluginKey: manifest.plugin.id,
      name: manifest.plugin.name,
      version: manifest.plugin.version,
      url: manifest.plugin.url,
      manifestJson: JSON.stringify(manifest),
      tokenHash: placeholderToken.tokenHash,
      approvedRpcScopes: approvedScopes,
      approvedGlobalEventSubs: approvedGlobalSubs,
    });
    // Re-issue with the real plugins.id so the auth record carries the
    // db-backed id (used by RPC handlers to filter scopes per plugin).
    this.auth.revokeToken(placeholderToken.token);
    const real = this.auth.issue({
      pluginId: persisted.id,
      pluginKey: manifest.plugin.id,
      scopes: approvedScopes,
    });
    // Persist the real hash in place of the placeholder.
    persisted.tokenHash = real.tokenHash;
    await upsertPluginRegistration({
      pluginKey: manifest.plugin.id,
      name: manifest.plugin.name,
      version: manifest.plugin.version,
      url: manifest.plugin.url,
      manifestJson: JSON.stringify(manifest),
      tokenHash: real.tokenHash,
      approvedRpcScopes: approvedScopes,
      approvedGlobalEventSubs: approvedGlobalSubs,
    });
    if (pendingScopes.length > 0) {
      botEventLog.record(
        "warn",
        "bot",
        `Plugin '${manifest.plugin.id}' requests ${pendingScopes.length} unapproved RPC scope(s): ${pendingScopes.join(", ")} — pending admin approval`,
        { pluginId: persisted.id, pendingScopes },
      );
    }
    if (pendingGlobalSubs.length > 0) {
      botEventLog.record(
        "warn",
        "bot",
        `Plugin '${manifest.plugin.id}' requests ${pendingGlobalSubs.length} unapproved global event subscription(s): ${pendingGlobalSubs.join(", ")} — no events delivered for these until an admin approves (Security tab)`,
        { pluginId: persisted.id, pendingGlobalSubs },
      );
    }

    botEventLog.record(
      "info",
      "bot",
      `Plugin registered: ${manifest.plugin.id} v${manifest.plugin.version}`,
      {
        pluginId: persisted.id,
        pluginKey: manifest.plugin.id,
        version: manifest.plugin.version,
        sdkVersion: manifest.sdk_version ?? "<0.6",
      },
    );
    // Version-mismatch detection at register time (PM-7.9.3): an SDK
    // below the wire-format floor registers and heartbeats fine but
    // will reject every signed dispatch — flag it NOW instead of when
    // the first user command 401s.
    const sdkCompat = evaluateSdkCompat(manifest.sdk_version ?? null);
    if (sdkCompat.status !== "ok") {
      botEventLog.record(
        "warn",
        "bot",
        sdkCompat.status === "below_minimum"
          ? `Plugin '${manifest.plugin.id}' registered with SDK ${sdkCompat.sdkVersion}, below the compatible floor ${sdkCompat.minCompatible} — its dispatch HMAC verification predates this bot's signature scheme, so every command/event dispatch will be rejected (401) until the plugin is rebuilt against @karyl-chan/plugin-sdk >=${sdkCompat.minCompatible}`
          : `Plugin '${manifest.plugin.id}' registered without manifest.sdk_version (SDK <0.9) — assume it predates the dispatch HMAC floor ${sdkCompat.minCompatible}; dispatches will likely be rejected (401) until it is rebuilt`,
        { pluginId: persisted.id, pluginKey: manifest.plugin.id },
      );
    }
    // Unknown event subscriptions (#29 decisions 4/6/7), warn-only for
    // this release. The response tells the plugin author; this line
    // tells the operator, who is the one who has to decide whether the
    // reject phase can be turned on.
    if (eventSubscriptions.unknown.length > 0) {
      botEventLog.record(
        "warn",
        "bot",
        `Plugin '${manifest.plugin.id}' subscribes to ${eventSubscriptions.unknown.length} unknown event(s) — registered anyway (warn-only phase). ${eventSubscriptions.unknown.map((u) => u.message).join(" ")}`,
        {
          pluginId: persisted.id,
          pluginKey: manifest.plugin.id,
          unknownEvents: eventSubscriptions.unknown.map((u) => u.event),
          eventCeiling: eventSubscriptions.ceiling,
        },
      );
    }
    // Reconcile plugin-declared RBAC capabilities. A re-register that
    // drops a capability auto-removes it from every role (mirrors how
    // dropped RPC scopes are auto-removed above). Failures here don't
    // roll back the registration — a plugin with stale capability rows
    // is still useful.
    try {
      // Two plugins registering at once race on plugin_capabilities;
      // retry so a transient lock can't silently drop a capability row.
      const removedCaps = await withBusyRetry(() =>
        reconcilePluginCapabilities(
          persisted.id,
          manifest.plugin.id,
          manifest.capabilities ?? [],
        ),
      );
      if (removedCaps.length > 0) {
        botEventLog.record(
          "info",
          "bot",
          `Plugin '${manifest.plugin.id}' dropped capabilities: ${removedCaps.join(", ")}`,
          { pluginId: persisted.id, removed: removedCaps },
        );
      }
    } catch (err) {
      log.error({ err }, "reconcilePluginCapabilities after register failed");
      botEventLog.record(
        "warn",
        "bot",
        `reconcilePluginCapabilities failed for ${manifest.plugin.id}`,
      );
    }
    // Record this replica's advertised address in the multi-endpoint
    // registry (PR-3.1). For the single-replica default this is just
    // the same url the DB row already carries; with replicas>1 each
    // replica's distinct url accumulates here under one pluginKey, each
    // with its own TTL, so a stopped replica ages out independently.
    pluginEndpointRegistry.touch(manifest.plugin.id, manifest.plugin.url);
    // Invalidate the proxy/lookup cache so the fresh row is read on
    // the next request (e.g. URL change on re-register).
    invalidatePluginByKey(manifest.plugin.id);
    // Same reasoning: drop any cached PoolEntry so a previously-
    // tripped breaker doesn't carry over into the freshly-registered
    // plugin. Even when the URL is unchanged (operator restarts a bad
    // plugin and re-registers), the breaker should start fresh.
    dropDispatchPoolForPlugin(manifest.plugin.id);
    // The freshly-registered plugin's manifest has been persisted to
    // `persisted.manifestJson`; subscribers (event index, feature-reach
    // cache) re-derive their state from the post-mutation row.
    emitPluginChange({ pluginId: persisted.id, row: persisted });
    // ── Dispatch HMAC key ──────────────────────────────────────────────
    // Generate once and persist. On re-registration the existing key is
    // reused so plugins that have cached it don't break. The cleartext
    // is returned in the response exactly once — after that only the DB
    // copy exists (and it's bot-internal, never surfaced to admin reads).
    let dispatchHmacKeyCleartext: string;
    if (persisted.dispatchHmacKey) {
      // Re-registration: reuse the existing key.
      dispatchHmacKeyCleartext = persisted.dispatchHmacKey;
    } else {
      // First registration (or migration with NULL): generate a new key.
      dispatchHmacKeyCleartext = randomBytes(32).toString("hex");
      await setPluginDispatchHmacKey(persisted.id, dispatchHmacKeyCleartext);
      persisted.dispatchHmacKey = dispatchHmacKeyCleartext;
    }

    // Sync slash commands in the BACKGROUND (PM-7.1). The handshake's
    // job ends at credentials; a wedged or rate-limited Discord REST
    // call must not hold the register response hostage (2026-06-11
    // incident: a plugin hung forever on this await and answered every
    // dispatch 503). Single-flight + latest-wins lives in
    // scheduleCommandSync; failures land in botEventLog + sync state,
    // never roll back the registration.
    this.scheduleCommandSync(persisted, manifest);

    // Probe the dispatch HMAC path a few seconds after the plugin has
    // its credentials (PM-7.9.4) — a scheme mismatch shows up in the
    // admin UI immediately instead of on the first user command.
    scheduleRegisterProbe(manifest.plugin.id);

    return {
      plugin: persisted,
      manifest,
      token: real.token,
      dispatchHmacKey: dispatchHmacKeyCleartext,
      eventSubscriptions,
    };
  }

  /**
   * Heartbeat from a plugin: stamp lastHeartbeatAt, ensure status is
   * active, slide token expiry. Called only from the route handler
   * which has already verified the bearer token.
   *
   * If the row had been marked inactive by the reaper, the heartbeat
   * "revives" it — the event-dispatch index and proxy lookup cache
   * still pin the inactive state, so we have to invalidate them here
   * or the plugin will keep getting 404s and dropped events for up to
   * the cache TTL after recovery.
   */
  async heartbeat(
    pluginId: number,
    token: string,
    advertisedUrl?: string,
  ): Promise<void> {
    const touched = await touchHeartbeat(pluginId);
    this.auth.refresh(token);
    // Slide the endpoint TTL forward (PR-3.1 multi-endpoint). The
    // replica heartbeats its OWN advertised url so sibling replicas
    // each keep their own entry alive; without a url in the beat (older
    // SDK) we fall back to the DB row's url, which is correct for the
    // single-replica default.
    if (touched?.row) {
      const url =
        typeof advertisedUrl === "string" && advertisedUrl.length > 0
          ? advertisedUrl
          : touched.row.url;
      pluginEndpointRegistry.touch(touched.row.pluginKey, url);
    }
    if (touched?.revived) {
      emitPluginChange({ pluginId, row: touched.row });
      invalidatePluginByKey(touched.row.pluginKey);
      dropDispatchPoolForPlugin(touched.row.pluginKey);
      botEventLog.record(
        "info",
        "bot",
        `Plugin ${touched.row.pluginKey} revived via heartbeat (was inactive)`,
        { pluginId, pluginKey: touched.row.pluginKey },
      );
    }
  }

  /**
   * Graceful deregister (PR-3.1). Called when a plugin announces its own
   * shutdown (SDK SIGTERM/SIGINT → POST /api/plugins/deregister) so the
   * bot drops it *immediately* instead of waiting up to the heartbeat
   * timeout for the reaper. The `advertisedUrl` (when supplied) removes
   * just that one replica's endpoint; the DB row is only flipped to
   * `inactive` once NO live endpoints remain for the pluginKey — so one
   * replica of a multi-replica plugin shutting down doesn't take the
   * whole plugin offline.
   *
   * Token is verified by the route handler before this runs; we revoke
   * it here so a stale bearer can't keep beating after deregister.
   */
  async deregister(
    pluginId: number,
    token: string,
    advertisedUrl?: string,
  ): Promise<void> {
    const row = await findPluginById(pluginId);
    if (!row) return;
    // Drop this replica's endpoint (or all of them if no url was given).
    if (typeof advertisedUrl === "string" && advertisedUrl.length > 0) {
      pluginEndpointRegistry.remove(row.pluginKey, advertisedUrl);
    } else {
      pluginEndpointRegistry.removeAll(row.pluginKey);
    }
    // If other replicas are still alive, keep the plugin active — only
    // this bearer is retired.
    const remaining = pluginEndpointRegistry.endpoints(row.pluginKey);
    if (remaining.length > 0) {
      this.auth.revokeToken(token);
      return;
    }
    // No live endpoints left → take the plugin offline now (mirrors the
    // reaper's inactive transition, just early).
    pluginEndpointRegistry.removeAll(row.pluginKey);
    this.auth.revokeByPluginId(pluginId);
    const deactivated = await deactivatePluginByKey(row.pluginKey);
    if (deactivated) {
      emitPluginChange({ pluginId, row: null });
      invalidatePluginById(pluginId);
      dropDispatchPoolForPlugin(row.pluginKey);
      botEventLog.record(
        "info",
        "bot",
        `Plugin deregistered (graceful shutdown): ${row.pluginKey}`,
        { pluginId, pluginKey: row.pluginKey },
      );
    }
  }

  /**
   * Admin toggle. Disabling a plugin revokes its token immediately —
   * any in-flight RPC fails with 401. Re-enabling requires the plugin
   * to re-register (no automatic resurrection).
   */
  async setEnabled(
    pluginId: number,
    enabled: boolean,
  ): Promise<PluginRow | null> {
    const row = await setEnabledModel(pluginId, enabled);
    if (row && !enabled) {
      this.auth.revokeByPluginId(pluginId);
      // Strip Discord-side commands for the disabled plugin so users
      // don't see ghost commands they can't invoke.
      await pluginCommandRegistry.unregisterAll(pluginId).catch(() => {
        /* logged inside the registry */
      });
    } else if (row && enabled) {
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
    if (row) {
      emitPluginChange({ pluginId, row });
      // Invalidate proxy/lookup cache so the next request sees the
      // new enabled / status.
      invalidatePluginByKey(row.pluginKey);
    }
    return row;
  }

  /**
   * Admin view of a plugin's RPC scope state: what the current manifest
   * requests, what's approved, and the still-pending delta. Returns null
   * if the plugin doesn't exist.
   */
  async getScopeState(pluginId: number): Promise<{
    requested: string[];
    approved: string[];
    pending: string[];
  } | null> {
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

  /**
   * Set a plugin's approved RPC scope set (admin approve / deny). The
   * approved set is intersected with what the manifest actually requests
   * — an admin can't grant a scope the plugin never declared. Persists
   * the result and updates the plugin's live token in place so the change
   * takes effect immediately, without waiting for a re-register. Returns
   * the new scope state, or null if the plugin doesn't exist.
   */
  async setApprovedScopes(
    pluginId: number,
    scopes: string[],
  ): Promise<{
    requested: string[];
    approved: string[];
    pending: string[];
  } | null> {
    const state = await this.getScopeState(pluginId);
    if (!state) return null;
    // Clamp to the requested set and de-dup; an admin can only approve
    // what the manifest declares.
    const approved = [...new Set(scopes)].filter((s) =>
      state.requested.includes(s),
    );
    const row = await setPluginApprovedRpcScopes(pluginId, approved);
    if (!row) return null;
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
    return { requested: state.requested, approved, pending };
  }

  /**
   * Approve every scope the plugin currently requests. Convenience over
   * `setApprovedScopes` for the common "approve all" admin action.
   */
  async approveAllScopes(pluginId: number): Promise<{
    requested: string[];
    approved: string[];
    pending: string[];
  } | null> {
    const state = await this.getScopeState(pluginId);
    if (!state) return null;
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
  ): Promise<{
    requested: string[];
    approved: string[];
    pending: string[];
  } | null> {
    const plugin = await findPluginById(pluginId);
    if (!plugin) return null;
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
    if (!row) return null;
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
    return { requested, approved, pending };
  }

  async list(): Promise<PluginRow[]> {
    return findAllPlugins();
  }

  async findByKey(pluginKey: string): Promise<PluginRow | null> {
    return findPluginByKey(pluginKey);
  }

  async findById(pluginId: number): Promise<PluginRow | null> {
    return findPluginById(pluginId);
  }

  /**
   * Start the heartbeat reaper. Call from main.ts after migrations
   * have run. Idempotent: calling twice is a no-op.
   */
  startReaper(now: () => number = Date.now): void {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => {
      void this.runReaperOnce(now);
    }, REAPER_INTERVAL_MS);
    this.reaperTimer.unref();
  }

  /**
   * One heartbeat-reaper sweep: mark stale plugins inactive and tear down
   * all of their per-plugin state. Exposed (rather than a closure) so a
   * test can drive a single deterministic tick. Normally invoked by
   * {@link startReaper}'s interval.
   */
  async runReaperOnce(now: () => number = Date.now): Promise<void> {
    try {
      const cutoff = new Date(now() - HEARTBEAT_TIMEOUT_MS);
      const expired = await expireStalePlugins(cutoff);
      // Tear down every trace of each dead plugin (no cross-item ordering
      // dependency, so one pass): revoke its token, drop it from the event
      // index (so dispatch stops fanning out to it) + the proxy/lookup
      // cache, AND tear down its dispatch pool — the undici Pool keeps
      // keep-alive TCP sockets open to the dead plugin, so without this the
      // pool entry leaks on every crash-without-deregister (register /
      // heartbeat / deregister already drop it; the reaper was the one gap).
      for (const { id, pluginKey } of expired) {
        this.auth.revokeByPluginId(id);
        botEventLog.record(
          "warn",
          "bot",
          `Plugin marked inactive (heartbeat timeout): id=${id}`,
          { pluginId: id, cutoff: cutoff.toISOString() },
        );
        emitPluginChange({ pluginId: id, row: null });
        invalidatePluginById(id);
        dropDispatchPoolForPlugin(pluginKey);
      }
      // Sweep the multi-endpoint registry on the same cadence so a
      // stale replica address (one that stopped heartbeating) ages
      // out of the discovery set even when the DB row stays active
      // because a sibling replica is still alive (PR-3.1).
      const reapedKeys = pluginEndpointRegistry.reap();
      for (const key of reapedKeys) {
        invalidatePluginByKey(key);
      }
    } catch (err) {
      log.error({ err }, "plugin reaper failed");
      botEventLog.record("error", "error", "Plugin reaper failed");
    }
  }

  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export const pluginRegistry = new PluginRegistry(pluginAuthStore);
