/**
 * Per-plugin outbound dispatch pool — undici HTTP keep-alive + a
 * per-plugin in-flight semaphore + a circuit breaker over consecutive
 * failures.
 *
 * Pre-Phase-0.3 fan-out (`plugin-event-bridge.service.ts`) used the
 * global `fetch()` for every event POST. Two problems at scale:
 *
 *   1. Every call opened a fresh TCP socket. With N plugins × ~5 msg/s
 *      per guild × 2500 guilds the fan-out runs into ephemeral-port
 *      exhaustion long before bandwidth becomes the limit.
 *   2. A wedged plugin (slow handler, hung process, network blip) would
 *      stack unbounded in-flight requests against itself, eating heap
 *      and starving healthy plugins' fan-out budget.
 *
 * This module fixes both:
 *
 *   - One `undici.Pool` per `<scheme>://<host>:<port>` (keyed by the
 *     plugin's URL origin), with keep-alive + connection cap. Pools
 *     are reused across event types — every dispatch to the same
 *     plugin shares the same TCP connections.
 *
 *   - A semaphore caps `inFlight` requests per plugin. When the cap
 *     is hit the dispatch returns `{ ok: false, reason: "shed" }`
 *     immediately rather than queueing forever. Callers (the
 *     event-bridge) log + drop — the bot is fire-and-forget anyway.
 *
 *   - A circuit breaker per plugin closes the fan-out for
 *     `BREAKER_OPEN_MS` after `BREAKER_THRESHOLD` consecutive
 *     failures. While open, every call returns `{ ok: false,
 *     reason: "breaker_open" }` without touching the network.
 *     A single half-open probe re-tests the upstream when the open
 *     window expires; success closes the breaker, failure reopens it.
 *
 *   - ECONNREFUSED / "fetch failed" is retried once after a short
 *     delay (250 ms). This covers the [[bot-plugin-proxy-recreate-race]]
 *     window — a plugin container that just restarted is unreachable
 *     for a couple of hundred ms while its Fastify server binds.
 */

import {
  Pool,
  type Dispatcher,
  errors as undiciErrors,
} from "undici";

export type DispatchOutcome =
  | { ok: true; status: number; bodyText: string }
  | {
      ok: false;
      /**
       *  - `shed`: per-plugin concurrency cap was hit.
       *  - `breaker_open`: circuit breaker is open for this plugin.
       *  - `connect_refused`: TCP layer rejected (after one retry).
       *  - `network`: any other network-layer failure (DNS, abort, …).
       *  - `http_error`: upstream returned non-2xx. `status` is set.
       */
      reason:
        | "shed"
        | "breaker_open"
        | "connect_refused"
        | "network"
        | "http_error";
      status?: number;
      message: string;
    };

/**
 * Per-plugin runtime knobs. Defaults are tuned for the single-host
 * baseline; SCALING_PLAN Phase 1+ pushes them up.
 */
export interface DispatchPoolOptions {
  /** Max concurrent in-flight requests per plugin. Drop incoming when hit. */
  maxInFlight: number;
  /** Keep-alive idle socket cap PER upstream origin. */
  maxKeepAliveConnections: number;
  /** Per-request timeout. */
  requestTimeoutMs: number;
  /** Consecutive failures before the breaker trips open. */
  breakerThreshold: number;
  /** How long the breaker stays open before allowing a single probe. */
  breakerOpenMs: number;
  /** Delay between the first attempt and the connect-refused retry. */
  connectRetryDelayMs: number;
}

export const DEFAULT_DISPATCH_POOL_OPTIONS: DispatchPoolOptions = {
  maxInFlight: 100,
  maxKeepAliveConnections: 10,
  requestTimeoutMs: 5_000,
  breakerThreshold: 5,
  breakerOpenMs: 30_000,
  connectRetryDelayMs: 250,
};

interface PluginPoolEntry {
  pool: Pool;
  origin: string;
  inFlight: number;
  consecutiveFailures: number;
  /** Wall-clock ms when the breaker should next allow a probe. 0 when closed. */
  breakerNextProbeAt: number;
  /** True while a half-open probe is in flight. */
  breakerProbeInFlight: boolean;
}

type FailureReason = Exclude<
  Extract<DispatchOutcome, { ok: false }>["reason"],
  "shed" | "breaker_open"
>;

export class PluginDispatchPool {
  private readonly pools = new Map<string, PluginPoolEntry>();

  constructor(private readonly opts: DispatchPoolOptions = DEFAULT_DISPATCH_POOL_OPTIONS) {}

  /** Fire a POST to the plugin. Fire-and-forget at the caller level. */
  async post(
    pluginKey: string,
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<DispatchOutcome> {
    const parsed = new URL(url);
    const origin = `${parsed.protocol}//${parsed.host}`;
    const entry = this.getOrCreate(pluginKey, origin);

    const now = Date.now();
    if (entry.breakerNextProbeAt > now) {
      // Breaker open; cut everyone off until the open window elapses.
      return {
        ok: false,
        reason: "breaker_open",
        message: "circuit breaker open",
      };
    }
    let claimedProbe = false;
    if (entry.breakerNextProbeAt > 0 && entry.breakerNextProbeAt <= now) {
      // Open window elapsed — half-open. Allow exactly one probe
      // through; everyone else still gets short-circuited.
      if (entry.breakerProbeInFlight) {
        return {
          ok: false,
          reason: "breaker_open",
          message: "circuit breaker open (probe in flight)",
        };
      }
      claimedProbe = true;
    }

    if (entry.inFlight >= this.opts.maxInFlight) {
      // Don't claim the probe slot on a shed: an early return here
      // bypasses the try/finally that resets breakerProbeInFlight, so
      // setting it before this check would wedge the breaker open
      // forever on the next call.
      return {
        ok: false,
        reason: "shed",
        message: `in-flight cap ${this.opts.maxInFlight} reached`,
      };
    }
    if (claimedProbe) entry.breakerProbeInFlight = true;
    entry.inFlight++;

    try {
      let attempt = 0;
      // First-pass + one retry for transient connect refusal. Anything
      // beyond that is the breaker's job.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        attempt++;
        const result = await this.tryOnce(entry, parsed, headers, body);
        if (result.ok) {
          this.onSuccess(entry);
          return result;
        }
        if (result.reason === "connect_refused" && attempt === 1) {
          await sleep(this.opts.connectRetryDelayMs);
          continue;
        }
        // `shed` and `breaker_open` are never produced by tryOnce —
        // the breaker / semaphore gates above return early before
        // reaching here. tryOnce only emits the four FailureReason values.
        this.onFailure(entry, result.reason as FailureReason);
        return result;
      }
    } finally {
      entry.inFlight--;
      // If this call was the half-open probe, clear the flag now —
      // onSuccess / onFailure already decided whether to close or
      // reopen the breaker.
      entry.breakerProbeInFlight = false;
    }
  }

  /** Snapshot of breaker state for metrics + admin UI. */
  snapshot(): Array<{
    pluginKey: string;
    inFlight: number;
    consecutiveFailures: number;
    breakerOpen: boolean;
  }> {
    return Array.from(this.pools.entries()).map(([pluginKey, e]) => ({
      pluginKey,
      inFlight: e.inFlight,
      consecutiveFailures: e.consecutiveFailures,
      breakerOpen: e.breakerNextProbeAt > Date.now(),
    }));
  }

  async stop(): Promise<void> {
    await Promise.all(
      Array.from(this.pools.values()).map((e) =>
        e.pool.close().catch(() => undefined),
      ),
    );
    this.pools.clear();
  }

  /**
   * Test/operational hook: drop the pool for a plugin (e.g. when its
   * URL changes in the DB). Next dispatch lazily rebuilds.
   */
  drop(pluginKey: string): void {
    const entry = this.pools.get(pluginKey);
    if (!entry) return;
    void entry.pool.close().catch(() => undefined);
    this.pools.delete(pluginKey);
  }

  private getOrCreate(pluginKey: string, origin: string): PluginPoolEntry {
    const existing = this.pools.get(pluginKey);
    if (existing && existing.origin === origin) return existing;
    // Plugin URL changed — close the old pool, rebuild.
    if (existing) {
      void existing.pool.close().catch(() => undefined);
    }
    const pool = new Pool(origin, {
      connections: this.opts.maxKeepAliveConnections,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 60_000,
      pipelining: 1,
    });
    const fresh: PluginPoolEntry = {
      pool,
      origin,
      inFlight: 0,
      consecutiveFailures: 0,
      breakerNextProbeAt: 0,
      breakerProbeInFlight: false,
    };
    this.pools.set(pluginKey, fresh);
    return fresh;
  }

  private async tryOnce(
    entry: PluginPoolEntry,
    parsed: URL,
    headers: Record<string, string>,
    body: string,
  ): Promise<DispatchOutcome> {
    let res: Dispatcher.ResponseData;
    try {
      res = await entry.pool.request({
        method: "POST",
        path: parsed.pathname + parsed.search,
        headers: { ...headers, "content-type": "application/json" },
        body,
        bodyTimeout: this.opts.requestTimeoutMs,
        headersTimeout: this.opts.requestTimeoutMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isConnectRefused(err)) {
        return { ok: false, reason: "connect_refused", message: msg };
      }
      return { ok: false, reason: "network", message: msg };
    }
    // We don't care about the body; read it to release the socket.
    let bodyText = "";
    try {
      bodyText = await res.body.text();
    } catch {
      /* swallow read error — connection-level success is enough */
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return { ok: true, status: res.statusCode, bodyText };
    }
    return {
      ok: false,
      reason: "http_error",
      status: res.statusCode,
      message: `HTTP ${res.statusCode}`,
    };
  }

  private onSuccess(entry: PluginPoolEntry): void {
    entry.consecutiveFailures = 0;
    entry.breakerNextProbeAt = 0;
  }

  private onFailure(entry: PluginPoolEntry, _reason: FailureReason): void {
    entry.consecutiveFailures++;
    if (entry.consecutiveFailures >= this.opts.breakerThreshold) {
      entry.breakerNextProbeAt = Date.now() + this.opts.breakerOpenMs;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}

function isConnectRefused(err: unknown): boolean {
  if (err instanceof undiciErrors.SocketError) return true;
  if (err instanceof undiciErrors.ConnectTimeoutError) return false;
  const code = (err as { code?: string } | null)?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ETIMEDOUT"
  );
}
