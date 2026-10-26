/**
 * ip-address — 純函式的 IP 位址解析與分類（host-policy 的共用底層）。
 *
 * 位址一律先解析成 bytes 再按前綴分類，不靠字串 regex —— 同一個位址
 * 有很多種寫法（`::ffff:7f00:1`、`0:0:0:0:0:ffff:7f00:1`、zone id、
 * 方括號），字串比對容易漏網。
 *
 * 這裡只回答「這個位址屬於哪一類」，不決定放不放行；放行規則是
 * host-policy 各 policy 的事。No imports beyond `net`, so config.ts can
 * depend on it (through webhook-allowlist) without pulling in the logger.
 */

import { isIP } from "net";

export type AddressClass =
  /** 一般公網位址。 */
  | "public"
  /** RFC1918、RFC 6598 共享位址（CGNAT / Tailscale）、IPv6 ULA fc00::/7。 */
  | "private"
  /** 127/8、::1。 */
  | "loopback"
  /** 169.254/16、fe80::/10 —— 多數雲端 metadata 都在這段。 */
  | "linkLocal"
  /** 不在 link-local 段內的已知雲端 metadata 位址。 */
  | "metadata"
  /** 0.0.0.0、::。 */
  | "unspecified"
  /** 不可路由 / 保留段：0/8、198.18/15、224/4、240/4、ff00::/8、fec0::/10、::/96。 */
  | "reserved"
  /** 內嵌 IPv4 的轉換前綴：NAT64 64:ff9b::/96、64:ff9b:1::/48、6to4 2002::/16。 */
  | "transition";

/** Cloud metadata endpoints that live outside link-local space. */
const METADATA_IPV4 = new Set([
  "168.63.129.16", // Azure WireServer
  "100.100.100.200", // Alibaba Cloud
  "192.0.0.192", // Oracle Cloud
]);
/** AWS IMDS over IPv6 — sits inside ULA fc00::/7. */
const METADATA_IPV6 = [parseIPv6Bytes("fd00:ec2::254")!];

/** Strip URL-style brackets and an IPv6 zone id (`fe80::1%eth0`). */
export function normalizeIpLiteral(ip: string): string {
  let s = ip.trim();
  if (s.length >= 2 && s.startsWith("[") && s.endsWith("]")) {
    s = s.slice(1, -1);
  }
  const pct = s.indexOf("%");
  if (pct !== -1) s = s.slice(0, pct);
  return s;
}

/** Strict dotted-quad parse; null when not an IPv4 literal. */
export function parseIPv4Bytes(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  return ip.split(".").map(Number);
}

/** Parse any valid IPv6 spelling into 16 bytes; null when invalid. */
export function parseIPv6Bytes(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let head = ip;
  let tailV4: number[] = [];
  // Trailing dotted quad (`::ffff:1.2.3.4`) → two 16-bit groups.
  const lastColon = head.lastIndexOf(":");
  const maybeV4 = head.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4Bytes(maybeV4);
    if (!v4) return null;
    tailV4 = v4;
    head = head.slice(0, lastColon + 1);
    // `::1.2.3.4` leaves "::" — keep it; "a:b::c:" style leaves a dangling
    // colon that the split below handles as an empty trailing group.
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  }
  const groupsNeeded = 8 - tailV4.length / 2;
  const toGroups = (part: string): string[] =>
    part === "" ? [] : part.split(":");
  let groups: string[];
  const dbl = head.indexOf("::");
  if (dbl !== -1) {
    const left = toGroups(head.slice(0, dbl));
    const right = toGroups(head.slice(dbl + 2));
    const fill = groupsNeeded - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array<string>(fill).fill("0"), ...right];
  } else {
    groups = toGroups(head);
  }
  if (groups.length !== groupsNeeded) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const v = parseInt(g, 16);
    if (!/^[0-9a-f]{1,4}$/i.test(g) || Number.isNaN(v)) return null;
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return [...bytes, ...tailV4];
}

function startsWith(bytes: number[], prefix: number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

function bytesEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function classifyIPv4(b: number[]): AddressClass {
  const [a, b1] = b;
  if (b.every((o) => o === 0)) return "unspecified";
  if (a === 0) return "reserved";
  if (a === 127) return "loopback";
  if (a === 169 && b1 === 254) return "linkLocal";
  // metadata 要在 private / shared 判斷之前：100.100.100.200 落在 100.64/10
  if (METADATA_IPV4.has(b.join("."))) return "metadata";
  if (a === 10) return "private";
  if (a === 172 && b1 >= 16 && b1 <= 31) return "private";
  if (a === 192 && b1 === 168) return "private";
  if (a === 100 && b1 >= 64 && b1 <= 127) return "private";
  if (a === 198 && (b1 === 18 || b1 === 19)) return "reserved";
  if (a >= 224) return "reserved"; // 224/4 multicast + 240/4 reserved/broadcast
  return "public";
}

/**
 * If `bytes` is an IPv4-mapped IPv6 address (::ffff:0:0/96), the
 * embedded IPv4 bytes; otherwise null. Node connects to these as plain
 * IPv4, so they must be classified as the IPv4 they carry.
 */
function mappedIPv4(bytes: number[]): number[] | null {
  const isMapped =
    bytes.slice(0, 10).every((x) => x === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  return isMapped ? bytes.slice(12) : null;
}

/** NAT64 well-known prefix 64:ff9b::/96 (IPv4 in the last 32 bits). */
function isNat64WellKnown(b: number[]): boolean {
  return (
    startsWith(b, [0x00, 0x64, 0xff, 0x9b]) &&
    b.slice(4, 12).every((x) => x === 0)
  );
}

function classifyIPv6(b: number[]): AddressClass {
  const mapped = mappedIPv4(b);
  if (mapped) return classifyIPv4(mapped);
  if (b.every((x) => x === 0)) return "unspecified";
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return "loopback";
  // ::/96 IPv4-compatible (deprecated) — never a legitimate target
  if (b.slice(0, 12).every((x) => x === 0)) return "reserved";
  if (METADATA_IPV6.some((m) => bytesEqual(m, b))) return "metadata";
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "linkLocal"; // fe80::/10
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return "reserved"; // fec0::/10
  if ((b[0] & 0xfe) === 0xfc) return "private"; // fc00::/7
  if (b[0] === 0xff) return "reserved"; // ff00::/8 multicast
  if (isNat64WellKnown(b)) return "transition";
  if (startsWith(b, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) {
    return "transition"; // NAT64 local-use 64:ff9b:1::/48
  }
  if (startsWith(b, [0x20, 0x02])) return "transition"; // 6to4 2002::/16
  return "public";
}

/**
 * For a `transition`-class address, the IPv4 it embeds (dotted form):
 * NAT64 64:ff9b::/96 carries it in the last 32 bits, 6to4 2002::/16 in
 * bits 16-47. Null for anything else — including the NAT64 local-use
 * prefix 64:ff9b:1::/48, whose embedding depends on an operator-chosen
 * prefix length and so cannot be decoded reliably.
 */
export function transitionEmbeddedIPv4(ip: string): string | null {
  const b = parseIPv6Bytes(normalizeIpLiteral(ip));
  if (!b) return null;
  if (isNat64WellKnown(b)) return b.slice(12).join(".");
  if (startsWith(b, [0x20, 0x02])) return b.slice(2, 6).join(".");
  return null;
}

/**
 * Bytes to compare an address by: IPv4 → 4 bytes, IPv4-mapped IPv6 → the
 * 4 embedded bytes (Node connects to it as that IPv4), other IPv6 → 16
 * bytes. Null for a non-literal.
 */
export function addressBytes(ip: string): number[] | null {
  const s = normalizeIpLiteral(ip);
  const v4 = parseIPv4Bytes(s);
  if (v4) return v4;
  const v6 = parseIPv6Bytes(s);
  if (!v6) return null;
  return mappedIPv4(v6) ?? v6;
}

/**
 * Classify an IP literal (brackets / zone id tolerated). Returns null
 * when `ip` is not an IP literal at all (e.g. a hostname).
 */
export function classifyAddress(ip: string): AddressClass | null {
  const b = addressBytes(ip);
  if (!b) return null;
  return b.length === 4 ? classifyIPv4(b) : classifyIPv6(b);
}
