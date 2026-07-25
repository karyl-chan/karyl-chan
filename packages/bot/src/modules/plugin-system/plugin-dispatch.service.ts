/**
 * Plugin Dispatch — the one deep module for safely delivering a payload
 * to a plugin (#28, ADR 0001). Owns the shared trunk every Dispatch
 * Kind used to re-implement privately:
 *
 *   gate:    liveness → manifest → Feature Reach → dispatch key
 *   deliver: endpoint resolve → SSRF preflight → payload build →
 *            sign → transport → dispatch health record
 *
 * The Discord side stays OUT: defer/ack modes, payload assembly,
 * response translation and error surfaces live in the per-kind thin
 * services. This module never imports discord.js; it reports a
 * discriminated outcome (`ok` / `skipped` / `failed`) and the thin
 * service decides what the user and the bot event log see.
 *
 * Dispatch Transport is an injected adapter, not unified: the event
 * kind rides the `PluginDispatchPool` (keep-alive, breaker, shedding)
 * or the out-of-process event bus; the four interaction/lifecycle
 * kinds keep plain `fetch`. SSRF preflight and signing are HTTP-only
 * steps — the bus branch legitimately skips them.
 *
 * Reach is a per-kind three-state policy. Command/autocomplete is
 * `none` on purpose: feature-keyed commands are gated at registration
 * time (plugin-command-registry syncs a command into a guild iff the
 * feature resolves on via the Precedence Tiers), so a disabled
 * feature's command is not visible to invoke.
 *
 * Tests inject fakes through `createPluginDispatcher(deps)`; prod code
 * uses the `pluginDispatcher` singleton whose pool is also the target
 * of the snapshot/stop/drop management functions below.
 */

import { config } from "../../config.js";
import type { PluginRow } from "./models/plugin.model.js";
import type { PluginManifest } from "./plugin-registry.service.js";
import type { EventScope } from "./plugin-event-index.js";
import type { PluginEventBus } from "../../adapters/plugin-event-bus.js";
import { getPluginEventBus } from "../../adapters/registry.js";
import { featureReachResolver } from "../feature-toggle/feature-reach-resolver.js";
import { buildOutboundSignatureHeaders } from "../../utils/hmac.js";
import {
  TRACEPARENT_HEADER,
  newTraceContext,
} from "../../utils/trace-context.js";
import {
  pluginEventDispatchDuration,
  pluginEventDispatchTotal,
} from "../web-core/metrics.js";
import {
  PluginDispatchPool,
  DEFAULT_DISPATCH_POOL_OPTIONS,
  type DispatchOutcome as PoolOutcome,
} from "./plugin-dispatch-pool.js";
import {
  classifyDispatchHttpFailure,
  recordDispatchAttempt,
  recordDispatchFetchFailure,
  recordDispatchHttpFailure,
  recordDispatchOk,
  recordDispatchUnreachable,
  type DispatchAttempt,
  type DispatchFailureClass,
  type DispatchSource,
} from "./plugin-dispatch-health.service.js";
import {
  buildSignedDispatchHeaders,
  parsePluginManifest,
  preflightPluginTarget,
  resolvePluginEndpoint,
} from "./plugin-dispatch-util.js";

export type DispatchKind =
  | "command"
  | "autocomplete"
  | "component"
  | "modal"
  | "lifecycle"
  | "event";

/**
 * Per-kind shape: what payload the endpoint template expects, which
 * reach policy applies, which transport carries it. This table IS the
 * "kind determines the payload shape, the endpoint, and which reach
 * policy applies" rule from the glossary.
 */
interface KindSpec {
  source: DispatchSource;
  /** Whether the gate refuses on an unparseable manifest. The event
   *  kind resolves manifest needs per-transport instead (the bus needs
   *  none; the HTTP path skips silently — pre-existing semantics). */
  requireManifest: boolean;
  reach: "none" | "any-feature" | "per-scope";
  /** Whether the gate refuses on a missing dispatch key. The event
   *  kind defers this to deliver so the bus transport (which never
   *  signs) can run without one. */
  requireKey: boolean;
  /** Endpoint template; `null` = the plugin opted out (lifecycle only)
   *  and the deliver is skipped without a health record. */
  endpointTemplate: (manifest: PluginManifest) => string | null;
  /** Only autocomplete consumes the response body; the command path
   *  deliberately does not (plugins reply via interactions.respond). */
  readBody: boolean;
  transport: "direct" | "pooled";
  /** Stamp a W3C traceparent on the outbound request (event only). */
  traceparent: boolean;
  timeoutMs: number;
}

const KIND_SPECS: Record<DispatchKind, KindSpec> = {
  command: {
    source: "command",
    requireManifest: true,
    reach: "none",
    requireKey: true,
    endpointTemplate: (m) =>
      m.endpoints?.plugin_command ?? "/commands/{command_name}",
    readBody: false,
    transport: "direct",
    traceparent: false,
    timeoutMs: config.plugin.commandDispatchTimeoutMs,
  },
  autocomplete: {
    source: "autocomplete",
    requireManifest: true,
    reach: "none",
    requireKey: true,
    // No manifest override — autocomplete has always used the fixed path.
    endpointTemplate: () => "/commands/{command_name}/autocomplete",
    readBody: true,
    transport: "direct",
    traceparent: false,
    timeoutMs: config.plugin.autocompleteTimeoutMs,
  },
  component: {
    source: "component",
    requireManifest: true,
    reach: "any-feature",
    requireKey: true,
    endpointTemplate: (m) => m.endpoints?.plugin_component ?? "/components",
    readBody: false,
    transport: "direct",
    traceparent: false,
    timeoutMs: config.plugin.commandDispatchTimeoutMs,
  },
  modal: {
    source: "modal",
    requireManifest: true,
    reach: "any-feature",
    requireKey: true,
    endpointTemplate: (m) =>
      m.endpoints?.plugin_modal ?? "/modals/{modal_id}",
    readBody: false,
    transport: "direct",
    traceparent: false,
    timeoutMs: config.plugin.commandDispatchTimeoutMs,
  },
  lifecycle: {
    source: "lifecycle",
    requireManifest: true,
    reach: "none",
    requireKey: true,
    // Absent endpoint = plugin opted out (no onEnable/onDisable hooks).
    endpointTemplate: (m) => m.endpoints?.plugin_lifecycle ?? null,
    readBody: false,
    transport: "direct",
    traceparent: false,
    timeoutMs: config.plugin.dispatchTimeoutMs,
  },
  event: {
    source: "event",
    requireManifest: false,
    reach: "per-scope",
    requireKey: false,
    endpointTemplate: (m) => m.endpoints?.events ?? "/events",
    readBody: false,
    transport: "pooled",
    traceparent: true,
    timeoutMs: config.plugin.dispatchTimeoutMs,
  },
};

export interface PluginGateRequest {
  kind: DispatchKind;
  plugin: PluginRow;
  /** Guild the trigger happened in — feeds the reach policy. */
  guildId?: string | null;
  /** Event kind only: the subscription scopes routed to this plugin. */
  scopes?: readonly EventScope[];
}

export type PluginDispatchGate =
  | {
      ok: true;
      /** Parsed manifest; non-null for every kind whose spec requires
       *  it (all but event). */
      manifest: PluginManifest | null;
    }
  | {
      ok: false;
      reason:
        | "plugin_offline"
        | "manifest_invalid"
        | "reach_denied"
        | "no_dispatch_key";
    };

export interface PluginDeliverRequest {
  kind: DispatchKind;
  plugin: PluginRow;
  /** Health/log label: command name, custom_id, or event type. */
  label: string;
  /** `{variable}` substitutions for the endpoint template. */
  endpointVars?: Record<string, string>;
  /**
   * The kind adapter supplies the payload shape:
   *  - `body`: pre-serialized JSON, built lazily AFTER the preflight
   *    passes (interaction kinds resolve capabilities in here);
   *  - `data`: event/lifecycle envelope — the HTTP body becomes
   *    `{type: label, data}` and the bus transport receives `data` raw.
   */
  payload:
    | { body: () => string | Promise<string> }
    | { data: unknown };
}

export type PluginDispatchDelivery =
  /** `httpStatus` absent on the bus transport; `body` only when the
   *  kind reads the response (autocomplete). */
  | { status: "ok"; httpStatus?: number; body?: unknown }
  | {
      status: "skipped";
      reason: "manifest_invalid" | "no_dispatch_key" | "no_endpoint";
    }
  | {
      status: "failed";
      /** Pooled failures keep the pool's reason vocabulary verbatim so
       *  the event bridge's per-reason log dedup keys are unchanged. */
      reason:
        | "unresolvable_endpoint"
        | "preflight_denied"
        | "http_error"
        | "network"
        | "connect_refused"
        | "shed"
        | "breaker_open";
      httpStatus?: number;
      /** Preflight reason / response body text / error message. */
      detail: string;
      /** Set for direct-transport http_error — lets the command path
       *  name the awaiting-register state without re-reading the body. */
      failureClass?: DispatchFailureClass;
    };

export type PluginDispatchOutcome =
  | PluginDispatchDelivery
  | { status: "skipped"; reason: "plugin_offline" | "reach_denied" };

/** The reach queries the gate needs — satisfied by featureReachResolver. */
export interface DispatchReachResolver {
  hasAnyFeatureEnabledInGuild(
    pluginId: number,
    guildId: string,
    manifest: PluginManifest,
  ): Promise<boolean>;
  isFeatureEnabledInGuild(
    pluginId: number,
    guildId: string,
    featureKey: string,
    manifest: PluginManifest,
  ): Promise<boolean>;
}

export interface PluginDispatcherDeps {
  /** Direct transport. Defaults to global fetch, resolved at call time
   *  so test spies on `globalThis.fetch` are honored. */
  fetchImpl?: typeof fetch;
  /** Pooled transport (event kind). A fresh pool is created when omitted. */
  pool?: PluginDispatchPool;
  /** Out-of-process event bus; `null` = HTTP fan-out. Resolved per
   *  dispatch (the registry memoizes construction). */
  getEventBus?: () => PluginEventBus | null;
  reach?: DispatchReachResolver;
}

export interface PluginDispatcher {
  gate(req: PluginGateRequest): Promise<PluginDispatchGate>;
  deliver(req: PluginDeliverRequest): Promise<PluginDispatchDelivery>;
  /** gate + deliver for kinds with no defer step in between. */
  dispatch(
    req: PluginGateRequest & PluginDeliverRequest,
  ): Promise<PluginDispatchOutcome>;
  /** The pooled transport — exposed for snapshot/stop/drop management. */
  pool: PluginDispatchPool;
}

/**
 * Map a pool outcome onto the dispatch-health vocabulary (PM-7.9.1).
 * Failure outcomes don't carry a body, so the awaiting-register
 * refinement of 503s isn't available on this path — a plain
 * `http_error` is recorded instead. Pool-level timeouts surface as
 * undici errors and land in `network`.
 *
 * Returns null for `breaker_open` / `shed` short-circuits: they never
 * touch the network and occur at message-traffic rate once the
 * breaker trips, so recording them floods the 20-entry recent window
 * within seconds — evicting the root-cause rejected_401 entries the
 * badge keys on and inflating consecutiveFailures into the thousands.
 * The real failures that tripped the breaker were already recorded;
 * the metrics counters still count every short-circuit.
 */
function dispatchAttemptFromOutcome(
  outcome: PoolOutcome,
  eventType: string,
): Omit<DispatchAttempt, "at"> | null {
  if (outcome.ok) {
    return { ok: true, source: "event", status: outcome.status };
  }
  if (outcome.reason === "breaker_open" || outcome.reason === "shed") {
    return null;
  }
  return {
    ok: false,
    source: "event",
    ...(outcome.status !== undefined ? { status: outcome.status } : {}),
    failureClass:
      outcome.reason === "http_error"
        ? classifyDispatchHttpFailure(outcome.status ?? 0, "")
        : "network",
    message: `${eventType}: ${outcome.message}`,
  };
}

export function createPluginDispatcher(
  deps: PluginDispatcherDeps = {},
): PluginDispatcher {
  const pool =
    deps.pool ??
    new PluginDispatchPool({
      ...DEFAULT_DISPATCH_POOL_OPTIONS,
      requestTimeoutMs: config.plugin.dispatchTimeoutMs,
    });
  const getEventBus = deps.getEventBus ?? getPluginEventBus;
  const reach: DispatchReachResolver = deps.reach ?? featureReachResolver;

  async function gate(req: PluginGateRequest): Promise<PluginDispatchGate> {
    const spec = KIND_SPECS[req.kind];
    const plugin = req.plugin;
    if (!plugin.enabled || plugin.status !== "active") {
      return { ok: false, reason: "plugin_offline" };
    }
    let manifest: PluginManifest | null = null;
    if (spec.requireManifest) {
      manifest = parsePluginManifest(plugin);
      if (!manifest) return { ok: false, reason: "manifest_invalid" };
    }
    if (spec.reach === "any-feature" && req.guildId && manifest) {
      // Once an admin disables every feature of this plugin in guild G,
      // older buttons/modals on existing messages must stop dispatching
      // into the plugin. 3-tier resolution (Precedence Tiers) so a
      // manifest defaulting its features to enabled isn't falsely
      // blocked before any row is materialized.
      if (
        !(await reach.hasAnyFeatureEnabledInGuild(
          plugin.id,
          req.guildId,
          manifest,
        ))
      ) {
        return { ok: false, reason: "reach_denied" };
      }
    } else if (spec.reach === "per-scope") {
      // Any one scope passing grants delivery exactly once:
      //   - "global" routes exist only when approved (index build);
      //   - feature routes need the event's guild to have that feature
      //     effectively enabled; a guild-less (DM) event never matches
      //     a feature route.
      let pass = false;
      for (const scope of req.scopes ?? []) {
        if (scope === "global") {
          pass = true;
          break;
        }
        if (!req.guildId) continue;
        // Memoized per row — parses at most once per dispatch. An
        // unparseable manifest fails this scope closed but does NOT
        // abort the loop, so a co-declared "global" scope can still
        // grant delivery.
        const m = parsePluginManifest(plugin);
        if (!m) continue;
        if (
          await reach.isFeatureEnabledInGuild(
            plugin.id,
            req.guildId,
            scope.featureKey,
            m,
          )
        ) {
          pass = true;
          break;
        }
      }
      if (!pass) return { ok: false, reason: "reach_denied" };
    }
    if (spec.requireKey && !plugin.dispatchHmacKey) {
      return { ok: false, reason: "no_dispatch_key" };
    }
    return { ok: true, manifest };
  }

  async function deliver(
    req: PluginDeliverRequest,
  ): Promise<PluginDispatchDelivery> {
    const spec = KIND_SPECS[req.kind];
    const plugin = req.plugin;

    // The bus is a transport INSIDE the module, before any HTTP-only
    // concern: no signing key, no manifest endpoint, no preflight —
    // the plugin's private mailbox stream needs none of them.
    if (spec.transport === "pooled" && "data" in req.payload) {
      const bus = getEventBus();
      if (bus) {
        bus.dispatchToPlugin(
          plugin.id,
          plugin.pluginKey,
          req.label,
          req.payload.data,
        );
        return { status: "ok" };
      }
    }

    const signingKey = plugin.dispatchHmacKey;
    if (!signingKey) return { status: "skipped", reason: "no_dispatch_key" };
    const manifest = parsePluginManifest(plugin);
    if (!manifest) return { status: "skipped", reason: "manifest_invalid" };

    const template = spec.endpointTemplate(manifest);
    if (template === null) return { status: "skipped", reason: "no_endpoint" };
    const url = resolvePluginEndpoint(
      plugin.url,
      template,
      req.endpointVars ?? {},
    );
    if (!url) {
      recordDispatchUnreachable(
        plugin.pluginKey,
        spec.source,
        req.label,
        "unresolvable plugin endpoint URL",
      );
      return {
        status: "failed",
        reason: "unresolvable_endpoint",
        detail: "unresolvable plugin endpoint URL",
      };
    }

    const preflight = await preflightPluginTarget(url);
    if (!preflight.ok) {
      recordDispatchUnreachable(
        plugin.pluginKey,
        spec.source,
        req.label,
        preflight.reason,
      );
      return {
        status: "failed",
        reason: "preflight_denied",
        detail: preflight.reason,
      };
    }

    const body =
      "body" in req.payload
        ? await req.payload.body()
        : JSON.stringify({ type: req.label, data: req.payload.data });

    if (spec.transport === "pooled") {
      return postPooled(spec, plugin, req.label, url, body, signingKey);
    }
    return postDirect(spec, plugin, req.label, url, body, signingKey);
  }

  async function postDirect(
    spec: KindSpec,
    plugin: PluginRow,
    label: string,
    url: string,
    body: string,
    signingKey: string,
  ): Promise<PluginDispatchDelivery> {
    const headers = buildSignedDispatchHeaders(signingKey, url, body);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), spec.timeoutMs);
    try {
      const res = await (deps.fetchImpl ?? globalThis.fetch)(url, {
        method: "POST",
        headers,
        body,
        // Don't follow redirects past the assertPluginTarget host check — a
        // 3xx Location would bypass the SSRF guard (cf. webhook-forwarder).
        redirect: "manual",
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        recordDispatchHttpFailure(
          plugin.pluginKey,
          spec.source,
          label,
          res.status,
          text,
        );
        return {
          status: "failed",
          reason: "http_error",
          httpStatus: res.status,
          detail: text,
          failureClass: classifyDispatchHttpFailure(res.status, text),
        };
      }
      recordDispatchOk(plugin.pluginKey, spec.source, res.status);
      if (spec.readBody) {
        const data = (await res.json().catch(() => null)) as unknown;
        return { status: "ok", httpStatus: res.status, body: data };
      }
      // Body not consumed — the plugin completes the interaction via
      // the interactions.respond RPC; a synchronous body action here
      // would race the plugin's own RPC call.
      return { status: "ok", httpStatus: res.status };
    } catch (err) {
      recordDispatchFetchFailure(plugin.pluginKey, spec.source, label, err);
      return {
        status: "failed",
        reason: "network",
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function postPooled(
    spec: KindSpec,
    plugin: PluginRow,
    label: string,
    url: string,
    body: string,
    signingKey: string,
  ): Promise<PluginDispatchDelivery> {
    const sigHeaders = buildOutboundSignatureHeaders(
      signingKey,
      "POST",
      new URL(url).pathname,
      body,
    );
    // Stamp a fresh W3C trace context onto every outbound event
    // dispatch. Discord events arriving at the bot don't carry a
    // parent traceparent, so this is the root span for the
    // bot→plugin→reaction chain. Plugins read this off the SDK's
    // `ctx.traceparent` and forward it on any RPC they make back.
    const headers = spec.traceparent
      ? { ...sigHeaders, [TRACEPARENT_HEADER]: newTraceContext().traceparent }
      : sigHeaders;
    const startedAt = Date.now();
    const outcome = await pool.post(plugin.pluginKey, url, headers, body);
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    // Per-(plugin, event_type) latency + outcome counters. `shard_id`
    // carries this process's shard label (defaults to "0" in
    // single-shard deployments).
    pluginEventDispatchDuration.observe(
      {
        event_type: label,
        plugin_id: plugin.pluginKey,
        shard_id: String(config.bot.shardId),
      },
      elapsedSeconds,
    );
    pluginEventDispatchTotal.inc({
      event_type: label,
      outcome: outcome.ok ? "ok" : outcome.reason,
      plugin_id: plugin.pluginKey,
      shard_id: String(config.bot.shardId),
    });
    const attempt = dispatchAttemptFromOutcome(outcome, label);
    if (attempt) recordDispatchAttempt(plugin.pluginKey, attempt);
    if (outcome.ok) return { status: "ok", httpStatus: outcome.status };
    return {
      status: "failed",
      reason: outcome.reason,
      ...(outcome.status !== undefined ? { httpStatus: outcome.status } : {}),
      detail: outcome.message,
    };
  }

  return {
    gate,
    deliver,
    async dispatch(req) {
      const g = await gate(req);
      if (!g.ok) return { status: "skipped", reason: g.reason };
      return deliver(req);
    },
    pool,
  };
}

/**
 * The production dispatcher. Its pool is a singleton because pools are
 * keyed by pluginKey internally; the management functions below act on
 * this instance.
 */
export const pluginDispatcher = createPluginDispatcher();

/** Snapshot of per-plugin pool state for metrics + admin UI. */
export function getDispatchPoolSnapshot(): ReturnType<
  PluginDispatchPool["snapshot"]
> {
  return pluginDispatcher.pool.snapshot();
}

/** Stop the dispatch pool — called from gracefulShutdown. */
export async function stopDispatchPool(): Promise<void> {
  await pluginDispatcher.pool.stop();
}

/**
 * Drop the per-plugin dispatch pool entry (closes keep-alive sockets,
 * resets breaker state). Call on plugin delete / URL change /
 * re-register so a previously-tripped breaker doesn't survive the
 * operator's recovery action.
 */
export function dropDispatchPoolForPlugin(pluginKey: string): void {
  pluginDispatcher.pool.drop(pluginKey);
}
