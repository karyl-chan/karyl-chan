import type { ManifestConfigField } from "./manifest.js";

/**
 * Config-field validity — the protocol half of config validation.
 *
 * Two questions, both answerable from the manifest alone:
 *   - `validateConfigSchema`: is the field *declaration* well-formed?
 *     (default's runtime type matches `type`, `pattern` compiles,
 *     min ≤ max). Runs at register time, on both sides of the wire.
 *   - `validateConfigValue`: does one incoming *value* satisfy its
 *     declaration?
 *
 * What is deliberately NOT here: the bot's admin-save orchestration —
 * accumulating every field error for the editor, the `"unchanged"`
 * secret sentinel, unknown-key policy. Those are bot↔frontend concerns
 * (see `packages/bot/src/modules/plugin-system/config-validator.ts`),
 * not part of the bot↔plugin wire.
 *
 * Pure functions, zero dependencies.
 */

/** Why a config field was rejected. */
export type ConfigFieldErrorCode =
  // Value-time
  | "required"
  | "type_mismatch"
  | "pattern"
  | "range"
  | "length"
  // Schema-time
  | "invalid_default"
  | "invalid_pattern"
  | "invalid_range";

export interface ConfigFieldError {
  key: string;
  message: string;
  code: ConfigFieldErrorCode;
}

/** Field types whose value is free text — `min`/`max` mean character
 *  length for these, not numeric bounds. */
const STRING_TYPES = new Set(["text", "textarea", "url", "regex", "secret"]);

/** Field types the `pattern` constraint applies to. */
const PATTERN_TYPES = new Set(["text", "textarea", "url", "regex"]);

function isNumericString(s: string): boolean {
  if (s.trim() === "") return false;
  const n = Number(s);
  return Number.isFinite(n);
}

// ─── Schema-time (register-time) ───────────────────────────────────────

/**
 * Validate a `config_schema` declaration block. Catches bad defaults,
 * malformed regex and inverted ranges at register time, so the bug
 * surfaces at plugin startup instead of when an admin first opens the
 * config editor and gets an unhelpful save error.
 *
 * Returns the FIRST error found (register-time is a single boolean
 * gate), or `null` when the block is clean.
 */
export function validateConfigSchema(
  schema: ManifestConfigField[],
): ConfigFieldError | null {
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

// ─── Value-time (save-time) ────────────────────────────────────────────

/**
 * Validate ONE field's incoming value against its declaration. Returns
 * `null` on pass. The value is always its string representation (the
 * admin UI submits everything as a string; booleans arrive as
 * `"true"`/`"false"`, numbers as decimal).
 *
 * An empty value is a *clear*: rejected only when the field is
 * `required`, and never subjected to the downstream type / length /
 * pattern checks.
 */
export function validateConfigValue(
  field: ManifestConfigField,
  rawValue: string,
): ConfigFieldError | null {
  const trimmed = rawValue.trim();
  const empty = trimmed.length === 0;

  if (field.required && empty) {
    return {
      key: field.key,
      message: `${field.label} is required`,
      code: "required",
    };
  }
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

  if (field.pattern !== undefined && PATTERN_TYPES.has(field.type)) {
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
      // `validateConfigSchema` rejects this at register time; if one
      // slipped through, treat it as passing rather than blocking a save.
    }
  }
  return null;
}
