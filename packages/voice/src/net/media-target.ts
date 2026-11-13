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
 * (`mediaPolicyFor`). The host / port / DNS gate in front of both
 * rules is `host-vetting.ts`, shared with every bot policy.
 *
 * No imports beyond node built-ins: it is reachable from the bot's
 * config chain through the side-effect-free `@karyl-chan/voice/net`
 * subpath.
 */

import {
  classifyAddress,
  transitionEmbeddedIPv4,
  type AddressClass,
} from "./ip-address.js";
import {
  effectivePort,
  MEDIA_LOOKUP_SLOTS,
  normalizeHostname,
  resolveVettedHost,
  stripIPv6Brackets,
  type HostLookup,
} from "./host-vetting.js";
import type { PinnedAddress } from "./pinned-lookup.js";

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

export interface ResolveMediaTargetOptions {
  /** DNS resolver (test seam). Defaults to `dns.promises.lookup`. */
  lookup?: HostLookup;
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
 * Vet `host:port` for media playback — resolve once, refuse
 * (TargetRefusedError) unless every address passes, return them all to
 * pin to — under the public-media rule
 * (`isPublicMediaAddress`, with the legacy WEBHOOK_ALLOW_PRIVATE hatch
 * read per call). Its lookup takes one of the media lookup slots: a
 * playlist can name any number of hosts.
 */
export async function resolvePublicMediaTarget(
  host: string,
  port: number,
  { lookup }: ResolveMediaTargetOptions = {},
): Promise<PinnedAddress[]> {
  const allowPrivate = legacyAllowPrivate();
  return resolveVettedHost(
    host,
    port,
    (address) => isPublicMediaAddress(address, { allowPrivate }),
    MEDIA_LOOKUP_SLOTS.guard(lookup),
  );
}

/**
 * Vet `host:port` under the plugin-target rule; loopback is allowed
 * unless NODE_ENV=production (read per call, as the bot does).
 */
export async function resolvePluginTarget(
  host: string,
  port: number,
  { lookup }: ResolveMediaTargetOptions = {},
): Promise<PinnedAddress[]> {
  const allowLoopback = process.env.NODE_ENV !== "production";
  return resolveVettedHost(
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
          port: effectivePort(u),
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
