/**
 * PM-2.3 — Core paths 4 + 5: behavior webhook forward + DM inbox SSE.
 *
 *   path 4: behavior created over the admin API → test-fire → REAL
 *           HTTP POST to a webhook sink → auth headers per mode
 *           (none / token / hmac) → signed-response verification →
 *           [BEHAVIOR:END] sentinel handling
 *   path 5: synthetic DM → recordActivity → event bus → SSE frames on
 *           /api/dm/events → channel listed → reply fails CLEANLY
 *           without Discord
 *
 * The Discord-side legs of both paths (interactionCreate claiming for
 * path 4, gateway messageCreate for path 5) are unit-covered in
 * packages/bot/tests; what only an E2E can prove is the cross-service
 * webhook contract over a real socket (header signing on BOTH legs,
 * sentinel semantics, fail-closed response verification) and the
 * store → bus → SSE pipeline as wired in the real server.
 *
 * Webhook sink placement: assertExternalTarget unconditionally denies
 * loopback (deliberate SSRF posture, the bot itself lives there), so the
 * sink binds the host's non-loopback private address and the bot runs
 * with WEBHOOK_ALLOW_PRIVATE=true — the documented operator escape
 * hatch for exactly this "webhook on my own LAN" topology.
 *
 * GATED behind TEST_E2E_DB_URL (Postgres; see e2e/README.md).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { networkInterfaces } from "node:os";
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

const DM_CHANNEL_ID = "920000000000000001";
const DM_USER_ID = "920000000000000002";

/** First non-internal IPv4 — where the webhook sink must live (see header). */
function privateLanAddress(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  throw new Error(
    "no non-loopback IPv4 interface found — the webhook sink needs one (loopback is always denied by host policy)",
  );
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
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
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** The shared `<METHOD>:<path>:<ts>:<nonce>:<body>` HMAC-SHA256 scheme. */
function hmacSign(
  secret: string,
  method: string,
  urlPath: string,
  ts: string,
  nonce: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${method.toUpperCase()}:${urlPath}:${ts}:${nonce}:${body}`)
    .digest("hex");
}

// ─── Webhook sink ────────────────────────────────────────────────────────────

interface SinkHit {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface Sink {
  url(path: string): string;
  hits: SinkHit[];
  /** Next response: JSON body + optionally sign it with `secret`. */
  respondWith(body: unknown, opts?: { signWithSecret?: string }): void;
  close(): Promise<void>;
}

async function startSink(): Promise<Sink> {
  const address = privateLanAddress();
  const hits: SinkHit[] = [];
  let nextBody: unknown = { content: "" };
  let nextSignSecret: string | null = null;

  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const urlPath = new URL(req.url ?? "/", "http://sink").pathname;
      hits.push({
        path: urlPath,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf-8"),
      });
      const payload = JSON.stringify(nextBody);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (nextSignSecret) {
        // hmac-mode behaviors verify the RESPONSE fail-closed, with the
        // same scheme and the REQUEST's method+path as the bound context.
        const ts = String(Math.floor(Date.now() / 1000));
        const nonce = randomBytes(16).toString("hex");
        headers["x-karyl-timestamp"] = ts;
        headers["x-karyl-nonce"] = nonce;
        headers["x-karyl-signature"] = hmacSign(
          nextSignSecret,
          "POST",
          urlPath,
          ts,
          nonce,
          payload,
        );
      }
      res.writeHead(200, headers);
      res.end(payload);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, address, () => resolve());
  });
  const port = (server.address() as { port: number }).port;

  return {
    url: (p: string) => `http://${address}:${port}${p}`,
    hits,
    respondWith(body, opts) {
      nextBody = body;
      nextSignSecret = opts?.signWithSecret ?? null;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("behavior webhook + DM inbox E2E (PM-2.3, paths 4+5)", { skip: !DB_URL }, () => {
  let bot: ChildProcess | null = null;
  let botLog = "";
  let botUrl = "";
  let sink: Sink | null = null;
  const createdBehaviorIds: number[] = [];

  before(async () => {
    sink = await startSink();
    const botPort = await freePort();
    botUrl = `http://127.0.0.1:${botPort}`;
    bot = spawn(process.execPath, [BOT_MAIN], {
      cwd: path.join(REPO, "packages", "bot"),
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "development",
        BOT_SKIP_DISCORD: "true",
        BOT_TOKEN: "e2e.placeholder",
        // No BOT_OWNER_IDS: dev unauth bypass — required both for the
        // admin API calls and for the dev DM-inject route's gate.
        ENCRYPTION_KEY:
          "0000000000000000000000000000000000000000000000000000000000000000",
        JWT_SECRET:
          "0000000000000000000000000000000000000000000000000000000000000000",
        DB_URL,
        WEB_PORT: String(botPort),
        WEB_HOST: "127.0.0.1",
        // Documented escape hatch: the sink lives on the host's private
        // LAN address (loopback is denied unconditionally).
        WEBHOOK_ALLOW_PRIVATE: "true",
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
    // Behaviors persist in the shared e2e Postgres volume — sweep ours so
    // re-runs (and the slash-command name space) stay clean.
    for (const id of createdBehaviorIds) {
      await fetch(`${botUrl}/api/behaviors/${id}`, { method: "DELETE" }).catch(
        () => undefined,
      );
    }
    await sink?.close();
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

  async function createBehavior(
    suffix: string,
    extra: Record<string, unknown>,
  ): Promise<number> {
    const r = await api("POST", `${botUrl}/api/behaviors`, {
      title: `e2e webhook ${suffix}`,
      triggerType: "message_pattern",
      messagePatternKind: "startswith",
      messagePatternValue: `!e2e-${suffix}`,
      webhookUrl: sink!.url(`/hook/${suffix}`),
      ...extra,
    });
    assert.equal(r.status, 201, `create ${suffix}: ${JSON.stringify(r.body)}`);
    const id = (r.body as { behavior: { id: number } }).behavior.id;
    createdBehaviorIds.push(id);
    return id;
  }

  function testFire(id: number) {
    return api("POST", `${botUrl}/api/behaviors/${id}/test`);
  }

  it("path 4: forwards with no auth mode and relays the sink's content", async () => {
    const id = await createBehavior("none", {});
    sink!.respondWith({ content: "ok from sink" });

    const fired = await testFire(id);
    assert.equal(fired.status, 200, JSON.stringify(fired.body));
    const result = fired.body as {
      ok: boolean;
      relayContent: string;
      ended: boolean;
    };
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.relayContent, "ok from sink");
    assert.equal(result.ended, false);

    const hit = sink!.hits.at(-1)!;
    assert.equal(hit.path, "/hook/none");
    const payload = JSON.parse(hit.body) as {
      content: string;
      _meta: { test: boolean; behavior_id: number };
    };
    assert.equal(payload._meta.test, true);
    assert.equal(payload._meta.behavior_id, id);
    assert.ok(payload.content.includes("test fire"));
    assert.equal(hit.headers["x-plugin-webhook-token"], undefined);
    assert.equal(hit.headers["x-karyl-signature"], undefined);
  });

  it("path 4: token mode sends the shared secret header", async () => {
    const secret = randomBytes(16).toString("hex");
    const id = await createBehavior("token", {
      webhookAuthMode: "token",
      webhookSecret: secret,
    });
    sink!.respondWith({ content: "token ok" });

    const fired = await testFire(id);
    const result = fired.body as { ok: boolean; relayContent: string };
    assert.equal(result.ok, true, JSON.stringify(fired.body));
    assert.equal(result.relayContent, "token ok");

    const hit = sink!.hits.at(-1)!;
    assert.equal(hit.headers["x-plugin-webhook-token"], secret);
  });

  it("path 4: hmac mode signs the request, verifies the response fail-closed, and honors [BEHAVIOR:END]", async () => {
    const secret = randomBytes(16).toString("hex");
    const id = await createBehavior("hmac", {
      webhookAuthMode: "hmac",
      webhookSecret: secret,
    });

    // 1. Signed request reaches the sink; sink answers SIGNED with the
    //    END sentinel → ok, ended, sentinel stripped from the relay.
    sink!.respondWith(
      { content: "bye [BEHAVIOR:END]" },
      { signWithSecret: secret },
    );
    const fired = await testFire(id);
    const result = fired.body as {
      ok: boolean;
      relayContent: string;
      ended: boolean;
    };
    assert.equal(result.ok, true, JSON.stringify(fired.body));
    assert.equal(result.ended, true, "END sentinel must set ended");
    assert.equal(result.relayContent, "bye", "sentinel must be stripped");

    // Verify the bot's request signature like a webhook author would.
    const hit = sink!.hits.at(-1)!;
    const ts = hit.headers["x-karyl-timestamp"] as string;
    const nonce = hit.headers["x-karyl-nonce"] as string;
    const sig = hit.headers["x-karyl-signature"] as string;
    assert.ok(ts && nonce && sig, "hmac mode must send all three headers");
    assert.equal(
      sig,
      hmacSign(secret, "POST", "/hook/hmac", ts, nonce, hit.body),
      "request signature must verify with the shared scheme",
    );

    // 2. An UNSIGNED response in hmac mode must be rejected (fail closed).
    sink!.respondWith({ content: "unsigned imposter" });
    const rejected = await testFire(id);
    const verdict = rejected.body as { ok: boolean; error: string | null };
    assert.equal(verdict.ok, false, "unsigned response must not be trusted");
    assert.ok(verdict.error, "rejection carries a reason");
  });

  it("path 5: synthetic DM flows store → bus → SSE, and reply degrades cleanly", async (t) => {
    // Open the SSE stream FIRST so the injected events arrive live.
    const controller = new AbortController();
    const sse = await fetch(`${botUrl}/api/dm/events`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(sse.status, 200);
    const reader = sse.body!.getReader();
    let sseBuffer = "";
    const readLoop = (async () => {
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
        }
      } catch {
        // aborted at the end of the test — expected
      }
    })();

    try {
      // Inject a synthetic DM through the dev seam (real recordActivity +
      // real bus publish — the exact gateway-handler sequence).
      const inject = await api("POST", `${botUrl}/api/dm/dev/inject-message`, {
        channelId: DM_CHANNEL_ID,
        recipient: { id: DM_USER_ID, username: "e2e-dm-user" },
        message: { id: "920000000000000003", content: "hello from the e2e DM" },
      });
      assert.equal(inject.status, 200, JSON.stringify(inject.body));

      // Both frames the dashboard listens for must arrive on the wire.
      await until(
        "SSE channel-touched + message-created frames",
        async () =>
          sseBuffer.includes("event: channel-touched") &&
          sseBuffer.includes("event: message-created") &&
          sseBuffer.includes("hello from the e2e DM")
            ? true
            : null,
        15_000,
      );

      // The inbox list (the sidebar's source) shows the channel.
      const channels = await api("GET", `${botUrl}/api/dm/channels`);
      assert.equal(channels.status, 200);
      const listed = (channels.body as {
        channels: Array<{ id: string; lastMessagePreview: string | null }>;
      }).channels;
      const mine = listed.find((c) => c.id === DM_CHANNEL_ID);
      assert.ok(mine, "injected DM channel must be listed");

      // Admin reply needs Discord; without a gateway the channel can't be
      // fetched and the route must answer a clean 404 — not hang, not 500.
      const reply = await api(
        "POST",
        `${botUrl}/api/dm/channels/${DM_CHANNEL_ID}/messages`,
        { content: "can't reach Discord from here" },
      );
      assert.equal(reply.status, 404, JSON.stringify(reply.body));
    } finally {
      controller.abort();
      await readLoop;
    }

    t.diagnostic("DM pipeline verified: inject → store → bus → SSE → list; reply degrades to 404");
  });
});
