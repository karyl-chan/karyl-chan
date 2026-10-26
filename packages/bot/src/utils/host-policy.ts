import { lookup } from "dns/promises";
import { isIP } from "net";
import { moduleLogger } from "../logger.js";
import {
  classifyAddress,
  transitionEmbeddedIPv4,
  type AddressClass,
} from "./ip-address.js";

const log = moduleLogger("host-policy");

export class HostPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostPolicyError";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata",
  "metadata.goog",
  "metadata.azure.com",
]);

/**
 * Classes no policy ever lets through: link-local (169.254/16, fe80::/10
 * — where most cloud metadata lives) and the known metadata endpoints
 * outside it.
 */
const NEVER_REACHABLE: ReadonlySet<AddressClass> = new Set([
  "linkLocal",
  "metadata",
]);

/**
 * URL.hostname returns IPv6 literals wrapped in `[...]`; strip them so
 * the rest of host-policy can treat the address uniformly.
 */
function stripIPv6Brackets(host: string): string {
  if (host.length >= 2 && host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

function isValidHostnameFormat(host: string): boolean {
  return (
    /^[a-zA-Z0-9]([a-zA-Z0-9\-\.]*[a-zA-Z0-9])?$/.test(host) || isIP(host) !== 0
  );
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

/**
 * Classify `ip`; a non-literal (should not happen — DNS answers and
 * isIP-checked hosts only) is treated as public, mirroring the old
 * per-range checks that let unrecognised strings fall through.
 */
function classOf(ip: string): AddressClass {
  return classifyAddress(ip) ?? "public";
}

/**
 * For a transition-class address (NAT64 / 6to4), the class of the IPv4
 * it embeds; null when the embedding cannot be decoded.
 */
function embeddedClass(ip: string): AddressClass | null {
  const v4 = transitionEmbeddedIPv4(ip);
  return v4 ? classOf(v4) : null;
}

/**
 * Shared host-check skeleton: normalise + validate the host and port,
 * refuse the metadata hostnames, then hand every address the host
 * stands for (the literal itself, or every DNS answer) to `isDenied`.
 * Any non-HostPolicyError DNS failure becomes a HostPolicyError.
 *
 * Does not defend against DNS rebinding between this check and the
 * caller's own connect — see the webhook path for the pinned variant.
 */
async function checkHost(
  rawHost: string,
  port: number,
  isDenied: (address: string) => boolean,
  denyMessage: string,
): Promise<void> {
  const host = stripIPv6Brackets(rawHost);
  if (!isValidHostnameFormat(host)) {
    throw new HostPolicyError("無效的主機名稱");
  }
  if (!isValidPort(port)) {
    throw new HostPolicyError("無效的端口號碼");
  }
  if (BLOCKED_HOSTNAMES.has(host.toLowerCase().replace(/\.$/, ""))) {
    throw new HostPolicyError(denyMessage);
  }

  if (isIP(host) !== 0) {
    if (isDenied(host)) throw new HostPolicyError(denyMessage);
    return;
  }

  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await lookup(host, { all: true });
  } catch (error) {
    log.error({ err: error, host }, "DNS lookup failed");
    throw new HostPolicyError("無法解析主機名稱");
  }
  for (const { address } of resolved) {
    if (isDenied(address)) throw new HostPolicyError(denyMessage);
  }
}

/**
 * assertAllowedTarget — RCON / internal use.
 *
 * Blocks cloud metadata endpoints only (link-local 169.254/16 and
 * fe80::/10, Azure WireServer, Alibaba, Oracle, AWS IPv6 IMDS — also
 * when smuggled through an IPv4-mapped / NAT64 / 6to4 spelling). Does
 * NOT block RFC1918 or loopback — docker-internal services legitimately
 * live in those ranges.
 */
export async function assertAllowedTarget(
  host: string,
  port: number,
): Promise<void> {
  await checkHost(
    host,
    port,
    (address) => {
      const cls = classOf(address);
      if (NEVER_REACHABLE.has(cls)) return true;
      if (cls === "transition") {
        const inner = embeddedClass(address);
        return inner !== null && NEVER_REACHABLE.has(inner);
      }
      return false;
    },
    "主機目標不被允許",
  );
}

/**
 * assertExternalTarget — strict public-internet-only policy (arbitrary
 * user-supplied URLs, e.g. voice media URLs).
 *
 * Only `public` addresses pass: cloud metadata, link-local, loopback,
 * unspecified, RFC1918 / shared / ULA, non-routable ranges (0/8,
 * 198.18/15, 224/4, 240/4, fec0::/10, multicast, ::/96) and the NAT64 /
 * 6to4 transition prefixes are all refused.
 *
 * Escape hatch: set env WEBHOOK_ALLOW_PRIVATE=true to let `private`
 * addresses through (everything else is still blocked). Intended for
 * ops debugging only — never enable in production.
 */
export async function assertExternalTarget(
  host: string,
  port: number,
): Promise<void> {
  // Read directly from process.env so tests can flip the escape
  // hatch per-case without re-importing the frozen `config` module.
  // Bot operators set this once at deploy time; the boot-frozen value
  // and the runtime read are observationally equivalent in prod.
  const allowPrivate = process.env.WEBHOOK_ALLOW_PRIVATE === "true";
  await checkHost(
    host,
    port,
    (address) => {
      const cls = classOf(address);
      if (cls === "public") return false;
      if (cls === "private") return !allowPrivate;
      return true;
    },
    "Webhook 目標不被允許",
  );
}

/**
 * assertPluginTarget — Plugin manifest URLs (docker-compose internal services).
 *
 * Blocks cloud metadata / link-local (same as assertAllowedTarget),
 * unspecified, and the clearly non-routable ranges (0/8, 198.18/15,
 * 224/4, 240/4, fec0::/10, multicast, ::/96). Allows RFC1918 / ULA
 * because docker bridge networks legitimately use 172.16-31.x.x.
 * NAT64 / 6to4 addresses are judged by the IPv4 they embed (an
 * undecodable embedding is refused).
 *
 * In production (NODE_ENV=production), additionally blocks loopback
 * (127.x.x.x / ::1) to prevent a manifest from self-referencing the
 * host process. In development loopback is allowed for local plugin testing.
 */
export async function assertPluginTarget(
  host: string,
  port: number,
): Promise<void> {
  // Same per-call read rationale as `allowPrivate` above — tests
  // toggle NODE_ENV per-case to assert the prod vs dev branch.
  const isProd = process.env.NODE_ENV === "production";
  const deniedClass = (cls: AddressClass): boolean => {
    if (cls === "public" || cls === "private") return false;
    if (cls === "loopback") return isProd;
    return true; // linkLocal, metadata, unspecified, reserved
  };
  await checkHost(
    host,
    port,
    (address) => {
      const cls = classOf(address);
      if (cls === "transition") {
        const inner = embeddedClass(address);
        return inner === null || deniedClass(inner);
      }
      return deniedClass(cls);
    },
    "Plugin 目標不被允許",
  );
}
