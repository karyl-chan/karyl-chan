/**
 * Thin accessors for the security-relevant secrets, routed through the
 * configured SecretProvider (PR-5.1).
 *
 * Callers that need a security secret import from here instead of reading
 * `process.env` (or `config.*`) directly, so the provider selection
 * (`SECRET_PROVIDER`) and the rotation window apply uniformly. The
 * single-host default is unchanged: with no `SECRET_PROVIDER` env the
 * in-process env provider returns exactly what `process.env` held before.
 *
 * Scope note: only the *shared/static* secrets flow through here. The
 * per-plugin runtime dispatch HMAC key (`plugin.dispatchHmacKey`) is
 * already auto-generated + DB-persisted per plugin and rotates on
 * re-register — it has its own lifecycle and is intentionally out of
 * scope for the provider.
 */

import { getSecretProvider } from "../adapters/registry.js";
import {
  type SecretName,
  verificationKeys,
} from "../adapters/secret-provider.js";

/** Resolve a secret's current value (signing / single-value use). */
export function getSecret(name: SecretName): string | null {
  return getSecretProvider().getSecret(name);
}

/**
 * Ordered list of distinct verification keys for a shared secret
 * (`[current]` or `[current, previous]`). Pass straight to the
 * rotation-aware HMAC verifiers. Empty when the secret is unset.
 */
export function getVerificationKeys(name: SecretName): string[] {
  return verificationKeys(getSecretProvider().getRotatable(name));
}
