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
 * No imports beyond node built-ins: it is reachable from the bot's
 * config chain through the side-effect-free `@karyl-chan/voice/net`
 * subpath.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { classifyAddress } from "./ip-address.js";
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
 * Vet `host:port` for media playback: resolve the host ONCE and return
 * every address it stands for (never empty, resolver order) — connect
 * only to these. Refuses (MediaTargetRefusedError) a malformed host or
 * port, a metadata hostname, a failed / empty lookup, and a host with
 * ANY answer that is not a public media address.
 */
export async function resolvePublicMediaTarget(
  rawHost: string,
  port: number,
  { lookup = dnsLookup as Lookup }: ResolveMediaTargetOptions = {},
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
  const allowPrivate = legacyAllowPrivate();
  for (const address of addresses) {
    if (!isPublicMediaAddress(address, { allowPrivate })) {
      throw new MediaTargetRefusedError(
        "address is not a public media target",
        "blocked_address",
      );
    }
  }
  return addresses.map((address) => ({
    address,
    family: isIP(address) === 6 ? 6 : 4,
  }));
}
