import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "crypto";
import { config } from "../../config.js";
import { moduleLogger } from "../../logger.js";
import { decryptSecret, encryptSecret } from "../../utils/crypto.js";
import {
  getActiveJwtSigningKey,
  insertActiveJwtSigningKey,
} from "./models/jwt-signing-key.model.js";

const log = moduleLogger("jwt");

const DEFAULT_TTL_MS = config.jwt.loginLinkTtlMs;
const KEY_ALGORITHM = "ed25519";

/**
 * PKCS8 DER prefix for an Ed25519 private key: SEQUENCE { version, OID
 * 1.3.101.112, OCTET STRING { OCTET STRING(32-byte seed) } }. Concatenated
 * with a raw 32-byte seed it yields a DER blob `createPrivateKey` accepts —
 * Node has no "Ed25519 key from raw seed" API, so we wrap the seed by hand.
 */
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
/** HKDF salt domain-separating the per-plugin session-signing keys. */
const PLUGIN_SESSION_KEY_SALT = Buffer.from("karyl-plugin-session-sign-v1");

/**
 * The bot's single JWT signing authority.
 *
 * Every JWT the bot issues — admin login links, plugin-session tokens
 * for plugin WebUIs (e.g. karyl-radio), and any future stateless token
 * flow — is signed here with one Ed25519 (EdDSA) key. Consequences:
 *
 *   - One key, one algorithm, one verification path. The public key is
 *     published — handed to plugins in the `/api/plugins/register`
 *     response and on every heartbeat, surfaced in the admin UI — so a
 *     holder of the public key can *verify* bot JWTs but cannot *forge*
 *     them. No shared secret leaves the bot: a compromised plugin only
 *     ever has the public key.
 *   - `purpose` discriminates token kinds (`login`, `plugin-session`,
 *     …). `verify()` can require a specific `purpose` so a token minted
 *     for one flow can't be replayed at an endpoint expecting another.
 *
 * Key lifecycle: the private key is generated at runtime and stored
 * (encrypted) in the `jwt_signing_keys` table — never in env, never on
 * disk in cleartext. On boot {@link initJwtSigningAuthority} loads the
 * active key (generating + persisting one on a fresh DB).
 * {@link rotateJwtSigningKey} (admin-triggered) generates a fresh key,
 * persists it, and swaps it in; plugins pick up the new public key on
 * their next heartbeat (within ~30s). A rotation invalidates every
 * outstanding token (login links, plugin-session tokens) — which is the
 * point of rotating a signing key.
 *
 * Stateless: a token validates iff its EdDSA signature checks out, its
 * `purpose` matches (when required), and its `exp` hasn't passed.
 */

export interface JwtClaims {
  /** Token kind, e.g. `login`, `plugin-session`. Required. */
  purpose: string;
  /** Discord user id the token authorizes. Required. */
  userId: string;
  /** Guild scope, or null (DM context / non-guild token). */
  guildId: string | null;
  /**
   * Snapshot of the message that triggered issuance — audit trail for
   * login links. Absent for tokens not produced by a message/interaction.
   */
  channelId?: string;
  messageId?: string;
  /**
   * The user's `admin` + `plugin:<key>:*` capability subset, snapshotted
   * at mint time. Carried by `plugin-session` tokens so a plugin WebUI
   * can authorize offline; absent on other token kinds.
   */
  capabilities?: string[];
}

interface SignedPayload extends JwtClaims {
  /** Issued-at, seconds since epoch (RFC 7519 `iat`). */
  iat: number;
  /** Expiration, seconds since epoch (RFC 7519 `exp`). */
  exp: number;
}

export interface SignOptions {
  /** Token lifetime in ms. Defaults to `config.jwt.loginLinkTtlMs` (5 min). */
  ttlMs?: number;
  /** Override `now` for tests. */
  now?: number;
}

export interface VerifyOptions {
  /** Override `now` for tests. */
  now?: number;
  /** When set, reject tokens whose `purpose` claim doesn't match. */
  purpose?: string;
}

function base64urlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecode(input: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new Error("invalid base64url");
  // A base64(url) string can never be 1 mod 4 chars long — reject rather
  // than let Buffer.from silently produce garbage.
  if (input.length % 4 === 1) throw new Error("invalid base64url length");
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function assertEd25519(key: KeyObject): void {
  if (key.asymmetricKeyType !== KEY_ALGORITHM) {
    throw new Error(
      `JWT signing key must be ${KEY_ALGORITHM} (got ${key.asymmetricKeyType ?? "unknown"})`,
    );
  }
}

export class JwtService {
  private privateKey: KeyObject;
  private publicKey: KeyObject;
  private publicKeyPemCache: string;
  /**
   * Memoized per-plugin session-signing keys, keyed by pluginKey. Cleared
   * by {@link setKey} so a master-key rotation re-derives every plugin's
   * key (and invalidates outstanding plugin-session tokens, as intended).
   */
  private pluginSessionKeys = new Map<
    string,
    { priv: KeyObject; pubPem: string }
  >();

  constructor(privateKey: KeyObject) {
    assertEd25519(privateKey);
    this.privateKey = privateKey;
    this.publicKey = createPublicKey(privateKey);
    this.publicKeyPemCache = this.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
  }

  /**
   * Swap in a new signing key (used at boot to install the DB-stored key
   * over the bootstrap placeholder, and on rotation). Re-derives the
   * public key.
   */
  setKey(privateKey: KeyObject): void {
    assertEd25519(privateKey);
    this.privateKey = privateKey;
    this.publicKey = createPublicKey(privateKey);
    this.publicKeyPemCache = this.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    // Per-plugin keys are derived from the master key — drop the cache so
    // the next access re-derives against the new key.
    this.pluginSessionKeys.clear();
  }

  /** SPKI PEM the bot publishes so others can verify bot-issued JWTs. */
  publicKeyPem(): string {
    return this.publicKeyPemCache;
  }

  sign(
    claims: JwtClaims,
    options: SignOptions = {},
  ): { token: string; expiresAt: number } {
    return this.signWith(this.privateKey, claims, options);
  }

  private signWith(
    privateKey: KeyObject,
    claims: JwtClaims,
    options: SignOptions = {},
  ): { token: string; expiresAt: number } {
    if (!claims.purpose) {
      throw new Error("JWT purpose is required");
    }
    if (!claims.userId) {
      throw new Error("JWT userId is required");
    }
    const now = options.now ?? Date.now();
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const expiresAt = now + ttlMs;
    const payload: SignedPayload = {
      ...claims,
      iat: Math.floor(now / 1000),
      exp: Math.floor(expiresAt / 1000),
    };
    const headerSeg = base64urlEncode(
      JSON.stringify({ alg: "EdDSA", typ: "JWT" }),
    );
    const bodySeg = base64urlEncode(JSON.stringify(payload));
    const signingInput = `${headerSeg}.${bodySeg}`;
    // Ed25519: the algorithm argument to crypto.sign MUST be null —
    // the hash is baked into the scheme.
    const signatureSeg = base64urlEncode(
      cryptoSign(null, Buffer.from(signingInput, "utf-8"), privateKey),
    );
    return { token: `${signingInput}.${signatureSeg}`, expiresAt };
  }

  /**
   * Derive (and memoize) a per-plugin Ed25519 session-signing key from the
   * active master key + `pluginKey` via HKDF-SHA256. Because each plugin
   * gets a distinct key, a `plugin-session` token minted for plugin A does
   * NOT verify against plugin B's published key — the key itself binds the
   * token to one plugin, with no `aud` claim and no per-plugin key storage.
   */
  private derivePluginSessionKey(pluginKey: string): {
    priv: KeyObject;
    pubPem: string;
  } {
    const cached = this.pluginSessionKeys.get(pluginKey);
    if (cached) return cached;
    // The 32-byte Ed25519 seed of the master key is its JWK `d` field.
    const masterJwk = this.privateKey.export({ format: "jwk" }) as {
      d?: string;
    };
    if (!masterJwk.d) {
      throw new Error("master signing key has no private seed");
    }
    const masterSeed = Buffer.from(masterJwk.d, "base64url");
    const seed = Buffer.from(
      hkdfSync(
        "sha256",
        masterSeed,
        PLUGIN_SESSION_KEY_SALT,
        Buffer.from(pluginKey, "utf-8"),
        32,
      ),
    );
    const priv = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
    const pubPem = createPublicKey(priv)
      .export({ type: "spki", format: "pem" })
      .toString();
    const entry = { priv, pubPem };
    this.pluginSessionKeys.set(pluginKey, entry);
    return entry;
  }

  /**
   * SPKI PEM that verifies `plugin-session` tokens for `pluginKey`. Handed
   * to that plugin at register/heartbeat as `sessionVerifyPublicKey`.
   */
  pluginSessionPublicKeyPem(pluginKey: string): string {
    return this.derivePluginSessionKey(pluginKey).pubPem;
  }

  /**
   * Sign a `plugin-session` token bound to `pluginKey`, using that plugin's
   * derived key instead of the shared master key. Verifies only against
   * {@link pluginSessionPublicKeyPem}(pluginKey).
   */
  signPluginSession(
    pluginKey: string,
    claims: JwtClaims,
    options: SignOptions = {},
  ): { token: string; expiresAt: number } {
    return this.signWith(
      this.derivePluginSessionKey(pluginKey).priv,
      claims,
      options,
    );
  }

  verify(token: string, options: VerifyOptions = {}): JwtClaims | null {
    const now = options.now ?? Date.now();
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerSeg, bodySeg, signatureSeg] = parts;

    // Header first: reject anything that isn't our exact EdDSA header so
    // an attacker can't downgrade to `alg: none` or to HMAC-keyed-by-the-
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
    if (
      !cryptoVerify(
        null,
        Buffer.from(`${headerSeg}.${bodySeg}`, "utf-8"),
        this.publicKey,
        signature,
      )
    ) {
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

    if (typeof p.exp !== "number" || p.exp * 1000 <= now) return null;
    if (typeof p.purpose !== "string" || !p.purpose) return null;
    if (typeof p.userId !== "string" || !p.userId) return null;
    if (p.guildId !== null && typeof p.guildId !== "string") return null;
    // Optional claims — validated only when present.
    if (p.channelId !== undefined && typeof p.channelId !== "string")
      return null;
    if (p.messageId !== undefined && typeof p.messageId !== "string")
      return null;
    if (
      p.capabilities !== undefined &&
      (!Array.isArray(p.capabilities) ||
        !p.capabilities.every((c) => typeof c === "string"))
    ) {
      return null;
    }

    // Purpose check is stricter than the structural ones — a token
    // minted for one flow (e.g., 'login') must not be presented at
    // an endpoint expecting another (e.g., 'plugin-session').
    if (options.purpose !== undefined && p.purpose !== options.purpose)
      return null;

    return {
      purpose: p.purpose,
      userId: p.userId,
      guildId: p.guildId as string | null,
      ...(p.channelId !== undefined
        ? { channelId: p.channelId as string }
        : {}),
      ...(p.messageId !== undefined
        ? { messageId: p.messageId as string }
        : {}),
      ...(p.capabilities !== undefined
        ? { capabilities: p.capabilities as string[] }
        : {}),
    };
  }
}

// ── Singleton + DB-backed lifecycle ───────────────────────────────────────

/**
 * The process-wide signing authority. Constructed at import time with an
 * ephemeral key so modules that `import { jwtService }` always get a
 * usable object; {@link initJwtSigningAuthority} replaces the key with
 * the persisted one during bootstrap (before any route is served).
 */
export const jwtService = new JwtService(
  generateKeyPairSync(KEY_ALGORITHM).privateKey,
);

/** Whether the persisted DB key has been installed (vs. the boot placeholder). */
let dbKeyInstalled = false;

function privateKeyToB64Der(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "der" }).toString("base64");
}

function privateKeyFromB64Der(b64: string): KeyObject {
  const key = createPrivateKey({
    key: Buffer.from(b64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  assertEd25519(key);
  return key;
}

/** Generate + persist a fresh Ed25519 key as the active one. Returns the public PEM. */
async function generateAndPersist(): Promise<string> {
  const { privateKey } = generateKeyPairSync(KEY_ALGORITHM);
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  await insertActiveJwtSigningKey({
    algorithm: KEY_ALGORITHM,
    privateKeyEnc: encryptSecret(privateKeyToB64Der(privateKey)),
    publicKeyPem,
  });
  jwtService.setKey(privateKey);
  return publicKeyPem;
}

/**
 * Boot-time: load the active signing key from the DB; if there isn't one
 * (fresh install) or the encryption layer is unavailable, fall back to
 * the ephemeral key created at import (logging a warning — outstanding
 * tokens won't survive a restart, same as the pre-DB behaviour).
 *
 * Must run after migrations and before the web server starts.
 */
export async function initJwtSigningAuthority(): Promise<void> {
  try {
    const row = await getActiveJwtSigningKey();
    if (row) {
      jwtService.setKey(privateKeyFromB64Der(decryptSecret(row.privateKeyEnc)));
      dbKeyInstalled = true;
      log.info({ keyId: row.id }, "JWT signing key loaded from DB");
      return;
    }
    await generateAndPersist();
    dbKeyInstalled = true;
    log.info("JWT signing key generated and persisted (fresh install)");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      `Could not load/persist a JWT signing key (${msg}) — using an ephemeral in-memory key. ` +
        "Outstanding JWTs (login links, plugin WebUI tokens) won't survive a restart. " +
        "In production, ensure ENCRYPTION_KEY is set so the key can be stored.",
    );
  }
}

/**
 * Admin-triggered key rotation: generate a fresh key, persist it as the
 * active one, and swap it in. Plugins pick up the new public key on
 * their next heartbeat; all previously-issued tokens become invalid.
 * Returns the new public key PEM. Throws if the new key can't be
 * persisted (so a rotation is never silently in-memory-only).
 */
export async function rotateJwtSigningKey(): Promise<{ publicKeyPem: string }> {
  if (!dbKeyInstalled) {
    // We're on the ephemeral fallback (no usable DB key store). Rotating
    // in-memory only would be misleading; surface it instead.
    throw new Error(
      "JWT signing key store unavailable (ENCRYPTION_KEY not set?) — cannot rotate",
    );
  }
  const publicKeyPem = await generateAndPersist();
  log.info("JWT signing key rotated");
  return { publicKeyPem };
}

/**
 * Info about the key the bot is *actually signing with*, for the admin
 * UI. `persisted` is false when running on the ephemeral in-memory
 * fallback (no usable DB key store) — in that case `createdAt` is null
 * and the reported PEM is the in-memory key, not whatever stale row may
 * exist. `publicKeyPem` always reflects the live key, so its fingerprint
 * matches what plugins receive.
 */
export async function getJwtPublicKeyInfo(): Promise<{
  publicKeyPem: string;
  algorithm: string;
  persisted: boolean;
  createdAt: Date | null;
}> {
  const live = jwtService.publicKeyPem();
  if (!dbKeyInstalled) {
    return {
      publicKeyPem: live,
      algorithm: KEY_ALGORITHM,
      persisted: false,
      createdAt: null,
    };
  }
  const row = await getActiveJwtSigningKey();
  return {
    publicKeyPem: live,
    algorithm: row?.algorithm ?? KEY_ALGORITHM,
    persisted: true,
    createdAt: row?.createdAt ?? null,
  };
}
