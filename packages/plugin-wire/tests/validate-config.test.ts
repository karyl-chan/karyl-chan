import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateConfigSchema,
  validateConfigValue,
  type ManifestConfigField,
} from "../src/index.js";

function field(over: Partial<ManifestConfigField> = {}): ManifestConfigField {
  return { key: "k", type: "text", label: "K", ...over };
}

// ─── Schema-time: is the declaration itself well-formed? ───────────────

test("a clean schema yields no error", () => {
  assert.equal(
    validateConfigSchema([
      field(),
      field({ key: "n", type: "number", default: 3, min: 1, max: 10 }),
      field({ key: "b", type: "boolean", default: false }),
      field({ key: "p", type: "text", pattern: "^[a-z]+$" }),
    ]),
    null,
  );
});

test("default's runtime type must match the field type", () => {
  const bad = validateConfigSchema([
    field({ key: "n", type: "number", default: "3" }),
  ]);
  assert.equal(bad?.code, "invalid_default");
  assert.equal(bad?.key, "n");
  assert.match(bad!.message, /default value type string does not match field type "number"/);

  assert.equal(
    validateConfigSchema([field({ key: "b", type: "boolean", default: "true" })])
      ?.code,
    "invalid_default",
  );
  assert.equal(
    validateConfigSchema([field({ key: "t", type: "text", default: 1 })])?.code,
    "invalid_default",
  );
  // select / channel / url / secret / regex all take a string default.
  assert.equal(
    validateConfigSchema([field({ key: "s", type: "select", default: "a" })]),
    null,
  );
});

test("null / absent defaults are always fine", () => {
  assert.equal(
    validateConfigSchema([
      field({ key: "n", type: "number", default: null }),
      field({ key: "m", type: "number" }),
    ]),
    null,
  );
});

test("pattern must compile", () => {
  const err = validateConfigSchema([field({ key: "p", pattern: "([" })]);
  assert.equal(err?.code, "invalid_pattern");
  assert.match(err!.message, /pattern is not a valid regex/);
});

test("min must not exceed max", () => {
  const err = validateConfigSchema([
    field({ key: "r", type: "number", min: 10, max: 1 }),
  ]);
  assert.equal(err?.code, "invalid_range");
  assert.match(err!.message, /min \(10\) cannot exceed max \(1\)/);
  // Only checked when BOTH bounds are present.
  assert.equal(validateConfigSchema([field({ key: "r", min: 10 })]), null);
});

test("the first offending field wins (register-time is one boolean gate)", () => {
  const err = validateConfigSchema([
    field({ key: "first", pattern: "([" }),
    field({ key: "second", type: "number", default: "x" }),
  ]);
  assert.equal(err?.key, "first");
});

// ─── Value-time: does an incoming value satisfy the declaration? ───────

test("required + empty fails; optional + empty passes untouched", () => {
  const req = field({ required: true, label: "Name" });
  const err = validateConfigValue(req, "   ");
  assert.equal(err?.code, "required");
  assert.match(err!.message, /Name is required/);

  assert.equal(validateConfigValue(field(), ""), null);
  assert.equal(validateConfigValue(field(), "   "), null);
});

test("empty values skip every downstream check", () => {
  // A clear on a pattern-constrained optional field must not be rejected
  // by the pattern — clearing is how an admin unsets a value.
  assert.equal(validateConfigValue(field({ pattern: "^[a-z]+$" }), ""), null);
});

test("number: parses and honours min / max", () => {
  const f = field({ type: "number", min: 1, max: 10, label: "Count" });
  assert.equal(validateConfigValue(f, "5"), null);
  assert.equal(validateConfigValue(f, "abc")?.code, "type_mismatch");
  assert.equal(validateConfigValue(f, "0")?.code, "range");
  assert.equal(validateConfigValue(f, "11")?.code, "range");
});

test("boolean: only the literal strings true / false", () => {
  const f = field({ type: "boolean" });
  assert.equal(validateConfigValue(f, "true"), null);
  assert.equal(validateConfigValue(f, "false"), null);
  assert.equal(validateConfigValue(f, "1")?.code, "type_mismatch");
  assert.equal(validateConfigValue(f, "TRUE")?.code, "type_mismatch");
});

test("url: must parse", () => {
  const f = field({ type: "url" });
  assert.equal(validateConfigValue(f, "https://a.test/x"), null);
  assert.equal(validateConfigValue(f, "not a url")?.code, "type_mismatch");
});

test("regex: the value itself must compile", () => {
  const f = field({ type: "regex" });
  assert.equal(validateConfigValue(f, "^ab+$"), null);
  assert.equal(validateConfigValue(f, "([")?.code, "type_mismatch");
});

test("select: value must be one of the declared options", () => {
  const f = field({
    type: "select",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
  });
  assert.equal(validateConfigValue(f, "a"), null);
  assert.equal(validateConfigValue(f, "c")?.code, "type_mismatch");
  // No options declared ⇒ nothing is allowed.
  assert.equal(validateConfigValue(field({ type: "select" }), "a")?.code, "type_mismatch");
});

test("channel / role / user: Discord snowflakes only", () => {
  for (const type of ["channel", "role", "user"] as const) {
    const f = field({ type });
    assert.equal(validateConfigValue(f, "123456789012345678"), null);
    assert.equal(validateConfigValue(f, "12345")?.code, "type_mismatch");
    assert.equal(validateConfigValue(f, "not-a-snowflake")?.code, "type_mismatch");
  }
});

test("string types: min / max are character-length bounds", () => {
  const f = field({ type: "text", min: 2, max: 4, label: "Tag" });
  assert.equal(validateConfigValue(f, "ab"), null);
  const short = validateConfigValue(f, "a");
  assert.equal(short?.code, "length");
  assert.match(short!.message, /at least 2 characters/);
  const long = validateConfigValue(f, "abcde");
  assert.equal(long?.code, "length");
  assert.match(long!.message, /at most 4 characters/);
});

test("pattern applies to text / textarea / url / regex only", () => {
  const digits = { pattern: "^[0-9]+$" };
  for (const type of ["text", "textarea"] as const) {
    assert.equal(validateConfigValue(field({ type, ...digits }), "12"), null);
    assert.equal(
      validateConfigValue(field({ type, ...digits }), "ab")?.code,
      "pattern",
    );
  }
  // A select's pattern is inert — its options already close the set.
  assert.equal(
    validateConfigValue(
      field({
        type: "select",
        options: [{ value: "ab", label: "AB" }],
        ...digits,
      }),
      "ab",
    ),
    null,
  );
});

test("an uncompilable pattern does not block a save", () => {
  // Schema validation rejects this at register time; if one slipped
  // through, blocking every admin save on it helps nobody.
  assert.equal(validateConfigValue(field({ pattern: "([" }), "anything"), null);
});
