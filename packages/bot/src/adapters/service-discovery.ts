/**
 * ServiceDiscovery — resolves a plugin's logical key to one or more
 * concrete, reachable base URLs.
 *
 * Why an abstraction (PR-3.2): plugin addresses used to be a single
 * static value (compose's `PLUGIN_URL` → the DB `plugins.url` row). That
 * is fine for one container per plugin on one host. In a clustered
 * deployment a plugin runs as N replicas behind a Service, and the
 * concrete endpoints change as Pods come and go — the bot must resolve
 * the live set at call time instead of trusting one frozen address.
 *
 * Two implementations, selected by env exactly like the other adapters
 * (see registry.ts):
 *
 *   - InProcessServiceDiscovery (default, `SERVICE_DISCOVERY` unset /
 *     `inprocess`): the DB registry IS the discovery source. Returns the
 *     `plugins.url` row, augmented with any extra live replica endpoints
 *     the in-memory PluginEndpointRegistry (PR-3.1) has seen. For the
 *     single-replica default this is exactly the one DB url — byte-for-
 *     byte current behaviour.
 *
 *   - DnsServiceDiscovery (`SERVICE_DISCOVERY=dns` or `k8s`): resolves
 *     the host of the plugin's advertised url via DNS A/AAAA records.
 *     Behind a Kubernetes *headless* Service (clusterIP: None) the
 *     Service DNS name resolves to one record per ready Pod, so this
 *     yields one base URL per replica and the caller load-distributes
 *     across them. Behind a normal ClusterIP Service the single VIP is
 *     returned and kube-proxy does the balancing — also correct.
 *
 * The interface is intentionally tiny: given the plugin's primary base
 * url (from the DB row) and its key, return the set of base urls to try.
 * It does NOT do health-checking, breaker state, or retries — those
 * already live in the dispatch pool / proxy. Discovery only answers
 * "where does this plugin live right now".
 */

import { promises as dns } from "node:dns";

export interface ServiceDiscovery {
  /**
   * Resolve a plugin to its currently-reachable base URLs.
   *
   * @param pluginKey  The plugin's logical key (`plugins.pluginKey`).
   * @param primaryUrl The plugin's advertised base url (the DB row's
   *                   `url`). Always a valid http(s) URL string.
   * @returns A non-empty, de-duplicated list of base URLs. The first
   *          element is the caller's preferred default; the rest are
   *          alternative live endpoints (replicas). Implementations MUST
   *          fall back to `[primaryUrl]` rather than returning an empty
   *          list when they cannot resolve anything better.
   */
  resolve(pluginKey: string, primaryUrl: string): Promise<string[]>;
}

/**
 * Default impl: the DB registry + in-memory endpoint set from PR-3.1.
 * The `extraEndpoints` callback is injected (rather than importing the
 * singleton) so this stays a pure unit under test.
 */
export class InProcessServiceDiscovery implements ServiceDiscovery {
  constructor(
    private readonly extraEndpoints: (pluginKey: string) => string[] = () => [],
  ) {}

  async resolve(pluginKey: string, primaryUrl: string): Promise<string[]> {
    const primary = stripTrailingSlash(primaryUrl);
    const out = [primary];
    for (const ep of this.extraEndpoints(pluginKey)) {
      const norm = stripTrailingSlash(ep);
      if (norm && !out.includes(norm)) out.push(norm);
    }
    return out;
  }
}

/**
 * DNS-SD impl for clustered (k8s / Consul DNS / docker-swarm DNS-RR)
 * deployments. Resolves the host of `primaryUrl` to its A/AAAA records
 * and rebuilds one base URL per resolved address, preserving the
 * original scheme + port. Hostnames that are already literal IPs, or
 * that fail to resolve, fall back to `[primaryUrl]` so a transient DNS
 * blip never strands a plugin.
 *
 * Resolutions are cached for a short TTL so a hot request path doesn't
 * issue a DNS lookup per call (kube-dns is fast but not free). The TTL
 * is small enough that a scaled-up/down replica set is picked up within
 * a few seconds.
 */
export class DnsServiceDiscovery implements ServiceDiscovery {
  private readonly cacheTtlMs: number;
  private readonly lookup: (host: string) => Promise<string[]>;
  private readonly now: () => number;
  private readonly cache = new Map<
    string,
    { urls: string[]; expiresAt: number }
  >();

  constructor(opts?: {
    cacheTtlMs?: number;
    /** Injectable resolver for tests; defaults to node:dns A+AAAA lookup. */
    lookup?: (host: string) => Promise<string[]>;
    now?: () => number;
  }) {
    this.cacheTtlMs = opts?.cacheTtlMs ?? 5_000;
    this.lookup = opts?.lookup ?? defaultDnsLookup;
    this.now = opts?.now ?? Date.now;
  }

  async resolve(pluginKey: string, primaryUrl: string): Promise<string[]> {
    const primary = stripTrailingSlash(primaryUrl);
    let parsed: URL;
    try {
      parsed = new URL(primary);
    } catch {
      return [primary];
    }
    const host = parsed.hostname;
    // A literal IP has nothing to discover — return it as-is.
    if (isIpLiteral(host)) return [primary];

    const cached = this.cache.get(primary);
    if (cached && cached.expiresAt > this.now()) {
      return cached.urls;
    }

    let addresses: string[];
    try {
      addresses = await this.lookup(host);
    } catch {
      // DNS failure: fall back to the primary url (which the platform's
      // own DNS will still resolve on the actual connect attempt).
      return [primary];
    }
    if (addresses.length === 0) return [primary];

    // Rebuild one base URL per resolved address, keeping scheme + port.
    const portSuffix = parsed.port ? `:${parsed.port}` : "";
    const urls = dedupe(
      addresses.map((addr) => {
        const hostPart = addr.includes(":") ? `[${addr}]` : addr; // bracket IPv6
        return `${parsed.protocol}//${hostPart}${portSuffix}`;
      }),
    );
    const result = urls.length > 0 ? urls : [primary];
    this.cache.set(primary, {
      urls: result,
      expiresAt: this.now() + this.cacheTtlMs,
    });
    return result;
  }
}

function stripTrailingSlash(url: string): string {
  return typeof url === "string" ? url.replace(/\/+$/, "") : "";
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/**
 * True for an IPv4/IPv6 literal hostname. We only need a cheap
 * heuristic — `new URL()` already validated the host shape, so a string
 * with a dot-and-digits-only / colon form is a literal, not a name to
 * resolve.
 */
function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4
  if (host.includes(":")) return true; // IPv6 (URL hostname has brackets stripped)
  return false;
}

async function defaultDnsLookup(host: string): Promise<string[]> {
  // Resolve A then AAAA; union both so dual-stack Services work. Either
  // failing alone is tolerated (return whatever the other gave).
  const [a, aaaa] = await Promise.allSettled([
    dns.resolve4(host),
    dns.resolve6(host),
  ]);
  const out: string[] = [];
  if (a.status === "fulfilled") out.push(...a.value);
  if (aaaa.status === "fulfilled") out.push(...aaaa.value);
  return out;
}
