/**
 * media-target — the public-media address rule (#158).
 *
 * The single definition of "which addresses may a voice media URL reach".
 * Two callers share it:
 *   - the bot's `assertPublicMediaTarget` (host-policy.ts), the up-front
 *     check that gives the user a readable refusal;
 *   - the voice media proxy (`media-proxy.ts`), which runs it on EVERY
 *     request ffmpeg makes — first URL, each redirect hop, each HLS
 *     variant / segment / key — and connects only to the addresses it
 *     returns (pinned, so DNS rebinding between check and connect cannot
 *     redirect it).
 *
 * It also holds the plugin-target rule (`isPluginTargetAddress`, the
 * bot's `assertPluginTarget`), because a plugin may hand voice a URL on
 * its own origin — a docker-internal address the public rule refuses —
 * and the proxy must apply that rule to exactly that origin
 * (`mediaPolicyFor`).
 *
 * No imports beyond node built-ins: it is reachable from the bot's
 * config chain through the side-effect-free `@karyl-chan/voice/net`
 * subpath.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  classifyAddress,
  transitionEmbeddedIPv4,
  type AddressClass,
} from "./ip-address.js";
import type { PinnedAddress } from "./pinned-lookup.js";

/**
 * Hostnames of cloud metadata services. Refused by name, before DNS, by
 * every host policy (bot and voice) — whatever they resolve to.
 */
export const METADATA_HOSTNAMES: ReadonlySet<string> = new Set([
  "metadata.google.internal",
  "metadata",
  "metadata.goog",
  "metadata.azure.com",
]);

/** Lower-case and drop the FQDN trailing dot, so `NAS.lan.` == `nas.lan`. */
export function normalizeHostname(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** A media target the public-media rule refused. */
export class MediaTargetRefusedError extends Error {
  constructor(
    message: string,
    /** Why: bad host / port syntax, a metadata name, DNS, or an address class. */
    public readonly reason:
      | "invalid_host"
      | "invalid_port"
      | "blocked_metadata"
      | "dns_failed"
      | "blocked_address",
  ) {
    super(message);
    this.name = "MediaTargetRefusedError";
  }
}

export interface MediaAddressOptions {
  /** The legacy WEBHOOK_ALLOW_PRIVATE dev hatch: also pass `private`. */
  allowPrivate?: boolean;
}

/**
 * The rule itself. Only `public` addresses pass: cloud metadata,
 * link-local, loopback, unspecified, RFC1918 / shared / ULA, non-routable
 * ranges and the NAT64 / 6to4 transition prefixes are refused. With
 * `allowPrivate` (the legacy dev hatch) `private` passes too — nothing
 * else does. A non-literal never passes.
 */
export function isPublicMediaAddress(
  address: string,
  { allowPrivate = false }: MediaAddressOptions = {},
): boolean {
  const cls = classifyAddress(address);
  if (cls === "public") return true;
  if (cls === "private") return allowPrivate;
  return false;
}

/**
 * True when the legacy WEBHOOK_ALLOW_PRIVATE dev hatch is on. Read from
 * process.env per call so tests can flip it per case; operators set it
 * once at deploy time. Never enable it in production.
 */
export function legacyAllowPrivate(): boolean {
  return process.env.WEBHOOK_ALLOW_PRIVATE === "true";
}

type Lookup = (
  host: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface ResolveMediaTargetOptions {
  /** DNS resolver (test seam). Defaults to `dns.promises.lookup`. */
  lookup?: Lookup;
}

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-.]*[a-zA-Z0-9])?$/;

function stripIPv6Brackets(host: string): string {
  return host.length >= 2 && host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
}

/**
 * The plugin-target rule (the bot's `assertPluginTarget`): public and
 * private (RFC1918 / ULA — docker bridge networks) pass; loopback passes
 * only with `allowLoopback` (outside production); metadata, link-local,
 * unspecified and reserved never pass. NAT64 / 6to4 addresses are judged
 * by the IPv4 they embed (an undecodable embedding is refused). A
 * non-literal never passes.
 */
export function isPluginTargetAddress(
  address: string,
  { allowLoopback }: { allowLoopback: boolean },
): boolean {
  const allowed = (cls: AddressClass | null): boolean => {
    if (cls === "public" || cls === "private") return true;
    if (cls === "loopback") return allowLoopback;
    return false;
  };
  const cls = classifyAddress(address);
  if (cls === "transition") {
    const v4 = transitionEmbeddedIPv4(address);
    return v4 !== null && allowed(classifyAddress(v4));
  }
  return allowed(cls);
}

/**
 * Vet a host and port and return every address it stands for (never
 * empty, resolver order) — connect only to these. Refuses
 * (MediaTargetRefusedError) a malformed host or port, a metadata
 * hostname, a failed / empty lookup, and a host with ANY address that
 * `isAllowed` rejects.
 */
async function resolveVetted(
  rawHost: string,
  port: number,
  isAllowed: (address: string) => boolean,
  lookup: Lookup,
): Promise<PinnedAddress[]> {
  const host = stripIPv6Brackets(rawHost);
  if (!(HOSTNAME_RE.test(host) || isIP(host) !== 0)) {
    throw new MediaTargetRefusedError("invalid host", "invalid_host");
  }
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new MediaTargetRefusedError("invalid port", "invalid_port");
  }
  if (METADATA_HOSTNAMES.has(normalizeHostname(host))) {
    throw new MediaTargetRefusedError("metadata hostname", "blocked_metadata");
  }
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    let answers: Array<{ address: string }>;
    try {
      answers = await lookup(host, { all: true });
    } catch {
      throw new MediaTargetRefusedError("DNS lookup failed", "dns_failed");
    }
    if (answers.length === 0) {
      throw new MediaTargetRefusedError("DNS lookup returned nothing", "dns_failed");
    }
    addresses = answers.map(({ address }) => address);
  }
  for (const address of addresses) {
    if (!isAllowed(address)) {
      throw new MediaTargetRefusedError(
        "address is not an allowed media target",
        "blocked_address",
      );
    }
  }
  return addresses.map((address) => ({
    address,
    family: isIP(address) === 6 ? 6 : 4,
  }));
}

/**
 * Vet `host:port` for media playback under the public-media rule
 * (`isPublicMediaAddress`, with the legacy WEBHOOK_ALLOW_PRIVATE hatch
 * read per call).
 */
export async function resolvePublicMediaTarget(
  host: string,
  port: number,
  { lookup = dnsLookup as Lookup }: ResolveMediaTargetOptions = {},
): Promise<PinnedAddress[]> {
  const allowPrivate = legacyAllowPrivate();
  return resolveVetted(
    host,
    port,
    (address) => isPublicMediaAddress(address, { allowPrivate }),
    lookup,
  );
}

/**
 * Vet `host:port` under the plugin-target rule; loopback is allowed
 * unless NODE_ENV=production (read per call, as the bot does).
 */
export async function resolvePluginTarget(
  host: string,
  port: number,
  { lookup = dnsLookup as Lookup }: ResolveMediaTargetOptions = {},
): Promise<PinnedAddress[]> {
  const allowLoopback = process.env.NODE_ENV !== "production";
  return resolveVetted(
    host,
    port,
    (address) => isPluginTargetAddress(address, { allowLoopback }),
    lookup,
  );
}

/** A media proxy policy: vet `host:port`, return the addresses to pin. */
export type MediaPolicy = (host: string, port: number) => Promise<PinnedAddress[]>;

/**
 * The policy for one play. Without `trustedOrigin` it is the public-media
 * rule. With it — the origin of the plugin that asked to play its own
 * URL, which the bot vetted with `assertPluginTarget` — requests to
 * exactly that host and port get the plugin-target rule; everything
 * else (a redirect away, another host in a playlist) is still a public
 * media URL. A malformed origin trusts nothing.
 */
export function mediaPolicyFor(trustedOrigin?: string): MediaPolicy {
  let trusted: { host: string; port: number } | null = null;
  if (trustedOrigin) {
    try {
      const u = new URL(trustedOrigin);
      if (u.protocol === "http:" || u.protocol === "https:") {
        trusted = {
          host: normalizeHostname(stripIPv6Brackets(u.hostname)),
          port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
        };
      }
    } catch {
      trusted = null;
    }
  }
  return (host, port) =>
    trusted &&
    normalizeHostname(stripIPv6Brackets(host)) === trusted.host &&
    port === trusted.port
      ? resolvePluginTarget(host, port)
      : resolvePublicMediaTarget(host, port);
}
