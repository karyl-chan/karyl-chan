import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

/**
 * Offline verification of a `plugin-session` JWT issued by the bot.
 *
 * The bot signs these tokens with an Ed25519 (EdDSA) private key and
 * hands plugins the matching public key in the `/api/plugins/register`
 * response (`sessionVerifyPublicKey` — surfaced as
 * `StartedPlugin.getSessionVerifyPublicKey()` /
 * `PluginClient.getSessionVerifyPublicKey()`). A plugin can therefore
 * authorize WebUI requests without a round-trip to the bot, and — since
 * it only holds the *public* key — a compromised plugin cannot forge
 * tokens.
 *
 * Token shape (compact JWS): header `{ alg: "EdDSA", typ: "JWT" }`,
 * payload `{ purpose: "plugin-session", userId, guildId, capabilities,
 * iat, exp }`. The `capabilities` claim is the user's `admin` +
 * `plugin:<key>:*` subset, snapshotted at mint time; pair it with
 * {@link hasPluginCapability}.
 */

const PURPOSE = "plugin-session";

export interface PluginSessionClaims {
  /** Discord user id the token authorizes. */
  userId: string;
  /** Playback-/scope-bound guild id, or null for non-guild (`manage`) tokens. */
  guildId: string | null;
  /**
   * The user's `admin` + `plugin:<key>:*` capability subset at mint time.
   * `manage` tokens carry the relevant grants; `session` tokens are
   * authorized purely by `guildId` and carry an empty array.
   */
  capabilities: string[];
}

function base64urlDecode(input: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new Error("invalid base64url");
  if (input.length % 4 === 1) throw new Error("invalid base64url length");
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/**
 * Verify `token` against `publicKey` (an SPKI PEM string — the value
 * from `getSessionVerifyPublicKey()` — or a pre-built `KeyObject`).
 * Returns the claims, or `null` on any failure: missing key, bad
 * signature, wrong algorithm (`alg: none`, HMAC-with-the-public-key,
 * anything that isn't exactly `EdDSA`), expired, malformed, or wrong
 * `purpose`.
 */
export function verifyPluginSession(
  token: string,
  publicKey: string | KeyObject | null | undefined,
  options: { now?: number } = {},
): PluginSessionClaims | null {
  if (!token || !publicKey) return null;
  let key: KeyObject;
  try {
    key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  } catch {
    return null;
  }
  if (key.asymmetricKeyType !== "ed25519") return null;

  const now = options.now ?? Date.now();
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSeg, bodySeg, signatureSeg] = parts;

  // Header first: reject anything that isn't our exact EdDSA header so an
  // attacker can't downgrade to `alg: none` or to HMAC-keyed-by-the-
  // public-key (the classic asymmetric→symmetric confusion).
  let header: unknown;
  try {
    header = JSON.parse(base64urlDecode(headerSeg).toString("utf-8"));
  } catch {
    return null;
  }
  if (!header || typeof header !== "object") return null;
  const h = header as Record<string, unknown>;
  if (h.alg !== "EdDSA" || h.typ !== "JWT") return null;

  let signature: Buffer;
  try {
    signature = base64urlDecode(signatureSeg);
  } catch {
    return null;
  }
  if (!cryptoVerify(null, Buffer.from(`${headerSeg}.${bodySeg}`, "utf-8"), key, signature)) {
    return null;
  }

  let body: unknown;
  try {
    body = JSON.parse(base64urlDecode(bodySeg).toString("utf-8"));
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const p = body as Record<string, unknown>;
  if (p.purpose !== PURPOSE) return null;
  if (typeof p.exp !== "number" || p.exp * 1000 <= now) return null;
  if (typeof p.userId !== "string" || !p.userId) return null;
  if (p.guildId !== null && typeof p.guildId !== "string") return null;
  if (
    !Array.isArray(p.capabilities) ||
    !p.capabilities.every((c) => typeof c === "string")
  ) {
    return null;
  }
  return {
    userId: p.userId,
    guildId: p.guildId as string | null,
    capabilities: p.capabilities as string[],
  };
}

/**
 * True if `granted` (a `plugin-session` token's `capabilities` claim)
 * authorizes `plugin:<pluginKey>:<capKey>`. `admin` is a superuser
 * bypass. Mirrors the bot's `hasPluginCapability` / `makePluginCapabilityToken`.
 */
export function hasPluginCapability(
  granted: Iterable<string>,
  pluginKey: string,
  capKey: string,
): boolean {
  const token = `plugin:${pluginKey}:${capKey}`;
  for (const cap of granted) {
    if (cap === "admin") return true;
    if (cap === token) return true;
  }
  return false;
}
