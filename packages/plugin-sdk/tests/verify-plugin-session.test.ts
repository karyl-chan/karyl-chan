/**
 * Verifies the SDK's verifyPluginSession() against EdDSA tokens shaped
 * exactly like the ones karyl-chan's PluginSessionTokenService emits:
 *   header  { alg: "EdDSA", typ: "JWT" }
 *   payload { purpose: "plugin-session", userId, guildId, capabilities, iat, exp }
 *   sig     Ed25519 over `${b64u(header)}.${b64u(payload)}`
 *
 * The bot signs with a private key; the plugin receives only the SPKI
 * PEM public key (via the register handshake) and verifies with it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generateKeyPairSync,
  createHmac,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import {
  verifyPluginSession,
  hasPluginCapability,
} from "../src/verify-plugin-session.js";

function b64u(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function makeToken(
  privateKey: KeyObject,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "EdDSA", typ: "JWT" },
): string {
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(payload));
  const sig = b64u(cryptoSign(null, Buffer.from(`${h}.${p}`, "utf-8"), privateKey));
  return `${h}.${p}.${sig}`;
}

function freshPayload(over: Record<string, unknown> = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    purpose: "plugin-session",
    userId: "user-1",
    guildId: "guild-1",
    capabilities: ["admin", "plugin:karyl-radio:webui.access"],
    iat: nowSec,
    exp: nowSec + 3600,
    ...over,
  };
}

describe("verifyPluginSession", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  it("accepts a well-formed token and returns its claims (PEM key)", () => {
    const token = makeToken(privateKey, freshPayload());
    assert.deepEqual(verifyPluginSession(token, pubPem), {
      userId: "user-1",
      guildId: "guild-1",
      capabilities: ["admin", "plugin:karyl-radio:webui.access"],
    });
  });

  it("accepts a KeyObject too, and a null guildId", () => {
    const token = makeToken(privateKey, freshPayload({ guildId: null }));
    assert.deepEqual(verifyPluginSession(token, publicKey), {
      userId: "user-1",
      guildId: null,
      capabilities: ["admin", "plugin:karyl-radio:webui.access"],
    });
  });

  it("rejects when no key is supplied", () => {
    const token = makeToken(privateKey, freshPayload());
    assert.equal(verifyPluginSession(token, null), null);
    assert.equal(verifyPluginSession(token, undefined), null);
    assert.equal(verifyPluginSession(token, ""), null);
  });

  it("rejects an expired token", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = makeToken(
      privateKey,
      freshPayload({ exp: nowSec - 10, iat: nowSec - 3610 }),
    );
    assert.equal(verifyPluginSession(token, pubPem), null);
  });

  it("rejects a token signed by a different key", () => {
    const other = generateKeyPairSync("ed25519").privateKey;
    const token = makeToken(other, freshPayload());
    assert.equal(verifyPluginSession(token, pubPem), null);
  });

  it("rejects a tampered payload", () => {
    const token = makeToken(privateKey, freshPayload());
    const [h, , s] = token.split(".");
    const forged = b64u(JSON.stringify(freshPayload({ capabilities: ["admin"] })));
    assert.equal(verifyPluginSession(`${h}.${forged}.${s}`, pubPem), null);
  });

  it("rejects a wrong purpose", () => {
    const token = makeToken(privateKey, freshPayload({ purpose: "login" }));
    assert.equal(verifyPluginSession(token, pubPem), null);
  });

  it("rejects alg:none", () => {
    const token = makeToken(privateKey, freshPayload(), { alg: "none", typ: "JWT" });
    assert.equal(verifyPluginSession(token, pubPem), null);
  });

  it("rejects an HS256 token forged with the public key PEM as the HMAC secret", () => {
    const payload = freshPayload({ userId: "attacker", capabilities: ["admin"] });
    const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const p = b64u(JSON.stringify(payload));
    const sig = b64u(createHmac("sha256", pubPem).update(`${h}.${p}`).digest());
    assert.equal(verifyPluginSession(`${h}.${p}.${sig}`, pubPem), null);
  });

  it("rejects garbage / wrong-shape input", () => {
    assert.equal(verifyPluginSession("not.a.jwt.at.all", pubPem), null);
    assert.equal(verifyPluginSession("only-one-segment", pubPem), null);
    assert.equal(verifyPluginSession("", pubPem), null);
  });
});

describe("hasPluginCapability", () => {
  it("matches the plugin-scoped token", () => {
    assert.equal(
      hasPluginCapability(["plugin:karyl-radio:webui.access"], "karyl-radio", "webui.access"),
      true,
    );
  });
  it("admin is a superuser bypass", () => {
    assert.equal(hasPluginCapability(["admin"], "karyl-radio", "webui.access"), true);
  });
  it("does not cross plugin boundaries", () => {
    assert.equal(
      hasPluginCapability(["plugin:other-plugin:webui.access"], "karyl-radio", "webui.access"),
      false,
    );
    assert.equal(hasPluginCapability([], "karyl-radio", "webui.access"), false);
  });
});
