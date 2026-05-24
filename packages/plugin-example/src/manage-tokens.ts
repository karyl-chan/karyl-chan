/**
 * Plugin-side manage session tokens — HS256 access/refresh pair.
 *
 * The bot's plugin-session JWT (15 min, capability-bearing) crosses
 * the wire ONCE on the first SPA load. The SPA immediately exchanges
 * it for an access(5 min) + refresh(24 h) pair signed by THIS
 * plugin's in-memory secret, and uses those for every subsequent
 * authenticated request. On plugin restart the secret regenerates,
 * so all outstanding manage sessions invalidate at once — the
 * intended kill-switch when an admin needs to revoke access.
 *
 * Mirrors the pattern in plugin-radio/src/manage-tokens.ts. Kept here
 * (vs the SDK) because each plugin instance owns its own secret.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ACCESS_TTL_MS = 5 * 60_000;
export const REFRESH_TTL_MS = 24 * 60 * 60_000;

const SECRET = randomBytes(32);

export interface ManageClaims {
  purpose: "manage-access" | "manage-refresh";
  userId: string;
  capabilities: string[];
  iat: number;
  exp: number;
}

function b64urlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(input: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new Error("invalid base64url");
  if (input.length % 4 === 1) throw new Error("invalid base64url length");
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function sign(
  purpose: ManageClaims["purpose"],
  userId: string,
  capabilities: string[],
  ttlMs: number,
): { token: string; expiresAt: number } {
  const now = Date.now();
  const exp = now + ttlMs;
  const headerSeg = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const bodySeg = b64urlEncode(
    JSON.stringify({ purpose, userId, capabilities, iat: now, exp }),
  );
  const signingInput = `${headerSeg}.${bodySeg}`;
  const sigSeg = b64urlEncode(
    createHmac("sha256", SECRET).update(signingInput).digest(),
  );
  return { token: `${signingInput}.${sigSeg}`, expiresAt: exp };
}

export function issueManagePair(
  userId: string,
  capabilities: string[],
): {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
} {
  const access = sign("manage-access", userId, capabilities, ACCESS_TTL_MS);
  const refresh = sign("manage-refresh", userId, capabilities, REFRESH_TTL_MS);
  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    accessExpiresAt: access.expiresAt,
    refreshExpiresAt: refresh.expiresAt,
  };
}

export function verifyManageToken(
  token: string,
  expectedPurpose: ManageClaims["purpose"],
): ManageClaims | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSeg, bodySeg, sigSeg] = parts;
  let header: unknown;
  try {
    header = JSON.parse(b64urlDecode(headerSeg).toString("utf-8"));
  } catch {
    return null;
  }
  if (!header || typeof header !== "object") return null;
  const h = header as Record<string, unknown>;
  if (h.alg !== "HS256" || h.typ !== "JWT") return null;

  let providedSig: Buffer;
  try {
    providedSig = b64urlDecode(sigSeg);
  } catch {
    return null;
  }
  const expectedSig = createHmac("sha256", SECRET)
    .update(`${headerSeg}.${bodySeg}`)
    .digest();
  if (providedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(providedSig, expectedSig)) return null;

  let body: unknown;
  try {
    body = JSON.parse(b64urlDecode(bodySeg).toString("utf-8"));
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const p = body as Record<string, unknown>;
  if (p.purpose !== expectedPurpose) return null;
  if (typeof p.userId !== "string" || !p.userId) return null;
  if (
    !Array.isArray(p.capabilities) ||
    !p.capabilities.every((c) => typeof c === "string")
  ) {
    return null;
  }
  if (typeof p.exp !== "number" || p.exp <= Date.now()) return null;
  if (typeof p.iat !== "number") return null;
  return {
    purpose: p.purpose as ManageClaims["purpose"],
    userId: p.userId,
    capabilities: p.capabilities as string[],
    iat: p.iat,
    exp: p.exp,
  };
}
