import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "crypto";
import { moduleLogger } from "../logger.js";
import { getSecret } from "./secrets.js";

const log = moduleLogger("crypto");

/**
 * SHA-256 hex digest of an opaque token. Session/SSE tokens are stored
 * only as their hash so a store dump never reveals a usable credential.
 * The in-process and Redis session stores MUST hash identically (tokens
 * minted by one are looked up by the other during a migration window),
 * so this lives in one place rather than being copy-pasted per store.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A fresh 256-bit opaque token, hex-encoded. */
export function newToken(): string {
  return randomBytes(32).toString("hex");
}

const ALGO = "aes-256-gcm";
const ENC_VERSION_V2 = "v2";
const IV_BYTES = 12;
const KEY_BYTES = 32;

interface EncKey {
  /** First 8 hex chars of sha256(key) — embedded in v2 ciphertext so
   *  we can pick the right key on decrypt during a rotation window. */
  id: string;
  bytes: Buffer;
}

function parseKeys(raw: string): EncKey[] {
  const hexes = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (hexes.length === 0) {
    throw new Error("ENCRYPTION_KEY contains no usable key");
  }
  return hexes.map((hex) => {
    const bytes = Buffer.from(hex, "hex");
    if (bytes.length !== KEY_BYTES) {
      throw new Error(
        `encryption key must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars)`,
      );
    }
    const id = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
    return { id, bytes };
  });
}

/**
 * Load every configured encryption key. Comma-separated to support
 * rotation: the FIRST key is the active writer (new ciphertext is
 * sealed with it), and any other listed key still decrypts existing
 * rows. To rotate: prepend a new key, deploy, run a re-encrypt sweep
 * over stored ciphertexts, then drop the old key on the next deploy.
 */
function getKeys(): EncKey[] {
  // Re-read on every call so key rotation (prepending a new key to the
  // ENCRYPTION_KEY secret) takes effect without a restart. This is an
  // intentional exception to the "read env via config singleton" rule: the
  // key set is operationally changed at runtime and must be re-read each call.
  // Sourced through the SecretProvider (PR-5.1) so SECRET_PROVIDER=file can
  // feed it from a mounted secret; the default env provider re-reads
  // process.env each call exactly as before.
  const raw = getSecret("ENCRYPTION_KEY");
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32",
    );
  }
  return parseKeys(raw);
}

/** AES-256-GCM-seal `plaintext` under `keyBytes` with a fresh IV. The
 *  callers own the encoding (v2 secrets vs. subkey seals). */
function gcmSeal(
  keyBytes: Buffer,
  plaintext: string,
): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, keyBytes, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

/** Open a {@link gcmSeal} output; throws when the tag does not verify. */
function gcmOpen(keyBytes: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): string {
  const decipher = createDecipheriv(ALGO, keyBytes, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8",
  );
}

export function encryptSecret(plaintext: string): string {
  const [active] = getKeys();
  const { iv, tag, ct } = gcmSeal(active.bytes, plaintext);
  return [
    ENC_VERSION_V2,
    active.id,
    iv.toString("base64"),
    tag.toString("base64"),
    ct.toString("base64"),
  ].join(":");
}

export function decryptSecret(value: string): string {
  const keys = getKeys();
  if (value.startsWith(`${ENC_VERSION_V2}:`)) {
    const parts = value.split(":");
    if (parts.length !== 5)
      throw new Error("Invalid v2 encrypted value format");
    const [, keyId, ivB64, tagB64, ctB64] = parts;
    const key = keys.find((k) => k.id === keyId);
    if (!key)
      throw new Error(
        `unknown encryption key id ${keyId} — was the key rotated out?`,
      );
    return gcmOpen(
      key.bytes,
      Buffer.from(ivB64, "base64"),
      Buffer.from(tagB64, "base64"),
      Buffer.from(ctB64, "base64"),
    );
  }
  // v0 plaintext and v1 ciphertext are no longer supported. The one-time
  // encryption-v2 uplift migration was removed along with the Umzug
  // migration system, so a pre-v2 value can no longer be decrypted —
  // only v2 values are supported by this build.
  log.error(
    { prefix: value.slice(0, 8) },
    "decryptSecret: unsupported pre-v2 encryption format detected",
  );
  throw new Error(
    "unknown encryption format: only v2 values are supported",
  );
}

// ─── purpose-bound subkeys ──────────────────────────────────────────

const SUBKEY_SALT = Buffer.from("karyl-encryption-subkey-v1");
const SUBKEY_SEAL_VERSION = "s1";

/**
 * Every configured key, HKDF-SHA256-derived for one `purpose`. A value
 * sealed for one purpose never opens under another, and nothing sealed
 * here is ever a valid `encryptSecret` ciphertext (or the reverse) — the
 * master key itself never touches these values. The id is the subkey's
 * own fingerprint, so a sealed value names no master-key fingerprint.
 */
function subkeys(purpose: string): EncKey[] {
  return getKeys().map((k) => {
    const bytes = Buffer.from(
      hkdfSync("sha256", k.bytes, SUBKEY_SALT, Buffer.from(purpose, "utf8"), KEY_BYTES),
    );
    const id = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
    return { id, bytes };
  });
}

/**
 * AES-256-GCM-seal `plaintext` under the active key's subkey for
 * `purpose`. Output is URL-safe: `s1.<keyId>.<iv>.<tag>.<ct>`, the last
 * three base64url. Stateless: any process holding the same
 * ENCRYPTION_KEY opens it, across restarts and shards; a key rotated in
 * still opens what the previous key sealed while both are listed.
 */
export function sealWithSubkey(purpose: string, plaintext: string): string {
  const [active] = subkeys(purpose);
  const { iv, tag, ct } = gcmSeal(active.bytes, plaintext);
  return [
    SUBKEY_SEAL_VERSION,
    active.id,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

export type SubkeyOpenResult =
  | { ok: true; plaintext: string }
  /** `malformed`: not a sealed value at all; `unsealable`: shaped like
   *  one but no configured key authenticates it (tampered, another
   *  purpose, or a key no longer listed). */
  | { ok: false; reason: "malformed" | "unsealable" };

/** Open a {@link sealWithSubkey} value sealed for the same `purpose`. */
export function openWithSubkey(purpose: string, value: string): SubkeyOpenResult {
  const parts = value.split(".");
  const b64url = /^[A-Za-z0-9_-]+$/;
  if (
    parts.length !== 5 ||
    parts[0] !== SUBKEY_SEAL_VERSION ||
    !/^[0-9a-f]{8}$/.test(parts[1]!) ||
    !parts.slice(2).every((p) => b64url.test(p))
  ) {
    return { ok: false, reason: "malformed" };
  }
  const [, keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string];
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    return { ok: false, reason: "malformed" };
  }
  const key = subkeys(purpose).find((k) => k.id === keyId);
  if (!key) return { ok: false, reason: "unsealable" };
  try {
    const plaintext = gcmOpen(key.bytes, iv, tag, Buffer.from(ctB64, "base64url"));
    return { ok: true, plaintext };
  } catch {
    return { ok: false, reason: "unsealable" };
  }
}
