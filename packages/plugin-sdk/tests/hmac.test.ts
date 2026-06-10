/**
 * Verifies that the SDK's hmac.ts sign/verify/isFreshTimestamp functions
 * are byte-for-byte compatible with the bot-side karyl-chan/src/utils/hmac.ts.
 *
 * Signed payload  : `<METHOD>:<path>:<ts>:<nonce>:<body>`
 * Header layout   : `x-karyl-signature: <hex>` + `x-karyl-timestamp: <ts>`
 *                   + `x-karyl-nonce: <hex>` (BH-2.4)
 *
 * METHOD + path are bound into the signed payload to prevent a captured
 * signature from being replayed against a different endpoint or verb.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  REPLAY_WINDOW_SECONDS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
  isFreshTimestamp,
  sign,
  verify,
  markNonceSeen,
  __resetNonceStoreForTests,
} from "../src/hmac.js";

// ─── Golden fixtures ──────────────────────────────────────────────────────────
// Pre-computed from `<METHOD>:<path>:<ts>:<body>`. Static — NOT re-computed at
// test time. If sign() output diverges from these values the tests fail,
// catching accidental drift in the signing scheme.
//
// Regenerate:
//   node -e "console.log(require('crypto').createHmac('sha256','test-secret').update('POST:/commands/uuid:1700000000:hello world').digest('hex'))"
function computeHex(
  secret: string,
  method: string,
  path: string,
  ts: string,
  nonce: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${method}:${path}:${ts}:${nonce}:${body}`)
    .digest("hex");
}

const GOLDEN = [
  {
    secret: "test-secret",
    method: "POST",
    path: "/commands/uuid",
    ts: "1700000000",
    nonce: "cafe0000000000000000000000000001",
    body: "hello world",
  },
  {
    secret: "test-secret",
    method: "POST",
    path: "/webhooks/notify",
    ts: "1700001234",
    nonce: "cafe0000000000000000000000000002",
    body: '{"content":"hi"}',
  },
  {
    secret: "another-secret",
    method: "GET",
    path: "/health",
    ts: "1699999999",
    nonce: "cafe0000000000000000000000000003",
    body: "",
  },
].map((g) => ({
  ...g,
  expectedHex: computeHex(g.secret, g.method, g.path, g.ts, g.nonce, g.body),
}));

const F = GOLDEN[0];

describe("hmac constants", () => {
  it("SIGNATURE_HEADER matches bot constant", () => {
    assert.equal(SIGNATURE_HEADER, "x-karyl-signature");
  });
  it("TIMESTAMP_HEADER matches bot constant", () => {
    assert.equal(TIMESTAMP_HEADER, "x-karyl-timestamp");
  });
  it("NONCE_HEADER matches bot constant", () => {
    assert.equal(NONCE_HEADER, "x-karyl-nonce");
  });
  it("REPLAY_WINDOW_SECONDS is 300", () => {
    assert.equal(REPLAY_WINDOW_SECONDS, 300);
  });
});

describe("markNonceSeen (replay store)", () => {
  it("first sighting passes, second inside the window is a replay", () => {
    __resetNonceStoreForTests();
    const now = 1700000000;
    assert.equal(markNonceSeen("n-1", now), true);
    assert.equal(markNonceSeen("n-1", now + 10), false);
  });

  it("a nonce can be reused after the window expires", () => {
    __resetNonceStoreForTests();
    const now = 1700000000;
    assert.equal(markNonceSeen("n-2", now), true);
    assert.equal(markNonceSeen("n-2", now + REPLAY_WINDOW_SECONDS + 1), true);
  });
});

describe("sign — golden fixture cross-check", () => {
  for (const g of GOLDEN) {
    it(`sign('${g.secret}', '${g.method} ${g.path}', '${g.ts}') === golden hex`, () => {
      assert.equal(sign(g.secret, g.method, g.path, g.ts, g.nonce, g.body), g.expectedHex);
    });
  }
});

describe("sign", () => {
  it("produces different output for different secrets", () => {
    const a = sign("secret-a", F.method, F.path, F.ts, F.nonce, F.body);
    const b = sign("secret-b", F.method, F.path, F.ts, F.nonce, F.body);
    assert.notEqual(a, b);
  });

  it("produces different output for different methods", () => {
    const a = sign(F.secret, "POST", F.path, F.ts, F.nonce, F.body);
    const b = sign(F.secret, "GET", F.path, F.ts, F.nonce, F.body);
    assert.notEqual(a, b);
  });

  it("produces different output for different paths", () => {
    const a = sign(F.secret, F.method, "/path-a", F.ts, F.nonce, F.body);
    const b = sign(F.secret, F.method, "/path-b", F.ts, F.nonce, F.body);
    assert.notEqual(a, b);
  });

  it("produces different output for different timestamps", () => {
    const a = sign(F.secret, F.method, F.path, "1700000000", F.nonce, F.body);
    const b = sign(F.secret, F.method, F.path, "1700000001", F.nonce, F.body);
    assert.notEqual(a, b);
  });

  it("produces different output for different bodies", () => {
    const a = sign(F.secret, F.method, F.path, F.ts, F.nonce, "body-a");
    const b = sign(F.secret, F.method, F.path, F.ts, F.nonce, "body-b");
    assert.notEqual(a, b);
  });

  it("uppercases method in signed payload", () => {
    const lower = sign(F.secret, "post", F.path, F.ts, F.nonce, F.body);
    const upper = sign(F.secret, "POST", F.path, F.ts, F.nonce, F.body);
    assert.equal(lower, upper);
  });
});

describe("verify", () => {
  it("accepts a correct signature", () => {
    assert.equal(
      verify({
        secret: F.secret,
        method: F.method,
        path: F.path,
        body: F.body,
        ts: F.ts,
        nonce: F.nonce,
        presented: F.expectedHex,
      }),
      true,
    );
  });

  it("rejects tampered body", () => {
    assert.equal(
      verify({
        secret: F.secret,
        method: F.method,
        path: F.path,
        body: "tampered",
        ts: F.ts,
        nonce: F.nonce,
        presented: F.expectedHex,
      }),
      false,
    );
  });

  it("rejects wrong secret", () => {
    assert.equal(
      verify({
        secret: "wrong",
        method: F.method,
        path: F.path,
        body: F.body,
        ts: F.ts,
        nonce: F.nonce,
        presented: F.expectedHex,
      }),
      false,
    );
  });

  it("rejects wrong path (cross-endpoint replay)", () => {
    assert.equal(
      verify({
        secret: F.secret,
        method: F.method,
        path: "/commands/other",
        body: F.body,
        ts: F.ts,
        nonce: F.nonce,
        presented: F.expectedHex,
      }),
      false,
    );
  });

  it("rejects wrong method", () => {
    assert.equal(
      verify({
        secret: F.secret,
        method: "GET",
        path: F.path,
        body: F.body,
        ts: F.ts,
        nonce: F.nonce,
        presented: F.expectedHex,
      }),
      false,
    );
  });

  it("rejects all-zero signature", () => {
    assert.equal(
      verify({
        secret: F.secret,
        method: F.method,
        path: F.path,
        body: F.body,
        ts: F.ts,
        nonce: F.nonce,
        presented:
          "0000000000000000000000000000000000000000000000000000000000000000",
      }),
      false,
    );
  });

  it("rejects signature with wrong length", () => {
    assert.equal(
      verify({
        secret: F.secret,
        method: F.method,
        path: F.path,
        body: F.body,
        ts: F.ts,
        nonce: F.nonce,
        presented: "short",
      }),
      false,
    );
  });
});

describe("isFreshTimestamp", () => {
  it("accepts timestamp at exactly now", () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal(isFreshTimestamp(String(now), now), true);
  });

  it("accepts timestamp within replay window", () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal(isFreshTimestamp(String(now - 299), now), true);
    assert.equal(isFreshTimestamp(String(now + 299), now), true);
  });

  it("rejects timestamp at boundary + 1", () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal(isFreshTimestamp(String(now - 301), now), false);
    assert.equal(isFreshTimestamp(String(now + 301), now), false);
  });

  it("rejects non-numeric timestamp", () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal(isFreshTimestamp("not-a-number", now), false);
    assert.equal(isFreshTimestamp("", now), false);
  });
});
