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

// ─── Config Intake ───────────────────────────────────────────────────

/**
 * Options for {@link configIntake}. `allowUnknownKeys` is per-caller
 * policy, deliberately NOT converged: per-guild feature config
 * tolerates unknown keys (orphaned values from an older schema version
 * must not break old guilds), the plugin-level save rejects them.
 */
export interface ConfigIntakeOptions {
  allowUnknownKeys: boolean;
  /** Encrypt a secret field's plaintext for storage at rest. Injected
   *  so this module stays pure (no crypto/env dependency). */
  encryptSecret: (plaintext: string) => string;
}

/** One storage-ready key from a successful intake. */
export type ConfigIntakeEntry =
  | {
      kind: "field";
      key: string;
      field: ManifestConfigField;
      /** Storage-ready string form: encrypted for a non-empty secret,
       *  the normalized string verbatim otherwise ("" = clear/delete). */
      value: string;
    }
  | {
      /** Present only under `allowUnknownKeys: true`. */
      kind: "unknown";
      key: string;
      /** Normalized string form of the value. */
      value: string;
      /** The caller's original value, for the storage model that keeps
       *  native types (the per-guild JSON document). */
      native: unknown;
    };

export type ConfigIntakeResult =
  | { ok: true; entries: ConfigIntakeEntry[]; skippedSecretKeys: string[] }
  | { ok: false; fieldErrors: FieldValidationError[] };

/**
 * Config Intake (glossary term) — turn an admin config payload into
 * validated, storage-ready values: normalize, validate, resolve the
 * secret sentinel and encryption. This is the front half the two
 * config-write paths genuinely share (issue #30, decision 7); what
 * each does afterwards — one JSON document holding native types, one
 * string-valued row per key, each with its own follow-on effects — is
 * deliberately NOT shared. Merging the back halves would turn a subtle
 * divergence into a mode flag.
 *
 * Normalization (issue #30, decision 8): a JSON boolean or number is
 * accepted wherever a config value is expected and coerced to its
 * string form ("false", "42") before validation — on BOTH paths, so a
 * maintenance script does not have to stringify by hand. Caveat, owned
 * here at the seam: per-key string storage cannot round-trip a native
 * type. A JSON boolean is accepted on both paths but returned verbatim
 * only by the document-backed (per-guild feature) one; the per-key
 * (plugin-level) path stores and returns the coerced string.
 * `null`/`undefined` normalize to "" (clear/delete intent); any other
 * non-string value is a `type_mismatch` field error.
 *
 * On any error the whole payload is refused with EVERY field error
 * accumulated — normalization errors first, then validator errors —
 * so the admin UI renders them all at once.
 */
export function configIntake(
  schema: ManifestConfigField[],
  incoming: Record<string, unknown>,
  opts: ConfigIntakeOptions,
): ConfigIntakeResult {
  const stringValues: Record<string, string> = {};
  const normalizeErrors: FieldValidationError[] = [];
  for (const [key, raw] of Object.entries(incoming)) {
    if (raw === null || raw === undefined) {
      stringValues[key] = "";
      continue;
    }
    if (typeof raw === "boolean" || typeof raw === "number") {
      stringValues[key] = String(raw);
      continue;
    }
    if (typeof raw !== "string") {
      normalizeErrors.push({
        key,
        message: `'${key}' must be a string`,
        code: "type_mismatch",
      });
      continue;
    }
    stringValues[key] = raw;
  }

  const result = validateValues(schema, stringValues, {
    allowUnknownKeys: opts.allowUnknownKeys,
  });
  if (normalizeErrors.length > 0 || !result.ok) {
    return { ok: false, fieldErrors: [...normalizeErrors, ...result.errors] };
  }

  const schemaByKey = new Map(schema.map((f) => [f.key, f]));
  const entries: ConfigIntakeEntry[] = [];
  const skippedSecretKeys: string[] = [];
  for (const [key, value] of Object.entries(stringValues)) {
    const field = schemaByKey.get(key);
    if (!field) {
      // Unknown key (allowUnknownKeys) — pass through, but never emit
      // the literal secret sentinel: it may be an echo of a key that
      // was a secret under an older schema version. Drop it instead.
      if (value === SECRET_SENTINEL) continue;
      entries.push({ kind: "unknown", key, value, native: incoming[key] });
      continue;
    }
    if (field.type === "secret" && value === SECRET_SENTINEL) {
      // Sentinel = "leave the stored value untouched" — the caller's
      // persistence must preserve the existing value for these keys.
      skippedSecretKeys.push(key);
      continue;
    }
    entries.push({
      kind: "field",
      key,
      field,
      value:
        field.type === "secret" && value.length > 0
          ? opts.encryptSecret(value)
          : value,
    });
  }
  return { ok: true, entries, skippedSecretKeys };
}
