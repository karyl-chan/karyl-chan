import { lookup } from "dns/promises";
import { isIP } from "net";
import { moduleLogger } from "../logger.js";
import type { PinnedAddress } from "./pinned-dispatcher.js";
import {
  classifyAddress,
  transitionEmbeddedIPv4,
  type AddressClass,
} from "./ip-address.js";
import {
  allowlistMatches,
  normalizeHostname,
  type AllowlistEntry,
} from "./webhook-allowlist.js";

const log = moduleLogger("host-policy");

/**
 * Machine-readable refusal reason. `blocked` is the generic code of the
 * plugin / RCON / external policies; the webhook policy
 * (`resolveWebhookTarget`) uses the specific ones so the admin UI can
 * say why and what to change.
 */
export type HostPolicyCode =
  | "blocked"
  | "invalid_url"
  | "invalid_scheme"
  | "invalid_host"
  | "invalid_port"
  | "dns_failed"
  | "blocked_metadata"
  | "blocked_loopback"
  | "blocked_reserved"
  | "private_not_allowlisted"
  | "https_required";

export class HostPolicyError extends Error {
  constructor(
    message: string,
    public readonly code: HostPolicyCode = "blocked",
  ) {
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
 * How a policy turns a refusal into an error. The webhook policy keeps
 * the specific `code`; the boolean policies (RCON / plugin / external)
 * have always thrown the generic `blocked` code.
 */
type Refuse = (code: HostPolicyCode, message: string) => HostPolicyError;
const refuseCoded: Refuse = (code, message) => new HostPolicyError(message, code);
const refuseGeneric: Refuse = (_code, message) => new HostPolicyError(message);

/**
 * Normalise + validate a host and port and refuse the metadata
 * hostnames (worded per policy by `blockedHostMessage`). Returns the
 * bracket-stripped host.
 */
function vetHost(
  rawHost: string,
  port: number,
  refuse: Refuse,
  blockedHostMessage: (host: string) => string,
): string {
  const host = stripIPv6Brackets(rawHost);
  if (!isValidHostnameFormat(host)) {
    throw refuse("invalid_host", "無效的主機名稱");
  }
  if (!isValidPort(port)) {
    throw refuse("invalid_port", "無效的端口號碼");
  }
  if (BLOCKED_HOSTNAMES.has(normalizeHostname(host))) {
    throw refuse("blocked_metadata", blockedHostMessage(host));
  }
  return host;
}

/**
 * Every address a vetted host stands for: the literal itself, or every
 * DNS answer (resolved once). A failed lookup — or one with no answers,
 * which would otherwise pass every per-address check vacuously — is
 * refused as `dns_failed` with `dnsFailedMessage`.
 */
async function hostAddresses(
  host: string,
  refuse: Refuse,
  dnsFailedMessage: string,
): Promise<string[]> {
  if (isIP(host) !== 0) return [host];
  let answers: Array<{ address: string }>;
  try {
    answers = await lookup(host, { all: true });
  } catch (error) {
    log.error({ err: error, host }, "DNS lookup failed");
    throw refuse("dns_failed", dnsFailedMessage);
  }
  if (answers.length === 0) throw refuse("dns_failed", dnsFailedMessage);
  return answers.map(({ address }) => address);
}

/**
 * Shared skeleton of the boolean policies: vet the host, then refuse if
 * any address it stands for `isDenied`.
 *
 * Does not defend against DNS rebinding between this check and the
 * caller's own connect — `resolveWebhookTarget` returns the checked
 * addresses so its caller can pin them.
 */
async function checkHost(
  rawHost: string,
  port: number,
  isDenied: (address: string) => boolean,
  denyMessage: string,
): Promise<void> {
  const host = vetHost(rawHost, port, refuseGeneric, () => denyMessage);
  const addresses = await hostAddresses(host, refuseGeneric, "無法解析主機名稱");
  for (const address of addresses) {
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

// ── behavior webhook policy ──────────────────────────────────────────────────

/** Where the operator edits the allowlist — quoted in every refusal. */
const ALLOWLIST_SETTING =
  "環境變數 WEBHOOK_PRIVATE_ALLOWLIST（目前值見 系統設定 → 行為模組；修改後需重啟）";

/** A webhook target that passed the policy, with the addresses it was checked at. */
export interface WebhookTarget {
  url: URL;
  /**
   * Every DNS answer that passed, in resolver order (never empty).
   * Connect only to these (DNS-rebinding guard) — see pinned-dispatcher.
   */
  addresses: PinnedAddress[];
}

/** True when the legacy WEBHOOK_ALLOW_PRIVATE dev hatch is on. */
function legacyAllowPrivate(): boolean {
  // Per-call env read, same rationale as assertExternalTarget.
  return process.env.WEBHOOK_ALLOW_PRIVATE === "true";
}

/**
 * Boot-time nudge: the legacy hatch opens every private address to every
 * behavior webhook. Still honoured (the e2e harness and the local dev
 * launcher use it) but production should list targets explicitly.
 */
export function warnIfLegacyWebhookAllowPrivate(): void {
  if (legacyAllowPrivate() && process.env.NODE_ENV === "production") {
    log.warn(
      "WEBHOOK_ALLOW_PRIVATE=true is deprecated: it lets behavior webhooks reach every private address. List the LAN targets in WEBHOOK_PRIVATE_ALLOWLIST instead.",
    );
  }
}

function describeTarget(host: string, address: string): string {
  return host === address ? address : `${host}（${address}）`;
}

/**
 * Policy verdict for one resolved address of a webhook target. Returns
 * the refusal, or `{ public }` telling the caller whether this address
 * needs https.
 */
function judgeWebhookAddress(
  host: string,
  address: string,
  allowlist: readonly AllowlistEntry[],
): HostPolicyError | { public: boolean } {
  const target = describeTarget(host, address);
  switch (classOf(address)) {
    case "public":
      return { public: true };
    case "private":
      if (legacyAllowPrivate() || allowlistMatches(allowlist, host, address)) {
        return { public: false };
      }
      return new HostPolicyError(
        `目標 ${target} 是區網位址，不在允許清單；如需呼叫區網服務，請把主機或網段加入 ${ALLOWLIST_SETTING}`,
        "private_not_allowlisted",
      );
    case "loopback":
      return new HostPolicyError(
        `目標 ${target} 是本機 loopback 位址，一律禁止（無法加入允許清單）`,
        "blocked_loopback",
      );
    case "linkLocal":
    case "metadata":
      return new HostPolicyError(
        `目標 ${target} 是雲端 metadata / link-local 位址，一律禁止（無法加入允許清單）`,
        "blocked_metadata",
      );
    case "unspecified":
    case "reserved":
    case "transition":
      return new HostPolicyError(
        `目標 ${target} 是保留、不可路由或 IPv6 轉換位址段，一律禁止`,
        "blocked_reserved",
      );
  }
}

/**
 * resolveWebhookTarget — behavior webhook URLs (admin-configured; the bot
 * POSTs to them). Validates the URL, resolves the host ONCE, judges every
 * answer, and returns the addresses to connect to.
 *
 *   - public addresses pass, but only over https;
 *   - private addresses (RFC1918 / shared 100.64/10 / ULA) pass — over
 *     http too — only when the hostname or the address is on the
 *     operator's WEBHOOK_PRIVATE_ALLOWLIST (or the legacy
 *     WEBHOOK_ALLOW_PRIVATE hatch is on);
 *   - loopback, cloud metadata / link-local, unspecified, reserved and
 *     NAT64 / 6to4 addresses never pass, allowlisted or not.
 *
 * Every refusal is a HostPolicyError with a specific `code` and a
 * message that names the target and, where it helps, the setting.
 */
export async function resolveWebhookTarget(
  rawUrl: string | URL,
  allowlist: readonly AllowlistEntry[],
): Promise<WebhookTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HostPolicyError("無效的 URL 格式", "invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HostPolicyError("Webhook URL 必須使用 http 或 https", "invalid_scheme");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const host = vetHost(
    url.hostname,
    port,
    refuseCoded,
    (h) => `目標 ${h} 是雲端 metadata 端點，一律禁止（無法加入允許清單）`,
  );
  const addresses = await hostAddresses(
    host,
    refuseCoded,
    `無法解析主機名稱 ${host}`,
  );

  let needsHttps = false;
  for (const address of addresses) {
    const verdict = judgeWebhookAddress(host, address, allowlist);
    if (verdict instanceof HostPolicyError) throw verdict;
    if (verdict.public) needsHttps = true;
  }
  if (needsHttps && url.protocol !== "https:") {
    throw new HostPolicyError(
      `目標 ${host} 是公網位址，webhook 必須使用 https（只有 ${ALLOWLIST_SETTING} 內的區網目標可以用 http）`,
      "https_required",
    );
  }

  return {
    url,
    addresses: addresses.map((address) => ({
      address,
      family: isIP(address) === 6 ? 6 : 4,
    })),
  };
}
