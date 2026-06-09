/**
 * verifyWebhookToken must be an EXACT, constant-time compare. A regression
 * here (the previous zero-padding implementation) accepted the secret with
 * trailing NUL bytes appended, weakening token-mode webhook auth.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyWebhookToken } from "../src/webhook-token.js";

const SECRET = "super-secret-token-value";
const NUL = String.fromCharCode(0); // a real U+0000 byte

describe("verifyWebhookToken", () => {
  it("accepts the exact secret", () => {
    assert.equal(verifyWebhookToken(SECRET, SECRET), true);
  });

  it("rejects a wrong token", () => {
    assert.equal(verifyWebhookToken("wrong-token", SECRET), false);
  });

  it("rejects an absent or empty header", () => {
    assert.equal(verifyWebhookToken(undefined, SECRET), false);
    assert.equal(verifyWebhookToken("", SECRET), false);
  });

  it("rejects the secret with trailing NUL byte(s) (zero-pad regression)", () => {
    // The old zero-padding compare treated these as equal to SECRET.
    assert.equal(verifyWebhookToken(SECRET + NUL, SECRET), false);
    assert.equal(verifyWebhookToken(SECRET + NUL + NUL, SECRET), false);
  });

  it("rejects a longer value that shares the secret as a prefix", () => {
    assert.equal(verifyWebhookToken(SECRET + "extra", SECRET), false);
  });

  it("rejects a shorter prefix of the secret", () => {
    assert.equal(verifyWebhookToken(SECRET.slice(0, -1), SECRET), false);
  });
});
