import { lookup } from "dns/promises";
import { moduleLogger } from "../logger.js";
import type { PinnedAddress } from "./pinned-dispatcher.js";
import {
  addressBytes,
  classifyAddress,
  classifyBytes,
  KNOWN_METADATA_ADDRESSES,
  transitionEmbeddedIPv4,
  type AddressClass,
} from "./ip-address.js";
import {
  effectivePort,
  isPluginTargetAddress,
  isPublicMediaAddress,
  legacyAllowPrivate,
  lookupHostAddresses,
  LookupSlotsFullError,
  MEDIA_LOOKUP_SLOTS,
  METADATA_HOSTNAMES,
  resolveVettedHost,
  TargetRefusedError,
  toPinnedAddresses,
  vetHostAndPort,
  type HostLookup,
} from "@karyl-chan/voice/net";
import {
  allowlistMatches,
  cidrBounds,
  cidrContains,
  normalizeHostname,
  type AllowlistEntry,
} from "./webhook-allowlist.js";

const log = moduleLogger("host-policy");

const dnsLookup = lookup as HostLookup;

/**
 * Machine-readable refusal reason. `blocked` is the generic code of the
 * plugin / RCON / public-media policies; the webhook policy
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
 * the specific `code`; the boolean policies (RCON / plugin / public-media)
 * have always thrown the generic `blocked` code.
 */
type Refuse = (code: HostPolicyCode, message: string) => HostPolicyError;
const refuseCoded: Refuse = (code, message) => new HostPolicyError(message, code);
const refuseGeneric: Refuse = (_code, message) => new HostPolicyError(message);

/** How one policy words the shared gate's refusals. */
interface GateWording {
  refuse: Refuse;
  blockedHost: (host: string) => string;
  dnsFailed: (host: string) => string;
}

/**
 * Turn a refusal of the shared host gate (`resolveVettedHost` and its
 * steps in @karyl-chan/voice/net, also what the voice media proxy runs)
 * into this policy's HostPolicyError. Anything else is rethrown untouched.
 */
function gateRefusal(err: unknown, wording: GateWording): unknown {
  if (!(err instanceof TargetRefusedError)) return err;
  switch (err.reason) {
    case "invalid_host":
      return wording.refuse("invalid_host", "無效的主機名稱");
    case "invalid_port":
      return wording.refuse("invalid_port", "無效的端口號碼");
    case "blocked_metadata":
      return wording.refuse("blocked_metadata", wording.blockedHost(err.host));
    case "dns_failed":
      if (err.cause instanceof LookupSlotsFullError) {
        log.warn({ host: err.host, max: err.cause.max }, "DNS lookup refused: no free lookup slot");
      } else if (err.cause !== undefined) {
        log.error({ err: err.cause, host: err.host }, "DNS lookup failed");
      }
      return wording.refuse("dns_failed", wording.dnsFailed(err.host));
    case "blocked_address":
      // Only the boolean policies hand the gate an address rule
      // (checkHost); their blockedHost is the policy's deny message.
      return wording.refuse("blocked", wording.blockedHost(err.host));
  }
}

/**
 * Validate a host and port and refuse the metadata hostnames (shared
 * gate). Returns the bracket-stripped host.
 */
function vetHost(rawHost: string, port: number, wording: GateWording): string {
  try {
    return vetHostAndPort(rawHost, port);
  } catch (err) {
    throw gateRefusal(err, wording);
  }
}

/**
 * Every address a vetted host stands for: the literal itself, or every
 * DNS answer (resolved once). A failed or empty lookup is refused as
 * `dns_failed` (shared gate). The lookup is shared with every concurrent
 * check of the same host (#260).
 */
async function hostAddresses(
  host: string,
  wording: GateWording,
): Promise<string[]> {
  try {
    return await lookupHostAddresses(host, dnsLookup);
  } catch (err) {
    throw gateRefusal(err, wording);
  }
}

/**
 * The boolean policies (RCON / plugin / public-media): the shared gate
 * (`resolveVettedHost`) with this policy's address rule, refusing the
 * whole host if ANY address it stands for is not `isAllowed`. Every
 * refusal is a `blocked` HostPolicyError; it reads `denyMessage`, except
 * that an invalid host / port and a failed lookup keep their own
 * messages. Returns the vetted addresses. The lookup defaults to the
 * bot's own `dns/promises` import, the one tests mock.
 *
 * Pinning — connecting only to those addresses, so DNS rebinding between
 * this check and the connect cannot redirect it — is the caller's job:
 *   - pinned: RCON (`resolveAllowedTarget`) and behavior webhooks
 *     (`resolveWebhookTarget`, its own skeleton);
 *   - deliberately not pinned (#144): plugin targets, whose connect
 *     re-resolves the host — see `assertPluginTarget` for why;
 *   - voice media: this check is only the up-front, user-facing one;
 *     the voice media proxy re-vets and pins every request ffmpeg
 *     makes (#158) — see `assertPublicMediaTarget`.
 */
async function checkHost(
  rawHost: string,
  port: number,
  isAllowed: (address: string) => boolean,
  denyMessage: string,
  hostLookup: HostLookup = dnsLookup,
): Promise<PinnedAddress[]> {
  try {
    return await resolveVettedHost(rawHost, port, isAllowed, hostLookup);
  } catch (err) {
    throw gateRefusal(err, {
      refuse: refuseGeneric,
      blockedHost: () => denyMessage,
      dnsFailed: () => "無法解析主機名稱",
    });
  }
}

/**
 * resolveAllowedTarget — RCON / internal use. Resolves the host ONCE and
 * returns every address it was vetted at (never empty, resolver order);
 * connect only to these (DNS-rebinding guard).
 *
 * Blocks cloud metadata endpoints only (link-local 169.254/16 and
 * fe80::/10, Azure WireServer, Alibaba, Oracle, AWS IPv6 IMDS — also
 * when smuggled through an IPv4-mapped / NAT64 / 6to4 spelling). Does
 * NOT block RFC1918 or loopback — docker-internal services legitimately
 * live in those ranges. One blocked answer refuses the whole host.
 */
export async function resolveAllowedTarget(
  host: string,
  port: number,
): Promise<PinnedAddress[]> {
  return checkHost(
    host,
    port,
    (address) => {
      const cls = classOf(address);
      if (NEVER_REACHABLE.has(cls)) return false;
      if (cls === "transition") {
        // judged by the IPv4 it embeds; an undecodable one passes
        const inner = embeddedClass(address);
        return inner === null || !NEVER_REACHABLE.has(inner);
      }
      return true;
    },
    "主機目標不被允許",
  );
}

/**
 * `resolveAllowedTarget` as a yes / no check. Kept because #144 asked to
 * preserve this original signature; today only tests call it.
 */
export async function assertAllowedTarget(
  host: string,
  port: number,
): Promise<void> {
  await resolveAllowedTarget(host, port);
}

/**
 * assertPublicMediaTarget — strict public-internet-only policy for
 * arbitrary user / plugin-supplied media URLs (voice playback).
 *
 * Only `public` addresses pass: cloud metadata, link-local, loopback,
 * unspecified, RFC1918 / shared / ULA, non-routable ranges (0/8,
 * 198.18/15, 224/4, 240/4, fec0::/10, multicast, ::/96) and the NAT64 /
 * 6to4 transition prefixes are all refused. The rule is
 * `isPublicMediaAddress` in @karyl-chan/voice/net — the same one the
 * voice media proxy applies.
 *
 * Historical quirk kept as-is: the legacy WEBHOOK_ALLOW_PRIVATE=true dev
 * hatch also lets `private` addresses through here (everything else is
 * still blocked). Never enable it in production.
 *
 * This is the up-front check that gives the user a readable refusal. It
 * is not what keeps ffmpeg in bounds: ffmpeg fetches the URL itself (in
 * this process or the standalone voice service), follows redirects and
 * opens whatever an HLS playlist names. Since #158 every one of those
 * requests goes through the voice media proxy (`media-proxy.ts` in
 * @karyl-chan/voice), which re-runs this rule per request, pins the
 * vetted addresses and terminates TLS itself; ffmpeg's protocol
 * whitelist leaves it no other way out.
 */
export async function assertPublicMediaTarget(
  host: string,
  port: number,
): Promise<void> {
  // `legacyAllowPrivate` (@karyl-chan/voice/net) reads the
  // WEBHOOK_ALLOW_PRIVATE dev hatch from process.env per call, so tests can
  // flip it per case without re-importing the frozen `config` module;
  // operators set it once at deploy time, so the boot-frozen value and the
  // runtime read are observationally equivalent in prod.
  const allowPrivate = legacyAllowPrivate();
  await checkHost(
    host,
    port,
    (address) => isPublicMediaAddress(address, { allowPrivate }),
    "媒體 URL 目標不被允許",
    // a user-supplied URL can name any host; see MEDIA_LOOKUP_SLOTS
    MEDIA_LOOKUP_SLOTS.guard(dnsLookup),
  );
}

/**
 * `assertPublicMediaTarget` for a parsed http(s) media URL: vets its
 * host at the URL's port (explicit, else 443 / 80).
 *
 * Hand ffmpeg `url.href`, never the raw input string. The check runs on
 * the WHATWG parse, and ffmpeg parses the raw string its own way: it
 * splits the authority on `/?#` only, so `http://8.8.8.8\@127.0.0.1/`
 * vets 8.8.8.8 yet connects to 127.0.0.1 (#162). The normalized href
 * (`http://8.8.8.8/@127.0.0.1/`, inner tabs / newlines stripped) is the
 * URL that was vetted.
 */
export async function assertPublicMediaUrl(url: URL): Promise<void> {
  await assertPublicMediaTarget(url.hostname, effectivePort(url));
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
 *
 * Dispatch is not pinned, on purpose (#144): a plugin registers its own URL with a
 * per-plugin setup secret, and the host resolves through Docker's
 * internal DNS. Changing the answer between check and connect needs
 * control of that DNS, and an attacker who has it can impersonate the
 * plugin outright. Dispatch also runs on a keep-alive undici Pool:
 * rebinding reaches only new connections, and pinning would mean
 * rebuilding the Pool whenever the IP changes, which every container
 * restart does. If it is ever wanted, a Pool with `connect.lookup` (see
 * pinned-dispatcher) rebuilt when the vetted set changes is an additive
 * change.
 */
export async function assertPluginTarget(
  host: string,
  port: number,
): Promise<void> {
  await resolvePluginTarget(host, port);
}

/**
 * `assertPluginTarget` that also returns the addresses it vetted (never
 * empty, resolver order), for a one-shot request that pins them: files
 * downloaded from under the plugin's registered URL — a behavior action's
 * reply attachments (#203) and a plugin RPC's own attachments (#214).
 */
export async function resolvePluginTarget(
  host: string,
  port: number,
): Promise<PinnedAddress[]> {
  // Same per-call read rationale as `legacyAllowPrivate` — tests
  // toggle NODE_ENV per-case to assert the prod vs dev branch. The rule
  // is `isPluginTargetAddress` in @karyl-chan/voice/net, shared with the
  // voice media proxy (a plugin playing a URL on its own origin, #158).
  const allowLoopback = process.env.NODE_ENV !== "production";
  return checkHost(
    host,
    port,
    (address) => isPluginTargetAddress(address, { allowLoopback }),
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

/**
 * Allowlist entries that cannot do what the operator probably meant:
 * a metadata / loopback hostname (never applies), a CIDR / IP reaching
 * beyond private space (only its private part applies), or a private
 * range covering a metadata address (that address stays refused — the
 * warning names it). One readable warning per such entry, naming it.
 */
export function ineffectiveAllowlistEntries(
  entries: readonly AllowlistEntry[],
): string[] {
  const warnings: string[] = [];
  for (const e of entries) {
    const label = `WEBHOOK_PRIVATE_ALLOWLIST entry "${e.source}"`;
    if (e.kind === "host") {
      if (
        METADATA_HOSTNAMES.has(e.host) ||
        e.host === "localhost" ||
        e.host.endsWith(".localhost")
      ) {
        warnings.push(`${label} is a metadata / loopback hostname and never applies`);
      }
      continue;
    }
    const { first, last } = cidrBounds(e);
    if (classifyBytes(first) !== "private" || classifyBytes(last) !== "private") {
      warnings.push(
        `${label} reaches beyond private address space; loopback / metadata / reserved / public addresses in it stay refused — only its private addresses are allowlisted`,
      );
      continue;
    }
    const metadata = KNOWN_METADATA_ADDRESSES.filter((m) => {
      const b = addressBytes(m);
      return b !== null && cidrContains(e, b);
    });
    if (metadata.length > 0) {
      warnings.push(
        `${label} covers the cloud metadata address ${metadata.join(", ")}, which stays refused; the rest of it is allowlisted`,
      );
    }
  }
  return warnings;
}

/** Boot-time: log `ineffectiveAllowlistEntries` so a misconfiguration is visible. */
export function warnAboutIneffectiveAllowlistEntries(
  entries: readonly AllowlistEntry[],
): void {
  for (const warning of ineffectiveAllowlistEntries(entries)) log.warn(warning);
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
  const wording: GateWording = {
    refuse: refuseCoded,
    blockedHost: (h) => `目標 ${h} 是雲端 metadata 端點，一律禁止（無法加入允許清單）`,
    dnsFailed: (h) => `無法解析主機名稱 ${h}`,
  };
  const host = vetHost(url.hostname, effectivePort(url), wording);
  const addresses = await hostAddresses(host, wording);

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

  return { url, addresses: toPinnedAddresses(addresses) };
}
