/**
 * #126 / #199 — service tokens and the JWKS. A self-hosted service fetches
 * GET /.well-known/jwks.json, checks the header `typ`, picks the key by the
 * token's `kid` (the key's RFC 7638 thumbprint), verifies the EdDSA
 * signature with plain Node crypto, then checks `aud`, `iss` and `exp`.
 * Service tokens and login tokens share the master key but never pass for
 * each other.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
  // The key store encrypts the private key at rest.
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import { createHash, createPublicKey, verify as cryptoVerify } from "crypto";
import { verifyPluginSession } from "@karyl-chan/plugin-sdk";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import {
  __resetAdaptersForTests,
  __setSessionStoreForTests,
} from "../src/adapters/registry.js";
import { AuthStore } from "../src/modules/web-core/auth-store.service.js";
import {
  getJwks,
  initJwtSigningAuthority,
  jwtService,
  rotateJwtSigningKey,
  type Jwks,
} from "../src/modules/web-core/jwt.service.js";
import { JWKS_PATH, registerJwksRoute } from "../src/modules/web-core/jwks-route.js";
import {
  getActiveJwtSigningKey,
  JwtSigningKey,
} from "../src/modules/web-core/models/jwt-signing-key.model.js";
import { publicBaseUrl } from "../src/modules/web-core/public-base-url.js";
import { mintServiceToken } from "../src/modules/web-core/service-token.js";
import { createWebServer } from "../src/modules/web-core/server.js";
import { RateLimiter } from "../src/utils/rate-limiter.js";

const OWNER_ID = "111111111111111111";
const USER = {
  id: "222222222222222222",
  name: "Karyl",
  avatar: "https://cdn.discordapp.com/avatars/222222222222222222/abc.png",
};

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf-8"));
}

/** RFC 7638 thumbprint of an Ed25519 SPKI PEM, computed independently. */
function thumbprintOf(pem: string): string {
  const { crv, kty, x } = createPublicKey(pem).export({ format: "jwk" });
  return createHash("sha256").update(JSON.stringify({ crv, kty, x })).digest("base64url");
}

function signatureVerifies(token: string, jwk: Jwks["keys"][number]): boolean {
  const [h, b, s] = token.split(".");
  const key = createPublicKey({ key: { ...jwk }, format: "jwk" });
  return cryptoVerify(null, Buffer.from(`${h}.${b}`), key, Buffer.from(s, "base64url"));
}

type ServiceCheck = { ok: true; claims: Record<string, unknown> } | { ok: false; reason: string };

/**
 * What a service does with a token, per the verification steps (#126).
 * `lenientKid` mimics libraries that fall back to the only key in the set
 * when the token names none — so the `typ` check, not this helper's
 * strictness about `kid`, is what keeps a login token out.
 */
function checkAsService(
  token: string,
  jwks: Jwks,
  expected: { aud: string; iss: string; now?: number; lenientKid?: boolean },
): ServiceCheck {
  const [h, b] = token.split(".");
  const header = decodeSegment(h);
  if (header.alg !== "EdDSA") return { ok: false, reason: "alg" };
  const jwk =
    typeof header.kid === "string"
      ? jwks.keys.find((k) => k.kid === header.kid)
      : expected.lenientKid && jwks.keys.length === 1
        ? jwks.keys[0]
        : undefined;
  if (!jwk) return { ok: false, reason: "kid" };
  if (!signatureVerifies(token, jwk)) return { ok: false, reason: "signature" };
  if (header.typ !== "karyl-service+jwt") return { ok: false, reason: "typ" };
  const claims = decodeSegment(b);
  if (claims.aud !== expected.aud) return { ok: false, reason: "aud" };
  if (claims.iss !== expected.iss) return { ok: false, reason: "iss" };
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= (expected.now ?? Date.now())) {
    return { ok: false, reason: "exp" };
  }
  return { ok: true, claims };
}

function verifyAsService(
  token: string,
  jwks: Jwks,
  expected: { aud: string; iss: string; now?: number },
): Record<string, unknown> | null {
  const result = checkAsService(token, jwks, expected);
  return result.ok ? result.claims : null;
}

let web: FastifyInstance;
let spaRoot: string;
let store: AuthStore;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  store = new AuthStore();
  __setSessionStoreForTests(store);
  // A static root, so the SPA not-found handler is live and would answer
  // any unregistered GET with index.html.
  spaRoot = mkdtempSync(join(tmpdir(), "karyl-jwks-"));
  writeFileSync(join(spaRoot, "index.html"), "<!doctype html><title>spa</title>");
  web = await createWebServer({ ownerIds: [OWNER_ID], staticRoot: spaRoot });
  await web.ready();
}, 60_000);

afterAll(async () => {
  await web.close();
  store.stop();
  __resetAdaptersForTests();
  rmSync(spaRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await JwtSigningKey.destroy({ where: {} });
  await initJwtSigningAuthority();
});

async function fetchJwks(): Promise<Jwks> {
  const res = await web.inject({ method: "GET", url: JWKS_PATH });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as Jwks;
}

describe("GET /.well-known/jwks.json", () => {
  it("is public JSON on the web server, not the SPA page", async () => {
    const res = await web.inject({ method: "GET", url: JWKS_PATH });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/jwk-set\+json/);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect(res.body).not.toContain("<!doctype html>");
    const active = await getActiveJwtSigningKey();
    expect(JSON.parse(res.body)).toEqual({
      keys: [
        {
          kty: "OKP",
          crv: "Ed25519",
          x: expect.any(String),
          kid: thumbprintOf(active!.publicKeyPem),
          alg: "EdDSA",
          use: "sig",
        },
      ],
    });
    // The admin API next to it still asks for a session.
    expect((await web.inject({ method: "GET", url: "/api/behaviors" })).statusCode).toBe(401);
  });

  it("is rate-limited per client", async () => {
    const server = Fastify({ logger: false });
    registerJwksRoute(server, { limiter: new RateLimiter({ windowMs: 60_000, max: 2 }) });
    await server.ready();
    try {
      const get = (ip: string) =>
        server.inject({ method: "GET", url: JWKS_PATH, remoteAddress: ip });
      expect((await get("198.51.100.1")).statusCode).toBe(200);
      expect((await get("198.51.100.1")).statusCode).toBe(200);
      expect((await get("198.51.100.1")).statusCode).toBe(429);
      expect((await get("198.51.100.2")).statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe("service tokens", () => {
  it("verify against the JWKS by kid, with every claim", async () => {
    const now = Date.now();
    const { token, jti, expiresAt } = mintServiceToken(USER, "wiki", { now });
    const header = decodeSegment(token.split(".")[0]);
    const active = await getActiveJwtSigningKey();
    expect(header).toEqual({
      alg: "EdDSA",
      typ: "karyl-service+jwt",
      kid: thumbprintOf(active!.publicKeyPem),
    });

    const claims = verifyAsService(token, await fetchJwks(), { aud: "wiki", iss: publicBaseUrl() });
    const iat = Math.floor(now / 1000);
    expect(claims).toEqual({
      sub: USER.id,
      name: USER.name,
      avatar: USER.avatar,
      aud: "wiki",
      iss: publicBaseUrl(),
      jti,
      iat,
      exp: iat + 120,
    });
    expect(expiresAt).toBe((iat + 120) * 1000);
  });

  it("are scoped to their audience and expire after 120 s", async () => {
    const now = Date.now();
    const { token } = mintServiceToken(USER, "wiki", { now });
    const jwks = await fetchJwks();
    expect(verifyAsService(token, jwks, { aud: "grafana", iss: publicBaseUrl() })).toBeNull();
    expect(
      verifyAsService(token, jwks, { aud: "wiki", iss: publicBaseUrl(), now: now + 121_000 }),
    ).toBeNull();
  });

  it("carry a fresh jti every time", () => {
    const a = mintServiceToken(USER, "wiki");
    const b = mintServiceToken(USER, "wiki");
    expect(a.jti).not.toBe(b.jti);
  });

  it("keep verifying after a rotation, while the old kid stays published for 24 h", async () => {
    const oldKid = jwtService.keyId();
    const { token: oldToken } = mintServiceToken(USER, "wiki");

    await rotateJwtSigningKey();
    const newKid = jwtService.keyId();
    expect(newKid).not.toBe(oldKid);
    expect(newKid).toBe(thumbprintOf((await getActiveJwtSigningKey())!.publicKeyPem));

    const jwks = await fetchJwks();
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual([oldKid, newKid].sort());
    expect(verifyAsService(oldToken, jwks, { aud: "wiki", iss: publicBaseUrl() })).not.toBeNull();
    const { token: newToken } = mintServiceToken(USER, "wiki");
    expect(verifyAsService(newToken, jwks, { aud: "wiki", iss: publicBaseUrl() })).not.toBeNull();

    const later = await getJwks({ now: Date.now() + 23 * 60 * 60 * 1000 });
    expect(later.keys.map((k) => k.kid)).toContain(oldKid);
    const dayAfter = await getJwks({ now: Date.now() + 25 * 60 * 60 * 1000 });
    expect(dayAfter.keys.map((k) => k.kid)).toEqual([newKid]);
  });
});

describe("service tokens and login tokens do not cross", () => {
  it("POST /api/auth/exchange refuses a service token", async () => {
    const { token } = mintServiceToken({ ...USER, id: OWNER_ID }, "wiki");
    const res = await web.inject({
      method: "POST",
      url: "/api/auth/exchange",
      payload: { token },
      remoteAddress: "198.51.100.20",
    });
    expect(res.statusCode).toBe(401);
    expect(jwtService.verify(token)).toBeNull();
  });

  it("POST /api/auth/exchange still takes a login token from the same key", async () => {
    const { token } = jwtService.sign({
      purpose: "login",
      userId: OWNER_ID,
      guildId: null,
      channelId: "dm",
      messageId: "m1",
      jti: "service-token-jwks-login",
    });
    const res = await web.inject({
      method: "POST",
      url: "/api/auth/exchange",
      payload: { token },
      remoteAddress: "198.51.100.21",
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().accessToken).toBe("string");
  });

  it("a login token fails a service's typ check, even when the JWKS has a single key", async () => {
    const { token } = jwtService.sign({
      purpose: "login",
      userId: USER.id,
      guildId: null,
      channelId: "dm",
      messageId: "m1",
    });
    const jwks = await fetchJwks();
    expect(jwks.keys).toHaveLength(1);
    // Same key, so the signature alone would pass …
    expect(signatureVerifies(token, jwks.keys[0])).toBe(true);
    // … and a lenient key lookup finds it; the explicit typ refuses it.
    expect(
      checkAsService(token, jwks, { aud: "wiki", iss: publicBaseUrl(), lenientKid: true }),
    ).toEqual({ ok: false, reason: "typ" });
    expect(verifyAsService(token, jwks, { aud: "wiki", iss: publicBaseUrl() })).toBeNull();
  });

  it("the SDK's plugin-session verifier refuses a service token, even against the master key", () => {
    const { token } = mintServiceToken(USER, "wiki");
    expect(verifyPluginSession(token, jwtService.publicKeyPem())).toBeNull();
  });
});
