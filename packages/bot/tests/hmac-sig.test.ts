import { describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import {
  signBody,
  buildOutboundSignatureHeaders,
  verifyInboundSignature,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
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
    [SIGNATURE_HEADER]: signBody(secret, method, path, ts, body),
  });
}

// ─── signBody ─────────────────────────────────────────────────────────────

describe("signBody", () => {
  it("produces the correct HMAC-SHA256 hex digest", () => {
    const expected = createHmac("sha256", SECRET)
      .update(`${METHOD}:${PATH}:${TS}:${BODY}`)
      .digest("hex");
    expect(signBody(SECRET, METHOD, PATH, TS, BODY)).toBe(expected);
  });

  it("same body + different method (POST vs PUT) → different sig", () => {
    const a = signBody(SECRET, "POST", PATH, TS, BODY);
    const b = signBody(SECRET, "PUT", PATH, TS, BODY);
    expect(a).not.toBe(b);
  });

  it("same body + different path (/foo vs /bar) → different sig", () => {
    const a = signBody(SECRET, METHOD, "/foo", TS, BODY);
    const b = signBody(SECRET, METHOD, "/bar", TS, BODY);
    expect(a).not.toBe(b);
  });

  it("different timestamp → different sig", () => {
    const a = signBody(SECRET, METHOD, PATH, TS, BODY);
    const b = signBody(SECRET, METHOD, PATH, "9999999999", BODY);
    expect(a).not.toBe(b);
  });

  it("different body → different sig", () => {
    const a = signBody(SECRET, METHOD, PATH, TS, BODY);
    const b = signBody(SECRET, METHOD, PATH, TS, "{}");
    expect(a).not.toBe(b);
  });

  it("method is normalised to uppercase", () => {
    expect(signBody(SECRET, "post", PATH, TS, BODY)).toBe(
      signBody(SECRET, "POST", PATH, TS, BODY),
    );
  });
});

// ─── buildOutboundSignatureHeaders ────────────────────────────────────────

describe("buildOutboundSignatureHeaders", () => {
  it("includes signature + timestamp headers", () => {
    const h = buildOutboundSignatureHeaders(SECRET, METHOD, PATH, BODY, TS);
    expect(h[TIMESTAMP_HEADER]).toBe(TS);
    expect(h[SIGNATURE_HEADER]).toBe(signBody(SECRET, METHOD, PATH, TS, BODY));
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
      [SIGNATURE_HEADER]: signBody(SECRET, METHOD, PATH, TS, BODY),
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
    const sig = signBody(SECRET, "POST", originalPath, TS, BODY);
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
    const sig = signBody(SECRET, "POST", PATH, TS, BODY);
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
