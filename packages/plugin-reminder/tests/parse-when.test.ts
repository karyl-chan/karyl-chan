import assert from "node:assert/strict";
import test from "node:test";
import { DUE_DIGITS } from "../src/key-format.js";
import { parseWhen } from "../src/parse-when.js";

const NOW = 1_700_000_000_000; // fixed ms (≈2023), a 13-digit timestamp

test("parses simple durations", () => {
  assert.equal(parseWhen("10m", NOW), NOW + 600_000);
  assert.equal(parseWhen("2h", NOW), NOW + 7_200_000);
  assert.equal(parseWhen("1d", NOW), NOW + 86_400_000);
  assert.equal(parseWhen("30 sec", NOW), NOW + 30_000);
});

test("rejects unparseable / non-positive / bad-unit input", () => {
  assert.equal(parseWhen("abc", NOW), null);
  assert.equal(parseWhen("0m", NOW), null);
  assert.equal(parseWhen("5x", NOW), null);
  assert.equal(parseWhen("", NOW), null);
});

test("rejects an absurd duration that would overflow the 13-digit sort key", () => {
  // Pre-fix this returned ~1.5e21, whose String() is exponential ("1.5e+21");
  // that key sorts ahead of real reminders and starves the scheduler's scan
  // window, so legitimately-due reminders silently never fire.
  assert.equal(parseWhen("999999999999999d", NOW), null);
});

test("rejects a duration past the year-2286 (1e13 ms) boundary", () => {
  assert.notEqual(parseWhen("99999d", 0), null); // ≈8.64e12 < 1e13 → accepted
  assert.equal(parseWhen("200000d", 0), null); // ≈1.728e13 ≥ 1e13 → rejected
});

test(`every accepted dueAtMs is a <=${DUE_DIGITS}-digit decimal (the key invariant)`, () => {
  const widthRe = new RegExp(`^\\d{1,${DUE_DIGITS}}$`);
  for (const input of ["1m", "90d", "365d", "1000d", "9999d"]) {
    const due = parseWhen(input, NOW);
    assert.notEqual(due, null);
    const s = String(due);
    assert.match(s, widthRe); // decimal only, no exponent, <=DUE_DIGITS digits
    assert.equal(s.padStart(DUE_DIGITS, "0").length, DUE_DIGITS); // fixed-width key
  }
});
