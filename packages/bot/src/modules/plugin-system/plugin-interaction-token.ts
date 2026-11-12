import { openWithSubkey, sealWithSubkey } from "../../utils/crypto.js";

/**
 * Sealed interaction token (#215).
 *
 * A plugin never sees a Discord interaction token. At dispatch (command,
 * component, modal) the bot seals { Discord token, plugin id, expiry }
 * with AES-256-GCM under an ENCRYPTION_KEY subkey and sends THAT as the
 * payload's `interaction_token`. The `/api/plugin/interactions.*` routes
 * unseal it before talking to Discord, so a token only works for the
 * plugin it was dispatched to, only for 15 minutes, and is useless
 * outside the bot (the Discord token is a webhook credential on its own:
 * app id + token reaches Discord without the bot).
 *
 * The wire field keeps its name and type — the SDK and every plugin only
 * echo it back — only its content changed to an opaque string.
 *
 * Stateless: no store, nothing to share between shards; any process
 * holding the same ENCRYPTION_KEY opens it, restarts included.
 */

/** Discord's own interaction-token lifetime, counted from dispatch. */
export const INTERACTION_TOKEN_TTL_MS = 15 * 60 * 1000;

/** HKDF `info` for the subkey — binds the ciphertext to this one use. */
const PURPOSE = "plugin-interaction-token-v1";

interface SealedClaims {
  /** The Discord interaction token. */
  t: string;
  /** Plugin row id the token was dispatched to. */
  p: number;
  /** Expiry, epoch ms. */
  e: number;
}

export type InteractionTokenRefusal =
  | "malformed"
  | "unsealable"
  | "expired"
  | "wrong_plugin";

export type UnsealResult =
  | { ok: true; token: string }
  | { ok: false; reason: InteractionTokenRefusal };

/** Seal `discordToken` for `pluginId`, good for 15 minutes from `now`. */
export function sealInteractionToken(
  discordToken: string,
  pluginId: number,
  now: number = Date.now(),
): string {
  const claims: SealedClaims = {
    t: discordToken,
    p: pluginId,
    e: now + INTERACTION_TOKEN_TTL_MS,
  };
  return sealWithSubkey(PURPOSE, JSON.stringify(claims));
}

/**
 * Open a sealed token on behalf of `callerPluginId`. A token sealed for
 * another plugin is refused even when it is also expired — the caller
 * holding someone else's token is the finding worth recording.
 */
export function unsealInteractionToken(
  sealed: string,
  callerPluginId: number,
  now: number = Date.now(),
): UnsealResult {
  const opened = openWithSubkey(PURPOSE, sealed);
  if (!opened.ok) return opened;
  let claims: Partial<SealedClaims>;
  try {
    claims = JSON.parse(opened.plaintext) as Partial<SealedClaims>;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof claims.t !== "string" ||
    typeof claims.p !== "number" ||
    typeof claims.e !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (claims.p !== callerPluginId) return { ok: false, reason: "wrong_plugin" };
  if (now > claims.e) return { ok: false, reason: "expired" };
  return { ok: true, token: claims.t };
}
