import {
  validateConfigValue,
  type ConfigFieldErrorCode,
  type ManifestConfigField,
} from "@karyl-chan/plugin-wire";

/**
 * The bot's admin-save wrapper around the wire contract's config
 * validation.
 *
 * Whether a field declaration is well-formed, and whether one value
 * satisfies it, are protocol questions — `@karyl-chan/plugin-wire`
 * owns both, so the SDK enforces the same rules at build time. (The
 * declaration half, `validateConfigSchema`, is reached through the
 * wire's `validateManifest` at register.) What lives here is the part
 * the wire has no opinion about, because it is bot↔frontend:
 *
 *  - accumulating ALL field errors rather than aborting on the first,
 *    so the admin UI can render every problem at once
 *  - the secret sentinel ("leave the stored value alone")
 *  - unknown-key policy, and which keys the caller should persist
 *
 * Pure functions, no I/O, no DB — exhaustively testable in isolation.
 */

/** The wire's codes plus `unknown_key`, which only the save path can
 *  raise (the wire validates a value against a field it was given). */
export type FieldValidationCode = ConfigFieldErrorCode | "unknown_key";

export interface FieldValidationError {
  key: string;
  message: string;
  code: FieldValidationCode;
}

export interface ValueValidationResult {
  ok: boolean;
  errors: FieldValidationError[];
  /** Keys whose values passed validation and should be persisted. */
  accepted: string[];
  /** Keys skipped because they hit the secret-sentinel "unchanged" marker. */
  skipped: string[];
}

/** Sentinel returned from `config.get` for secret fields — admin UI
 *  shows it as a placeholder; the bot treats a save with this exact
 *  value as "leave the existing value untouched". */
export const SECRET_SENTINEL = "********";

// ─── Save-time orchestration ─────────────────────────────────────────

/**
 * Validate the full incoming payload against the schema. Returns
 * every field error so the admin UI can render them all at once.
 */
export function validateValues(
  schema: ManifestConfigField[],
  incoming: Record<string, string>,
  opts: { allowUnknownKeys?: boolean } = {},
): ValueValidationResult {
  const errors: FieldValidationError[] = [];
  const accepted: string[] = [];
  const skipped: string[] = [];
  const schemaByKey = new Map(schema.map((f) => [f.key, f]));

  // Unknown keys (callers can opt out — useful for the existing
  // per-guild config save path which is config-only via PATCH).
  for (const k of Object.keys(incoming)) {
    if (!schemaByKey.has(k) && !opts.allowUnknownKeys) {
      errors.push({
        key: k,
        message: `unknown config key "${k}"`,
        code: "unknown_key",
      });
    }
  }

  for (const field of schema) {
    if (!(field.key in incoming)) continue;
    const raw = incoming[field.key];
    // Secret sentinel: short-circuit before the validator — the caller's
    // upsert path needs to know to SKIP this key (not overwrite the
    // existing value with the sentinel string).
    if (field.type === "secret" && raw === SECRET_SENTINEL) {
      skipped.push(field.key);
      continue;
    }
    const err = validateConfigValue(field, raw);
    if (err) {
      errors.push(err);
    } else {
      accepted.push(field.key);
    }
  }
  return { ok: errors.length === 0, errors, accepted, skipped };
}
