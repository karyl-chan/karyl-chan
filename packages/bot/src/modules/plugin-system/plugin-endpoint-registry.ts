/**
 * Multi-endpoint, TTL-bounded address registry for a plugin.
 *
 * The `plugins` DB row holds ONE canonical `url` per pluginKey — the
 * address the most recent register/heartbeat advertised. That is enough
 * for the single-replica default (one container per pluginKey) and stays
 * the source of truth for the reverse proxy + RPC attachment fetches.
 *
 * When a plugin runs MORE than one replica (k8s Deployment with
 * replicas>1, or a docker-compose `deploy.replicas`), every replica
 * self-registers + heartbeats the SAME pluginKey but a DIFFERENT
 * advertised url. The DB row can only remember the last writer, so the
 * other live replicas would be invisible. This module remembers them
 * all: a per-pluginKey set of `{ url, lastSeenMs }` entries, each with
 * an independent TTL. A replica that stops heartbeating ages out of the
 * set without affecting its siblings — the multi-endpoint analogue of
 * the DB reaper's single-row expiry.
 *
 * It is a pure in-memory structure with an injectable clock so the TTL
 * logic is unit-testable without timers. It holds NO open resources and
 * is safe to construct per process. The discovery adapter (PR-3.2) reads
 * from it; nothing here touches the DB or the network.
 *
 * Single-machine invariant: with exactly one replica per pluginKey the
 * set always has size 1 and `endpoints()` returns the same single url
 * the DB row carries — so callers that ignore this registry (the
 * default path) see byte-for-byte current behaviour.
 */

export interface EndpointEntry {
  url: string;
  lastSeenMs: number;
}

export interface PluginEndpointRegistryOptions {
  /** An endpoint not seen for this long is considered dead. */
  ttlMs: number;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
}

export class PluginEndpointRegistry {
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** pluginKey → (url → entry). Inner map keyed by url for O(1) touch. */
  private readonly byKey = new Map<string, Map<string, EndpointEntry>>();

  constructor(opts: PluginEndpointRegistryOptions) {
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Record that `url` for `pluginKey` is alive as of now. Idempotent —
   * re-touching an existing url just slides its lastSeen forward (this
   * is what every heartbeat does). Adding a never-seen url grows the
   * live set (a new replica appeared).
   */
  touch(pluginKey: string, url: string): void {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    let inner = this.byKey.get(pluginKey);
    if (!inner) {
      inner = new Map();
      this.byKey.set(pluginKey, inner);
    }
    inner.set(normalized, { url: normalized, lastSeenMs: this.now() });
  }

  /**
   * Drop one url for a pluginKey immediately (graceful deregister of a
   * single replica). No-op if absent. When the last url for a key is
   * removed the key's bucket is dropped too.
   */
  remove(pluginKey: string, url: string): void {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    const inner = this.byKey.get(pluginKey);
    if (!inner) return;
    inner.delete(normalized);
    if (inner.size === 0) this.byKey.delete(pluginKey);
  }

  /** Drop every endpoint for a pluginKey (plugin fully deleted/disabled). */
  removeAll(pluginKey: string): void {
    this.byKey.delete(pluginKey);
  }

  /**
   * Live (non-expired) endpoint urls for a pluginKey, in stable
   * insertion order so callers that round-robin get a deterministic
   * sequence. Expired entries are pruned lazily on read.
   */
  endpoints(pluginKey: string): string[] {
    const inner = this.byKey.get(pluginKey);
    if (!inner) return [];
    const cutoff = this.now() - this.ttlMs;
    const live: string[] = [];
    for (const [url, entry] of inner) {
      if (entry.lastSeenMs >= cutoff) {
        live.push(url);
      } else {
        inner.delete(url);
      }
    }
    if (inner.size === 0) this.byKey.delete(pluginKey);
    return live;
  }

  /**
   * Sweep every key, dropping endpoints older than the TTL. Returns the
   * pluginKeys that lost at least one endpoint (so the caller can log /
   * invalidate caches). Cheap: bounded by total endpoint count.
   */
  reap(): string[] {
    const cutoff = this.now() - this.ttlMs;
    const affected: string[] = [];
    for (const [key, inner] of this.byKey) {
      let dropped = false;
      for (const [url, entry] of inner) {
        if (entry.lastSeenMs < cutoff) {
          inner.delete(url);
          dropped = true;
        }
      }
      if (dropped) affected.push(key);
      if (inner.size === 0) this.byKey.delete(key);
    }
    return affected;
  }

  /** Test/diagnostic — number of pluginKeys currently tracked. */
  size(): number {
    return this.byKey.size;
  }
}

/**
 * Normalise an advertised url to a canonical form (strip trailing
 * slashes) so the same address registered with/without a trailing slash
 * is deduplicated to one endpoint. Returns "" for an empty/non-string
 * input so callers can treat it as "nothing to record".
 */
function normalizeUrl(url: string): string {
  if (typeof url !== "string") return "";
  return url.replace(/\/+$/, "");
}

/**
 * Process-wide singleton. TTL mirrors the DB heartbeat timeout so an
 * endpoint and its DB row age out on the same schedule. The reaper
 * interval that drives DB expiry also sweeps this registry (see
 * plugin-registry.service.ts startReaper).
 */
import { config } from "../../config.js";

export const pluginEndpointRegistry = new PluginEndpointRegistry({
  ttlMs: config.plugin.heartbeatTimeoutMs,
});
