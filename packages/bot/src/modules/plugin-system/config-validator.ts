import type { ManifestConfigField } from "./plugin-sdk-types.js";

/**
 * Single canonical validator for plugin config values (Workpack D).
 *
 * Two consumer call sites:
 *  - register-time: `validateSchema(schema)` checks that field
 *    declarations themselves are well-formed (pattern compiles,
 *    min ≤ max, default's runtime type matches `type`)
 *  - save-time: `validateValues(schema, incoming)` runs against each
 *    incoming `{key: stringValue}` payload before the bot upserts;
 *    accumulates ALL field errors rather than aborting on the first
 *    so the admin UI can render every problem at once
 *
 * Plugin-level config and per-guild feature config use identical
 * field shapes, so both call sites share this validator. Pure
 * functions, no I/O, no DB — exhaustively testable in isolation.
 */

export type FieldValidationCode =
  | "required"
  | "type_mismatch"
  | "pattern"
  | "range"
  | "length"
  | "unknown_key"
  | "invalid_default"
  | "invalid_pattern"
  | "invalid_range";

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

const STRING_TYPES = new Set([
  "text",
  "textarea",
  "url",
  "regex",
  "secret",
]);

function isNumericString(s: string): boolean {
  if (s.trim() === "") return false;
  const n = Number(s);
  return Number.isFinite(n);
}

// ─── Schema-time validation (register-time) ──────────────────────────

/**
 * Validate the manifest's config_schema declaration block itself —
 * runs at register time before any admin can save against it. Catches
 * bad defaults, malformed regex, inverted ranges. Returns the first
 * error found (register-time is a single boolean gate; no need to
 * accumulate).
 */
export function validateSchema(
  schema: ManifestConfigField[],
): FieldValidationError | null {
  for (const field of schema) {
    if (field.default !== undefined && field.default !== null) {
      const ok =
        (field.type === "number" && typeof field.default === "number") ||
        (field.type === "boolean" && typeof field.default === "boolean") ||
        (field.type !== "number" &&
          field.type !== "boolean" &&
          typeof field.default === "string");
      if (!ok) {
        return {
          key: field.key,
          message: `default value type ${typeof field.default} does not match field type "${field.type}"`,
          code: "invalid_default",
        };
      }
    }
    if (field.pattern !== undefined) {
      try {
        new RegExp(field.pattern);
      } catch (err) {
        return {
          key: field.key,
          message: `pattern is not a valid regex: ${err instanceof Error ? err.message : String(err)}`,
          code: "invalid_pattern",
        };
      }
    }
    if (
      field.min !== undefined &&
      field.max !== undefined &&
      field.min > field.max
    ) {
      return {
        key: field.key,
        message: `min (${field.min}) cannot exceed max (${field.max})`,
        code: "invalid_range",
      };
    }
  }
  return null;
}

// ─── Value-time validation (save-time) ───────────────────────────────

/**
 * Validate ONE field's incoming value against its schema declaration.
 * Returns null on pass; a `FieldValidationError` on fail. Value is
 * always the string representation (admin UI submits everything as
 * a string; boolean comes in as "true"/"false", numbers as decimal).
 */
function validateOneValue(
  field: ManifestConfigField,
  rawValue: string,
): FieldValidationError | null {
  // Secret sentinel — admin clicked save without changing the secret.
  // Caller's `accepted` excludes this key so the existing stored value
  // is preserved on the upsert path.
  if (field.type === "secret" && rawValue === SECRET_SENTINEL) {
    return null;
  }

  const trimmed = rawValue.trim();
  const empty = trimmed.length === 0;

  if (field.required && empty) {
    return {
      key: field.key,
      message: `${field.label} is required`,
      code: "required",
    };
  }
  // For non-required empty values we accept the clear as-is; no further
  // checks apply.
  if (empty) return null;

  // Type checks
  if (field.type === "number") {
    if (!isNumericString(trimmed)) {
      return {
        key: field.key,
        message: `${field.label} must be a number`,
        code: "type_mismatch",
      };
    }
    const n = Number(trimmed);
    if (field.min !== undefined && n < field.min) {
      return {
        key: field.key,
        message: `${field.label} must be ≥ ${field.min}`,
        code: "range",
      };
    }
    if (field.max !== undefined && n > field.max) {
      return {
        key: field.key,
        message: `${field.label} must be ≤ ${field.max}`,
        code: "range",
      };
    }
  } else if (field.type === "boolean") {
    if (trimmed !== "true" && trimmed !== "false") {
      return {
        key: field.key,
        message: `${field.label} must be "true" or "false"`,
        code: "type_mismatch",
      };
    }
  } else if (field.type === "url") {
    try {
      // eslint-disable-next-line no-new
      new URL(trimmed);
    } catch {
      return {
        key: field.key,
        message: `${field.label} must be a valid URL`,
        code: "type_mismatch",
      };
    }
  } else if (field.type === "regex") {
    try {
      // eslint-disable-next-line no-new
      new RegExp(trimmed);
    } catch (err) {
      return {
        key: field.key,
        message: `${field.label}: ${err instanceof Error ? err.message : "invalid regex"}`,
        code: "type_mismatch",
      };
    }
  } else if (field.type === "select") {
    const valid = (field.options ?? []).some((o) => o.value === trimmed);
    if (!valid) {
      return {
        key: field.key,
        message: `${field.label}: "${trimmed}" is not an allowed value`,
        code: "type_mismatch",
      };
    }
  } else if (
    field.type === "channel" ||
    field.type === "role" ||
    field.type === "user"
  ) {
    if (!/^[0-9]{17,20}$/.test(trimmed)) {
      return {
        key: field.key,
        message: `${field.label} must be a Discord snowflake`,
        code: "type_mismatch",
      };
    }
  }
  // String-type length bounds
  if (STRING_TYPES.has(field.type)) {
    if (field.min !== undefined && trimmed.length < field.min) {
      return {
        key: field.key,
        message: `${field.label} must be at least ${field.min} characters`,
        code: "length",
      };
    }
    if (field.max !== undefined && trimmed.length > field.max) {
      return {
        key: field.key,
        message: `${field.label} must be at most ${field.max} characters`,
        code: "length",
      };
    }
  }
  // Pattern (applies to text/textarea/url/regex)
  if (
    field.pattern !== undefined &&
    (field.type === "text" ||
      field.type === "textarea" ||
      field.type === "url" ||
      field.type === "regex")
  ) {
    try {
      const re = new RegExp(field.pattern);
      if (!re.test(trimmed)) {
        return {
          key: field.key,
          message: `${field.label} does not match the required pattern`,
          code: "pattern",
        };
      }
    } catch {
      // Schema validation should have caught this at register time;
      // treat as silently passing rather than blocking an admin save.
    }
  }
  return null;
}

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
    const err = validateOneValue(field, raw);
    if (err) {
      errors.push(err);
    } else {
      accepted.push(field.key);
    }
  }
  return { ok: errors.length === 0, errors, accepted, skipped };
}
