import { describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import {
  signBody,
  buildOutboundSignatureHeaders,
  verifyInboundSignature,
  __resetNonceStoreForTests,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
  REPLAY_WINDOW_SECONDS,
} from "../src/utils/hmac.js";

const SECRET = "test-secret-for-hmac";
const TS = "1700000000";
const BODY = JSON.stringify({ hello: "world" });
const METHOD = "POST";
const PATH = "/dm/greet/dispatch";

function makeHeaders(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

function makeSigHeaders(
  secret: string,
  method: string,
  path: string,
  ts: string,
  body: string,
): Headers {
  return makeHeaders({
    [TIMESTAMP_HEADER]: ts,
    [SIGNATURE_HEADER]: signBody(secret, method, path, ts, null, body),
  });
}

// ─── signBody ─────────────────────────────────────────────────────────────

describe("signBody", () => {
  it("produces the correct HMAC-SHA256 hex digest", () => {
    const expected = createHmac("sha256", SECRET)
      .update(`${METHOD}:${PATH}:${TS}:${BODY}`)
      .digest("hex");
    expect(signBody(SECRET, METHOD, PATH, TS, null, BODY)).toBe(expected);
  });

  it("same body + different method (POST vs PUT) → different sig", () => {
    const a = signBody(SECRET, "POST", PATH, TS, null, BODY);
    const b = signBody(SECRET, "PUT", PATH, TS, null, BODY);
    expect(a).not.toBe(b);
  });

  it("same body + different path (/foo vs /bar) → different sig", () => {
    const a = signBody(SECRET, METHOD, "/foo", TS, null, BODY);
    const b = signBody(SECRET, METHOD, "/bar", TS, null, BODY);
    expect(a).not.toBe(b);
  });

  it("different timestamp → different sig", () => {
    const a = signBody(SECRET, METHOD, PATH, TS, null, BODY);
    const b = signBody(SECRET, METHOD, PATH, "9999999999", null, BODY);
    expect(a).not.toBe(b);
  });

  it("different body → different sig", () => {
    const a = signBody(SECRET, METHOD, PATH, TS, null, BODY);
    const b = signBody(SECRET, METHOD, PATH, TS, null, "{}");
    expect(a).not.toBe(b);
  });

  it("method is normalised to uppercase", () => {
    expect(signBody(SECRET, "post", PATH, TS, null, BODY)).toBe(
      signBody(SECRET, "POST", PATH, TS, null, BODY),
    );
  });
});

// ─── buildOutboundSignatureHeaders ────────────────────────────────────────

describe("buildOutboundSignatureHeaders", () => {
  it("includes signature + timestamp + nonce headers (BH-2.4)", () => {
    const h = buildOutboundSignatureHeaders(SECRET, METHOD, PATH, BODY, TS);
    expect(h[TIMESTAMP_HEADER]).toBe(TS);
    expect(h[NONCE_HEADER]).toMatch(/^[0-9a-f]{32}$/);
    expect(h[SIGNATURE_HEADER]).toBe(
      signBody(SECRET, METHOD, PATH, TS, h[NONCE_HEADER], BODY),
    );
  });

  it("defaults timestamp to roughly now when not supplied", () => {
    const before = Math.floor(Date.now() / 1000);
    const h = buildOutboundSignatureHeaders(SECRET, METHOD, PATH, BODY);
    const after = Math.floor(Date.now() / 1000);
    const ts = Number(h[TIMESTAMP_HEADER]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 1);
  });
});

// ─── verifyInboundSignature ────────────────────────────────────────────────

const NOW = Number(TS);

describe("verifyInboundSignature", () => {
  it("accepts a valid signed response", () => {
    const headers = makeSigHeaders(SECRET, METHOD, PATH, TS, BODY);
    const result = verifyInboundSignature(
      SECRET, headers, BODY, NOW, METHOD, PATH,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects when signature is wrong", () => {
    const headers = makeHeaders({
      [TIMESTAMP_HEADER]: TS,
      [SIGNATURE_HEADER]: "badhex",
    });
    const result = verifyInboundSignature(
      SECRET, headers, BODY, NOW, METHOD, PATH,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/signature mismatch/);
  });

  it("rejects when signature header is missing", () => {
    const headers = makeHeaders({ [TIMESTAMP_HEADER]: TS });
    const result = verifyInboundSignature(
      SECRET, headers, BODY, NOW, METHOD, PATH,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Signature/);
  });

  it("rejects when timestamp is missing", () => {
    const headers = makeHeaders({
      [SIGNATURE_HEADER]: signBody(SECRET, METHOD, PATH, TS, null, BODY),
    });
    const result = verifyInboundSignature(
      SECRET, headers, BODY, NOW, METHOD, PATH,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Timestamp/);
  });

  it("rejects when timestamp is outside replay window", () => {
    const staleTs = (NOW - REPLAY_WINDOW_SECONDS - 1).toString();
    const headers = makeSigHeaders(SECRET, METHOD, PATH, staleTs, BODY);
    const result = verifyInboundSignature(
      SECRET, headers, BODY, NOW, METHOD, PATH,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/replay window/);
  });

  it("rejects cross-endpoint replay (different path)", () => {
    const originalPath = "/original-path";
    const sig = signBody(SECRET, "POST", originalPath, TS, null, BODY);
    const headers = makeHeaders({
      [TIMESTAMP_HEADER]: TS,
      [SIGNATURE_HEADER]: sig,
    });
    const result = verifyInboundSignature(
      SECRET, headers, BODY, NOW, "POST", "/other-path",
    );
    expect(result.ok).toBe(false);
  });

  it("rejects cross-method replay (different verb)", () => {
    const sig = signBody(SECRET, "POST", PATH, TS, null, BODY);
    const headers = makeHeaders({
      [TIMESTAMP_HEADER]: TS,
      [SIGNATURE_HEADER]: sig,
    });
    const result = verifyInboundSignature(
      SECRET, headers, BODY, NOW, "PUT", PATH,
    );
    expect(result.ok).toBe(false);
  });
});

// ─── nonce format（BH-2.4）────────────────────────────────────────────────

describe("verifyInboundSignature — nonce", () => {
  const NONCE = "00112233445566778899aabbccddeeff";

  function noncedHeaders(nonce: string): Headers {
    return makeHeaders({
      [TIMESTAMP_HEADER]: TS,
      [NONCE_HEADER]: nonce,
      [SIGNATURE_HEADER]: signBody(SECRET, METHOD, PATH, TS, nonce, BODY),
    });
  }

  it("accepts the nonced format and rejects a replay of the same nonce", () => {
    __resetNonceStoreForTests();
    const first = verifyInboundSignature(
      SECRET, noncedHeaders(NONCE), BODY, NOW, METHOD, PATH,
      { requireNonce: true },
    );
    expect(first.ok).toBe(true);
    const replay = verifyInboundSignature(
      SECRET, noncedHeaders(NONCE), BODY, NOW, METHOD, PATH,
      { requireNonce: true },
    );
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toMatch(/replayed/);
  });

  it("requireNonce rejects a nonce-less request", () => {
    const headers = makeSigHeaders(SECRET, METHOD, PATH, TS, BODY);
    const result = verifyInboundSignature(
      SECRET, headers, BODY, NOW, METHOD, PATH,
      { requireNonce: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Nonce/);
  });

  it("legacy (nonce-less) responses still verify when nonce not required", () => {
    const headers = makeSigHeaders(SECRET, METHOD, PATH, TS, BODY);
    const result = verifyInboundSignature(
      SECRET, headers, BODY, NOW, METHOD, PATH,
    );
    expect(result.ok).toBe(true);
  });

  it("a nonced response uses the new format even when not required", () => {
    __resetNonceStoreForTests();
    const result = verifyInboundSignature(
      SECRET, noncedHeaders(NONCE), BODY, NOW, METHOD, PATH,
    );
    expect(result.ok).toBe(true);
  });
});
