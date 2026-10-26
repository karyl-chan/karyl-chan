/**
 * webhook-allowlist — WEBHOOK_PRIVATE_ALLOWLIST 的解析與比對。
 *
 * 項目是主機名稱（完全比對，不含結尾點、不支援萬用字元）、單一 IP 或
 * CIDR。這裡只回答「目標是否在清單內」；哪些位址類別可以被清單放行
 * （只有 private）是 host-policy 的事。No logger / config imports so
 * config.ts can parse the list at boot.
 */

import { addressBytes, normalizeIpLiteral } from "./ip-address.js";

export type AllowlistEntry =
  | { kind: "host"; host: string }
  | { kind: "cidr"; bytes: number[]; prefix: number };

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9\-.]*[a-z0-9])?$/;

/** Lower-case and drop the FQDN trailing dot, so `NAS.lan.` == `nas.lan`. */
export function normalizeHostname(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Parse allowlist entries — a hostname (exact match), a bare IP, or a
 * CIDR (`192.168.0.0/16`, `fd12::/16`). Throws on the first malformed
 * entry, naming the env var, so a typo fails at boot rather than
 * silently allowing nothing.
 */
export function parseAllowlistEntries(
  entries: readonly string[],
): AllowlistEntry[] {
  return entries.map((raw) => {
    const entry = raw.trim();
    const fail = (): never => {
      throw new Error(
        `Config error: WEBHOOK_PRIVATE_ALLOWLIST entry "${raw}" is not a hostname, IP or CIDR`,
      );
    };
    const slash = entry.indexOf("/");
    const addrPart = slash === -1 ? entry : entry.slice(0, slash);
    const bytes = addressBytes(addrPart);
    if (bytes) {
      const max = bytes.length * 8;
      let prefix = max;
      if (slash !== -1) {
        const p = entry.slice(slash + 1);
        if (!/^\d{1,3}$/.test(p)) fail();
        prefix = Number(p);
        if (prefix > max) fail();
      }
      return { kind: "cidr", bytes, prefix };
    }
    if (slash !== -1) fail();
    const host = normalizeHostname(entry);
    if (!HOSTNAME_RE.test(host)) fail();
    return { kind: "host", host };
  });
}

function inCidr(bytes: number[], cidr: { bytes: number[]; prefix: number }): boolean {
  if (bytes.length !== cidr.bytes.length) return false;
  let bits = cidr.prefix;
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((bytes[i] & mask) !== (cidr.bytes[i] & mask)) return false;
  }
  return true;
}

/**
 * True when the target is allowlisted: its (normalised) hostname is
 * listed, or `address` falls inside a listed IP / CIDR. Whether the
 * address's class may be allowlisted at all is the caller's decision.
 */
export function allowlistMatches(
  entries: readonly AllowlistEntry[],
  host: string,
  address: string,
): boolean {
  const h = normalizeHostname(normalizeIpLiteral(host));
  const bytes = addressBytes(address);
  return entries.some((e) =>
    e.kind === "host" ? e.host === h : bytes !== null && inCidr(bytes, e),
  );
}
