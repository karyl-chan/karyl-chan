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
 * A cap on how many lookups a group of callers may have running at once
 * (#260). Sharing a running lookup only helps while the hostnames are
 * few; a group whose hostnames anyone can vary (media URLs, the names a
 * playlist lists) would otherwise start one lookup per name, each holding
 * a libuv threadpool worker while DNS hangs. A lookup that finds no free
 * slot is refused rather than queued, so nothing piles up behind a hang.
 */
export class LookupSlots {
  private running = 0;

  constructor(readonly max: number) {}

  /** Take a slot, or false when all `max` are in use. */
  tryTake(): boolean {
    if (this.running >= this.max) return false;
    this.running++;
    return true;
  }

  release(): void {
    this.running--;
  }
}

/** The `cause` of a `dns_failed` refusal whose lookup found no free slot. */
export class LookupSlotsFullError extends Error {
  constructor(readonly max: number) {
    super(`too many lookups running (at most ${max})`);
    this.name = "LookupSlotsFullError";
  }
}

/**
 * The slots of media-URL lookups, one set per process: the bot's
 * up-front media check and the voice media proxy share them. Two is half
 * the default threadpool (UV_THREADPOOL_SIZE 4), which also serves file
 * I/O, crypto and every other lookup.
 */
export const MEDIA_LOOKUP_SLOTS = new LookupSlots(2);

type Answers = Array<{ address: string }>;

/** Lookups still running, per resolver, by normalized host. */
const lookupsInFlight = new WeakMap<HostLookup, Map<string, Promise<Answers>>>();

/**
 * `lookup(host)`, shared while it runs (#260): a caller for the same host
 * waits on the running lookup instead of starting another, whatever slots
 * either one came with. dns.lookup cannot be aborted and holds a
 * threadpool worker until the OS gives up, so with DNS hanging one lookup
 * per call would take the whole pool. Once it settles the next call
 * resolves afresh, so an answer is never reused.
 */
function sharedLookup(
  host: string,
  lookup: HostLookup,
  slots: LookupSlots | undefined,
): Promise<Answers> {
  let running = lookupsInFlight.get(lookup);
  if (!running) {
    running = new Map();
    lookupsInFlight.set(lookup, running);
  }
  const key = normalizeHostname(host);
  const inFlight = running.get(key);
  if (inFlight) return inFlight;
  if (slots && !slots.tryTake()) {
    return Promise.reject(new LookupSlotsFullError(slots.max));
  }
  let lookingUp: Promise<Answers>;
  try {
    lookingUp = lookup(host, { all: true });
  } catch (err) {
    slots?.release();
    return Promise.reject(err);
  }
  running.set(key, lookingUp);
  // Two-armed so the cleanup's own promise never rejects.
  const forget = () => {
    if (running.get(key) === lookingUp) running.delete(key);
    slots?.release();
  };
  lookingUp.then(forget, forget);
  return lookingUp;
}

/**
 * Every address a vetted host stands for: the literal itself, or every
 * DNS answer (resolved once, resolver order). A failed lookup (the error
 * is the `cause`) or an empty answer is refused as `dns_failed`. The
 * lookup is shared with concurrent callers for the same host; with
 * `slots`, starting one needs a free slot (else `dns_failed`, cause
 * LookupSlotsFullError).
 */
export async function lookupHostAddresses(
  host: string,
  lookup: HostLookup = dnsLookup as HostLookup,
  slots?: LookupSlots,
): Promise<string[]> {
  if (isIP(host) !== 0) return [host];
  let answers: Answers;
  try {
    answers = await sharedLookup(host, lookup, slots);
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
  slots?: LookupSlots,
): Promise<PinnedAddress[]> {
  const host = vetHostAndPort(rawHost, port);
  const addresses = await lookupHostAddresses(host, lookup, slots);
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
