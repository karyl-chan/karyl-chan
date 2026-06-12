/**
 * PM-2.2 — Core paths 1 + 2: admin auth journey + builtin feature toggle.
 *
 *   path 1: login JWT → /api/auth/exchange → Bearer access token →
 *           dashboard reads → refresh rotation → logout revocation
 *   path 2: builtin feature enable (per-guild + operator default) →
 *           persisted state readable back
 *
 * Unlike the plugin-lifecycle suite this bot runs with REAL auth
 * (BOT_OWNER_IDS set): every admin route must 401 without a token, and
 * the whole session machinery (exchange, opaque access tokens, refresh
 * rotation with re-authorization, logout revocation) is exercised over
 * real HTTP against the production code.
 *
 * The one piece the harness fakes is the login-link MINT: in production
 * only the Discord admin-login behavior calls jwtService.sign(). The
 * signing authority itself is fully real — the bot persists its Ed25519
 * key (encrypted) in `jwt_signing_keys`, and this harness owns the same
 * Postgres + ENCRYPTION_KEY, so it decrypts the key and signs a
 * `purpose: login` JWT byte-compatible with what the DM behavior mints.
 * /api/auth/exchange then verifies it with the bot's own code path.
 *
 * GATED behind TEST_E2E_DB_URL (Postgres; see e2e/README.md).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  sign as cryptoSign,
} from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

const DB_URL = process.env.TEST_E2E_DB_URL;

function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`pnpm-workspace.yaml not found above ${from}`);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = findRepoRoot(HERE);
const BOT_MAIN = path.join(REPO, "packages", "bot", "build", "main.js");

const OWNER_ID = "910000000000000001";
const GUILD_ID = "910000000000000002";
const ENCRYPTION_KEY =
  "0000000000000000000000000000000000000000000000000000000000000000";

// ─── Utilities (same shapes as plugin-lifecycle.e2e.ts) ──────────────────────

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no address")));
      }
    });
  });
}

async function until<T>(
  what: string,
  fn: () => Promise<T | null>,
  timeoutMs = 90_000,
  stepMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== null) return v;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(
    `timed out waiting for ${what}` +
      (lastErr ? `; last error: ${String(lastErr)}` : ""),
  );
}

async function api(
  method: string,
  url: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ─── Login-JWT mint (mirrors jwt.service.ts + utils/crypto.ts) ───────────────

/** decryptSecret() v2 format: `v2:<keyId>:<ivB64>:<tagB64>:<ctB64>`, AES-256-GCM. */
function decryptV2(value: string, keyHex: string): string {
  const parts = value.split(":");
  assert.equal(parts.length, 5, `expected v2 ciphertext, got: ${value.slice(0, 12)}…`);
  const [version, keyId, ivB64, tagB64, ctB64] = parts;
  assert.equal(version, "v2");
  const keyBytes = Buffer.from(keyHex, "hex");
  const expectId = createHash("sha256").update(keyBytes).digest("hex").slice(0, 8);
  assert.equal(
    keyId,
    expectId,
    "signing key was sealed with a different ENCRYPTION_KEY — wipe the e2e DB volume",
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyBytes,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Sign a `purpose: login` JWT exactly like JwtService.sign (EdDSA/Ed25519). */
function mintLoginJwt(privateKeyB64Der: string, userId: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyB64Der, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const now = Date.now();
  const payload = {
    purpose: "login",
    userId,
    guildId: null,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + 5 * 60_000) / 1000),
  };
  const headerSeg = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const bodySeg = base64url(JSON.stringify(payload));
  const signingInput = `${headerSeg}.${bodySeg}`;
  const sig = base64url(
    cryptoSign(null, Buffer.from(signingInput, "utf-8"), privateKey),
  );
  return `${signingInput}.${sig}`;
}

/** Read the bot's active signing key from Postgres and decrypt it. */
async function loadSigningKey(dbUrl: string): Promise<string> {
  // Lazy import keeps the suite skippable without pg installed elsewhere.
  const { Client } = (await import("pg")) as typeof import("pg");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const res = await client.query(
      'SELECT "privateKeyEnc" FROM jwt_signing_keys WHERE active = true',
    );
    assert.equal(res.rows.length, 1, "exactly one active jwt signing key");
    return decryptV2(res.rows[0].privateKeyEnc as string, ENCRYPTION_KEY);
  } finally {
    await client.end();
  }
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("admin auth + builtin feature E2E (PM-2.2, paths 1+2)", { skip: !DB_URL }, () => {
  let bot: ChildProcess | null = null;
  let botLog = "";
  let botUrl = "";

  before(async () => {
    const botPort = await freePort();
    botUrl = `http://127.0.0.1:${botPort}`;
    bot = spawn(process.execPath, [BOT_MAIN], {
      cwd: path.join(REPO, "packages", "bot"),
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "development",
        BOT_SKIP_DISCORD: "true",
        BOT_TOKEN: "e2e.placeholder",
        // REAL auth mode — this is the point of the suite. The owner id
        // is the user the minted login JWT will claim.
        BOT_OWNER_IDS: OWNER_ID,
        ENCRYPTION_KEY,
        JWT_SECRET:
          "0000000000000000000000000000000000000000000000000000000000000000",
        DB_URL,
        WEB_PORT: String(botPort),
        WEB_HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    bot.stdout?.on("data", (c: Buffer) => (botLog += c.toString()));
    bot.stderr?.on("data", (c: Buffer) => (botLog += c.toString()));

    await until("bot /api/health/ready", async () => {
      const r = await api("GET", `${botUrl}/api/health/ready`);
      return r.status === 200 ? r : null;
    });
  });

  after(async () => {
    if (bot && bot.exitCode === null) {
      const exited = new Promise<void>((resolve) => bot?.once("exit", () => resolve()));
      bot.kill("SIGTERM");
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000));
      const result = await Promise.race([exited.then(() => "exited" as const), timeout]);
      if (result === "timeout") {
        bot.kill("SIGKILL");
        throw new Error(
          `bot did not exit within 15s of SIGTERM\n--- bot log tail ---\n${botLog.slice(-4000)}`,
        );
      }
    }
  });

  it("path 1: login JWT → exchange → Bearer dashboard reads → refresh → logout", async (t) => {
    // 0. With auth configured, the dashboard is closed to anonymous and
    //    garbage credentials alike.
    assert.equal((await api("GET", `${botUrl}/api/guilds`)).status, 401);
    assert.equal(
      (await api("GET", `${botUrl}/api/guilds`, undefined, "not-a-token")).status,
      401,
    );

    // 1. Mint the login link's JWT the way the admin-login behavior does,
    //    using the bot's own persisted signing key.
    const signingKey = await loadSigningKey(DB_URL!);
    const loginJwt = mintLoginJwt(signingKey, OWNER_ID);

    // A token for a NON-owner user must be rejected at exchange even
    // though its signature is valid (stage-2 authorization re-check).
    const stranger = mintLoginJwt(signingKey, "910000000000000999");
    assert.equal(
      (await api("POST", `${botUrl}/api/auth/exchange`, { token: stranger })).status,
      401,
    );

    // 2. Exchange the owner's JWT for session tokens.
    const exchange = await api("POST", `${botUrl}/api/auth/exchange`, {
      token: loginJwt,
    });
    assert.equal(exchange.status, 200, `exchange: ${JSON.stringify(exchange.body)}`);
    const tokens = exchange.body as {
      accessToken: string;
      refreshToken: string;
      accessExpiresAt: number;
      refreshExpiresAt: number;
    };
    assert.ok(tokens.accessToken && tokens.refreshToken);

    // 3. The dashboard's first loads answer under the Bearer token. With
    //    no gateway the guild list is legitimately empty — the assertion
    //    is the 200 + shape, not content.
    const guilds = await api("GET", `${botUrl}/api/guilds`, undefined, tokens.accessToken);
    assert.equal(guilds.status, 200);
    assert.ok(Array.isArray((guilds.body as { guilds: unknown[] }).guilds));
    const behaviors = await api(
      "GET",
      `${botUrl}/api/behaviors`,
      undefined,
      tokens.accessToken,
    );
    assert.equal(behaviors.status, 200);

    // 4. Refresh rotation: the new pair works, the OLD refresh token is
    //    single-use and must be dead after rotation.
    const refreshed = await api("POST", `${botUrl}/api/auth/refresh`, {
      refreshToken: tokens.refreshToken,
    });
    assert.equal(refreshed.status, 200);
    const rotated = refreshed.body as { accessToken: string; refreshToken: string };
    assert.equal(
      (
        await api("GET", `${botUrl}/api/guilds`, undefined, rotated.accessToken)
      ).status,
      200,
    );
    assert.equal(
      (
        await api("POST", `${botUrl}/api/auth/refresh`, {
          refreshToken: tokens.refreshToken,
        })
      ).status,
      401,
      "rotated-out refresh token must not mint again",
    );

    // 5. Logout revokes both presented credentials immediately.
    const logout = await fetch(`${botUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rotated.accessToken}`,
      },
      body: JSON.stringify({ refreshToken: rotated.refreshToken }),
    });
    assert.equal(logout.status, 204);
    assert.equal(
      (
        await api("GET", `${botUrl}/api/guilds`, undefined, rotated.accessToken)
      ).status,
      401,
      "access token must be dead after logout",
    );
    assert.equal(
      (
        await api("POST", `${botUrl}/api/auth/refresh`, {
          refreshToken: rotated.refreshToken,
        })
      ).status,
      401,
      "refresh token must be dead after logout",
    );

    t.diagnostic("real auth round-trip verified: 401 → exchange → reads → refresh → logout");
  });

  it("path 2: builtin feature toggle persists per-guild and as operator default", async (t) => {
    // Fresh session for this test (the previous one logged out).
    const signingKey = await loadSigningKey(DB_URL!);
    const exchange = await api("POST", `${botUrl}/api/auth/exchange`, {
      token: mintLoginJwt(signingKey, OWNER_ID),
    });
    assert.equal(exchange.status, 200);
    const { accessToken } = exchange.body as { accessToken: string };

    // Anonymous writes are rejected.
    assert.equal(
      (
        await api("PUT", `${botUrl}/api/bot-features/state/todo`, {
          guildId: GUILD_ID,
          enabled: true,
        })
      ).status,
      401,
    );

    // Per-guild enable. In skip mode the Discord command push can't reach
    // a guild — the contract under test is the persisted state the admin
    // UI reads back, which must not depend on Discord availability.
    const enable = await api(
      "PUT",
      `${botUrl}/api/bot-features/state/todo`,
      { guildId: GUILD_ID, enabled: true },
      accessToken,
    );
    assert.equal(enable.status, 200, `enable: ${JSON.stringify(enable.body)}`);

    // Operator default (guildId null) is a distinct row.
    const def = await api(
      "PUT",
      `${botUrl}/api/bot-features/state/picture-only`,
      { guildId: null, enabled: true },
      accessToken,
    );
    assert.equal(def.status, 200, `default: ${JSON.stringify(def.body)}`);

    interface FeatureState {
      featureKey: string;
      default: { enabled: boolean } | null;
      effectiveDefault: boolean;
      perGuild: Array<{ guildId: string; enabled: boolean }>;
    }
    const state = await api(
      "GET",
      `${botUrl}/api/bot-features/state`,
      undefined,
      accessToken,
    );
    assert.equal(state.status, 200);
    const features = (state.body as { features: FeatureState[] }).features;
    const todo = features.find((f) => f.featureKey === "todo");
    assert.ok(
      todo?.perGuild.some((g) => g.guildId === GUILD_ID && g.enabled),
      `todo per-guild row missing: ${JSON.stringify(todo)}`,
    );
    const pictureOnly = features.find((f) => f.featureKey === "picture-only");
    assert.ok(
      pictureOnly?.default?.enabled === true &&
        pictureOnly.effectiveDefault === true,
      `picture-only default row missing: ${JSON.stringify(pictureOnly)}`,
    );

    // Disable round-trips too (idempotent toggle, not write-once).
    const disable = await api(
      "PUT",
      `${botUrl}/api/bot-features/state/todo`,
      { guildId: GUILD_ID, enabled: false },
      accessToken,
    );
    assert.equal(disable.status, 200);
    const after = await api(
      "GET",
      `${botUrl}/api/bot-features/state`,
      undefined,
      accessToken,
    );
    const afterTodo = (after.body as { features: FeatureState[] }).features.find(
      (f) => f.featureKey === "todo",
    );
    assert.ok(
      afterTodo?.perGuild.some((g) => g.guildId === GUILD_ID && !g.enabled),
      "todo per-guild row should read back disabled",
    );

    // Unknown feature keys are rejected, not silently stored.
    assert.equal(
      (
        await api(
          "PUT",
          `${botUrl}/api/bot-features/state/not-a-feature`,
          { guildId: GUILD_ID, enabled: true },
          accessToken,
        )
      ).status,
      404,
    );

    t.diagnostic("builtin feature toggle verified: per-guild + operator default + disable + reject-unknown");
  });
});
