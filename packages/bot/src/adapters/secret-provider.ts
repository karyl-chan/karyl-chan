/**
 * SecretProvider — central abstraction for sourcing security-relevant
 * secrets (bot token, encryption key, voice↔bot HMAC secret, …).
 *
 * Motivation (PR-5.1): today every secret is read straight from
 * `process.env`. That works on a single host but offers no central
 * management and — critically — no rotation story: rotating a *shared*
 * static secret (e.g. VOICE_HMAC_SECRET, used by both the bot and the
 * voice service) requires a simultaneous restart of every party, because
 * verification only ever knows one key at a time.
 *
 * This abstraction does two things:
 *   1. Routes the security secrets through a single seam so an external
 *      backend (Vault agent / k8s Secret / mounted file) can supply them
 *      instead of the env, selected by one env var — mirroring the
 *      adapter-registry pattern (`SESSION_STORE`, `EVENT_BUS`, …).
 *   2. Models a *rotation window*: a secret can expose a `previous` value
 *      alongside its `current` one. Inbound HMAC verification tries the
 *      current key first, then the previous, so an operator can roll a
 *      shared key by (a) setting the new value as current + the old as
 *      previous, restarting one side, then (b) dropping the previous once
 *      every party is on the new key — no synchronized restart needed.
 *
 * Single-host default is unchanged: no `SECRET_PROVIDER` env → the
 * in-process env provider, which reads exactly the same env vars as before
 * and exposes no `previous` value. Plain `process.env`, zero new deps.
 */

/** The logical names of the secrets this provider serves. */
export type SecretName =
  | "BOT_TOKEN"
  | "ENCRYPTION_KEY"
  | "VOICE_HMAC_SECRET";

/**
 * A secret together with an optional previous value for the rotation
 * window. `current` is the value used for *signing/outbound* and the
 * primary value for verification; `previous` (when present) is an
 * additional value accepted *only on inbound verification* during a
 * rotation window.
 */
export interface RotatableSecret {
  /** The active value. `null` means the secret is not configured. */
  current: string | null;
  /**
   * The prior value, accepted on inbound verification during a rotation
   * window. `null`/absent when not rotating (the common case).
   */
  previous: string | null;
}

/**
 * Source of security secrets. Implementations must be cheap to call
 * repeatedly (callers may read on every request); cache internally if a
 * backend round-trip is involved.
 */
export interface SecretProvider {
  /**
   * Resolve a secret's current value, or `null` if unset. Use this for
   * the common single-value case (signing, or a value with no rotation
   * semantics).
   */
  getSecret(name: SecretName): string | null;

  /**
   * Resolve a secret together with any previous value for the rotation
   * window. Use this on inbound verification of a *shared* secret so a
   * key can be rolled without a synchronized restart.
   */
  getRotatable(name: SecretName): RotatableSecret;
}

/**
 * Ordered list of distinct, non-empty verification keys for a rotatable
 * secret: current first, then previous (deduped). Returns `[]` when the
 * secret is entirely unset. The single-key path (no previous) yields a
 * one-element array, so existing callers keep their exact behaviour.
 */
export function verificationKeys(secret: RotatableSecret): string[] {
  const keys: string[] = [];
  if (secret.current && secret.current.length > 0) keys.push(secret.current);
  if (
    secret.previous &&
    secret.previous.length > 0 &&
    secret.previous !== secret.current
  ) {
    keys.push(secret.previous);
  }
  return keys;
}

// ─── In-process (env) provider — the single-host default ──────────────────

/**
 * Maps each logical secret to its env var. For rotation, the in-process
 * provider also recognises a `<ENV>_PREVIOUS` companion var: setting it
 * opens a rotation window without any external backend.
 */
const ENV_VAR: Record<SecretName, string> = {
  BOT_TOKEN: "BOT_TOKEN",
  ENCRYPTION_KEY: "ENCRYPTION_KEY",
  VOICE_HMAC_SECRET: "VOICE_HMAC_SECRET",
};

function readEnv(name: string): string | null {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : null;
}

/**
 * Default provider: reads secrets from `process.env`, exactly as the code
 * did before this abstraction existed. A `<ENV>_PREVIOUS` companion env
 * var (e.g. `VOICE_HMAC_SECRET_PREVIOUS`) opens a rotation window with no
 * external dependency — the only new behaviour, and opt-in.
 */
export class InProcessSecretProvider implements SecretProvider {
  getSecret(name: SecretName): string | null {
    return readEnv(ENV_VAR[name]);
  }

  getRotatable(name: SecretName): RotatableSecret {
    return {
      current: readEnv(ENV_VAR[name]),
      previous: readEnv(`${ENV_VAR[name]}_PREVIOUS`),
    };
  }
}

// ─── Selection ────────────────────────────────────────────────────────────

/**
 * Pure provider selection from `SECRET_PROVIDER`, with no side effects and
 * no dependency on the adapter registry (which statically pulls in the
 * Redis adapters → config.ts; config.ts itself needs to select a provider
 * at load time, so it must avoid that cycle).
 *
 * The registry's `getSecretProvider()` memoised singleton wraps this; code
 * outside config.ts should prefer the registry accessor. `createFile`
 * is injected so this module stays free of the `fs`-touching file impl.
 */
export function selectSecretProvider(
  createFile: () => SecretProvider,
): SecretProvider {
  const choice = (process.env.SECRET_PROVIDER ?? "").trim().toLowerCase();
  if (choice === "" || choice === "env" || choice === "inprocess") {
    return new InProcessSecretProvider();
  }
  if (choice === "file") {
    return createFile();
  }
  throw new Error(
    `Unknown SECRET_PROVIDER implementation: '${choice}'. ` +
      `Set SECRET_PROVIDER=env (or unset) for the single-host default ` +
      `(process.env). Set SECRET_PROVIDER=file to source secrets from a ` +
      `mounted directory (k8s Secret / Vault Agent files).`,
  );
}
