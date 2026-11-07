/**
 * host-vetting — the gate every host policy runs before judging addresses
 * (bot host-policy and the voice media proxy alike, #158).
 *
 *   1. `vetHostAndPort`: bracket-strip, hostname / IP-literal syntax, port
 *      range, metadata hostnames (refused by name, whatever they resolve to);
 *   2. `lookupHostAddresses`: the literal itself, or every DNS answer —
 *      resolved ONCE; a failed or empty lookup is refused (an empty answer
 *      would otherwise pass every per-address check vacuously);
 *   3. `toPinnedAddresses`: the vetted literals in the shape the
 *      connecting side pins to.
 *
 * `resolveVettedHost` chains them with a per-address rule. Refusals are a
 * typed `TargetRefusedError` with a `reason`; each caller maps it to its
 * own wording (the bot keeps its HostPolicyError codes and messages).
 *
 * Node built-ins only (side-effect-free `@karyl-chan/voice/net`).
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
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

/**
 * URL.hostname returns IPv6 literals wrapped in `[...]`; strip them so a
 * policy can treat the address uniformly.
 */
export function stripIPv6Brackets(host: string): string {
  return host.length >= 2 && host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
}

export type TargetRefusalReason =
  | "invalid_host"
  | "invalid_port"
  | "blocked_metadata"
  | "dns_failed"
  | "blocked_address";

/** A target the gate (or a policy's address rule) refused. */
export class TargetRefusedError extends Error {
  constructor(
    public readonly reason: TargetRefusalReason,
    /** The bracket-stripped host that was being vetted. */
    public readonly host: string,
    options?: { cause?: unknown },
  ) {
    super(`target refused: ${reason}`, options);
    this.name = "TargetRefusedError";
  }
}

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-.]*[a-zA-Z0-9])?$/;

/**
 * Syntax and metadata-name gate. Returns the bracket-stripped host;
 * throws TargetRefusedError (`invalid_host`, `invalid_port`,
 * `blocked_metadata`).
 */
export function vetHostAndPort(rawHost: string, port: number): string {
  const host = stripIPv6Brackets(rawHost);
  if (!(HOSTNAME_RE.test(host) || isIP(host) !== 0)) {
    throw new TargetRefusedError("invalid_host", host);
  }
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new TargetRefusedError("invalid_port", host);
  }
  if (METADATA_HOSTNAMES.has(normalizeHostname(host))) {
    throw new TargetRefusedError("blocked_metadata", host);
  }
  return host;
}

export type HostLookup = (
  host: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

/**
 * Every address a vetted host stands for: the literal itself, or every
 * DNS answer (resolved once, resolver order). A failed lookup (the error
 * is the `cause`) or an empty answer is refused as `dns_failed`.
 */
export async function lookupHostAddresses(
  host: string,
  lookup: HostLookup = dnsLookup as HostLookup,
): Promise<string[]> {
  if (isIP(host) !== 0) return [host];
  let answers: Array<{ address: string }>;
  try {
    answers = await lookup(host, { all: true });
  } catch (cause) {
    throw new TargetRefusedError("dns_failed", host, { cause });
  }
  if (answers.length === 0) throw new TargetRefusedError("dns_failed", host);
  return answers.map(({ address }) => address);
}

/** Vetted address literals in the shape the connecting side pins to. */
export function toPinnedAddresses(addresses: readonly string[]): PinnedAddress[] {
  return addresses.map((address) => ({
    address,
    family: isIP(address) === 6 ? 6 : 4,
  }));
}

/**
 * The whole gate plus a per-address rule: refuse (`blocked_address`) a
 * host with ANY address `isAllowed` rejects, else return every address
 * (never empty) to pin to.
 */
export async function resolveVettedHost(
  rawHost: string,
  port: number,
  isAllowed: (address: string) => boolean,
  lookup?: HostLookup,
): Promise<PinnedAddress[]> {
  const host = vetHostAndPort(rawHost, port);
  const addresses = await lookupHostAddresses(host, lookup);
  for (const address of addresses) {
    if (!isAllowed(address)) throw new TargetRefusedError("blocked_address", host);
  }
  return toPinnedAddresses(addresses);
}

/** The default port of an http(s) scheme (`https:` → 443, else 80). */
export function defaultPortFor(protocol: string): 443 | 80 {
  return protocol === "https:" ? 443 : 80;
}

/** A URL's effective port: the explicit one, else its scheme's default. */
export function effectivePort(url: URL): number {
  return url.port ? Number(url.port) : defaultPortFor(url.protocol);
}
