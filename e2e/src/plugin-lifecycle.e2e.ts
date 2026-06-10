/**
 * PM-2.1 — Core path 3: plugin lifecycle E2E.
 *
 *   register → heartbeat-credentialed RPC → command sync state →
 *   admin enable → signed dispatch → handler → bot-side KV →
 *   read-back → graceful stop
 *
 * REAL components end to end, over real HTTP:
 *   - the bot: spawned as a child process from its compiled build
 *     (BOT_SKIP_DISCORD=true, Postgres via DB_URL, NO owner ids so the
 *     dev unauth bypass grants the harness admin API access)
 *   - the plugin: a real `definePlugin().start()` from the SDK's
 *     compiled dist, registering with a setup secret minted through
 *     the real admin endpoint
 *   - the dispatch: HMAC-signed exactly like the bot signs it, using
 *     the per-plugin key the register handshake returned
 *
 * What this proves that unit tests can't: the two services' production
 * code agrees over a real socket on the whole onboarding journey an
 * external plugin author walks (the 2026-06-11 incident path), incl.
 * PM-7 semantics: ready gating with botMode=skipped, register
 * answering fast with commandSync deferred, and the enable-after-
 * register step.
 *
 * GATED behind TEST_E2E_DB_URL (a Postgres URL — sqlite is NOT usable
 * here: the host-run bot would need the sqlite3 native binding, which
 * is glibc-sensitive; pg is pure-wire). See e2e/README.md to run.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

const DB_URL = process.env.TEST_E2E_DB_URL;

// Walk up from the COMPILED file's location (e2e/dist/src/…) until the
// workspace root — a fixed "../.." breaks the moment the build layout
// nests differently than the source layout.
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
const SDK_DIST = path.join(REPO, "packages", "plugin-sdk", "dist", "index.js");

const PLUGIN_KEY = "e2e-lifecycle";
const GUILD_ID = "900000000000000001";

// ─── Small utilities ─────────────────────────────────────────────────────────

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
    `timed out waiting for ${what}` + (lastErr ? `; last error: ${String(lastErr)}` : ""),
  );
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ─── Structural types for the dynamically-imported SDK ──────────────────────

interface StartedPluginLike {
  stop(): Promise<void>;
  getDispatchHmacKey(): string | null;
  kv: {
    guild(guildId: string): {
      get(key: string): Promise<unknown>;
    };
  };
  me: { enabledGuilds(): Promise<unknown> };
}

describe("plugin lifecycle E2E (PM-2.1, path 3)", { skip: !DB_URL }, () => {
  let bot: ChildProcess | null = null;
  let botLog = "";
  let botPort = 0;
  let pluginPort = 0;
  let started: StartedPluginLike | null = null;
  let botUrl = "";

  before(async () => {
    botPort = await freePort();
    pluginPort = await freePort();
    botUrl = `http://127.0.0.1:${botPort}`;

    bot = spawn(process.execPath, [BOT_MAIN], {
      cwd: path.join(REPO, "packages", "bot"),
      env: {
        // Deliberately NOT inheriting the full host env — a stray
        // BOT_OWNER_IDS would disable the dev bypass and dead-end the
        // harness at 401s.
        PATH: process.env.PATH ?? "",
        NODE_ENV: "development",
        BOT_SKIP_DISCORD: "true",
        BOT_TOKEN: "e2e.placeholder",
        ENCRYPTION_KEY:
          "0000000000000000000000000000000000000000000000000000000000000000",
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

    // Readiness gates on db + bot signal; in skip mode the bot signal
    // is satisfied without a gateway and announced as botMode=skipped
    // (PM-7.5). A failure here usually means the bot build is stale —
    // `pnpm --filter @karyl-chan/bot build` first.
    await until("bot /api/health/ready", async () => {
      const r = await getJson(`${botUrl}/api/health/ready`);
      if (r.status !== 200) return null;
      const checks = (r.body as { checks?: { botMode?: string } }).checks;
      assert.equal(checks?.botMode, "skipped", "ready implies botMode=skipped");
      return r;
    });
  });

  after(async () => {
    if (started) await started.stop().catch(() => undefined);
    if (bot && bot.exitCode === null) {
      const exited = new Promise<void>((resolve) => bot?.once("exit", () => resolve()));
      bot.kill("SIGTERM");
      // Graceful shutdown must actually terminate — a hang here is a
      // drain-path regression.
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000));
      const result = await Promise.race([exited.then(() => "exited" as const), timeout]);
      if (result === "timeout") {
        bot.kill("SIGKILL");
        throw new Error(`bot did not exit within 15s of SIGTERM\n--- bot log tail ---\n${botLog.slice(-4000)}`);
      }
    }
  });

  it("walks the full register → enable → dispatch → KV round-trip", async (t) => {
    // 0. The Postgres volume persists across harness runs — drop any
    //    leftover row so this run's assertions can't pass off stale
    //    state from a previous run.
    {
      const r = await getJson(`${botUrl}/api/plugins`);
      const rows = (r.body as { plugins: Array<{ id: number; pluginKey: string }> })
        .plugins;
      const leftover = rows.find((p) => p.pluginKey === PLUGIN_KEY);
      if (leftover) {
        await fetch(`${botUrl}/api/plugins/${leftover.id}`, { method: "DELETE" });
      }
    }

    // 1. Admin mints the per-plugin setup secret (dev bypass = no auth).
    const mint = await postJson(`${botUrl}/api/plugins/setup-secret`, {
      pluginKey: PLUGIN_KEY,
    });
    assert.equal(mint.status, 200, `setup-secret: ${JSON.stringify(mint.body)}`);
    const setupSecret = (mint.body as { setupSecret: string }).setupSecret;
    assert.ok(setupSecret && setupSecret.length >= 32);

    // 2. A REAL SDK plugin starts and registers itself with that secret.
    const sdk = await import(SDK_DIST);
    const pluginUrl = `http://127.0.0.1:${pluginPort}`;
    const pingCommand = sdk.definePluginCommand({
      name: "e2e-ping",
      description: "E2E lifecycle probe",
      // V-06/V-07/V-08: scope, integration_types and contexts are all
      // mandatory in the bot's manifest validation.
      scope: "guild",
      integrationTypes: ["guild_install"],
      contexts: ["Guild"],
      async handler(ctx: {
        guildId: string | null;
        userId: string;
        kv: { guild(g: string): { set(k: string, v: unknown): Promise<void> } };
      }) {
        // Observable side effect THROUGH the bot: ctx.kv is a bot-side
        // RPC, so a successful write proves token + scope + RPC + DB.
        await ctx.kv.guild(ctx.guildId ?? GUILD_ID).set("ping", {
          from: ctx.userId,
          pong: true,
        });
        return { content: "pong", ephemeral: true };
      },
    });
    const plugin = sdk.definePlugin({
      key: PLUGIN_KEY,
      name: "E2E Lifecycle",
      version: "0.0.1",
      description: "Lifecycle E2E probe plugin",
      storage: { guildKv: true },
      rpcMethodsUsed: ["me.enabled_guilds"],
      pluginCommands: [pingCommand],
    });
    started = (await plugin.start({
      port: pluginPort,
      host: "127.0.0.1",
      botUrl,
      setupSecret,
      pluginUrl,
    })) as StartedPluginLike;

    // 3. Wait for the REGISTER, not just an active row — the
    //    secret-minting placeholder is already status=active, so the
    //    reliable register signals are (a) commandSync state (only this
    //    process's register populates it; it settles "ok" in skip mode
    //    because there is no Discord client to sync against) and (b)
    //    the row version flipping from the 0.0.0 placeholder to the
    //    manifest's. Register itself never waited on sync (PM-7.1).
    const row = await until("registered row (commandSync ok)", async () => {
      const r = await getJson(`${botUrl}/api/plugins`);
      if (r.status !== 200) return null;
      const rows = (r.body as { plugins: Array<Record<string, unknown>> }).plugins;
      const mine = rows.find((p) => p.pluginKey === PLUGIN_KEY);
      const sync = mine?.commandSync as { status?: string } | null | undefined;
      return mine && sync?.status === "ok" ? mine : null;
    }, 30_000);
    assert.equal(row.version, "0.0.1", "manifest version replaced placeholder");
    // Register must NOT flip an admin's enable switch (PM-7 docs:
    // "register ≠ enabled") — the minting placeholder starts disabled.
    assert.equal(row.enabled, false, "fresh registration stays disabled");

    // 4. Admin enables the plugin. (Ordering matters: plugin-token RPC
    //    is 403 "disabled or inactive" until this flips — verified by
    //    construction, the RPC below would fail if moved above.)
    const enable = await postJson(
      `${botUrl}/api/plugins/${row.id}/enabled`,
      { enabled: true },
    );
    assert.equal(enable.status, 200, `enable: ${JSON.stringify(enable.body)}`);

    // 5. Plugin-token RPC round-trip works (scope granted at register).
    const guilds = await (started as StartedPluginLike).me.enabledGuilds();
    assert.ok(Array.isArray(guilds), "me.enabledGuilds answers over RPC");

    // 6. Dispatch /commands/e2e-ping signed EXACTLY like the bot signs
    //    (METHOD:path:ts:nonce:body, x-karyl-* headers) with the
    //    per-plugin key from the register handshake.
    const dispatchKey = (started as StartedPluginLike).getDispatchHmacKey();
    assert.ok(dispatchKey, "plugin holds the dispatch HMAC key after register");
    const payload = JSON.stringify({
      command_name: "e2e-ping",
      interaction_id: "1",
      interaction_token: "e2e-fake-interaction-token",
      guild_id: GUILD_ID,
      channel_id: "900000000000000002",
      user: { id: "900000000000000003", username: "e2e" },
      options: [],
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const dispatchPath = "/commands/e2e-ping";
    // Nonced scheme (BH-2.4): <METHOD>:<path>:<ts>:<nonce>:<body>.
    const sig = createHmac("sha256", dispatchKey as string)
      .update(`POST:${dispatchPath}:${ts}:${nonce}:${payload}`)
      .digest("hex");
    const res = await fetch(`${pluginUrl}${dispatchPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-karyl-timestamp": ts,
        "x-karyl-nonce": nonce,
        "x-karyl-signature": sig,
      },
      body: payload,
    });
    // SDK acks the dispatch immediately (204) and the handler replies
    // out-of-band via interactions.respond — which will fail against a
    // fake interaction token, and that's fine; the KV write below is
    // the proof the handler ran.
    assert.equal(res.status, 204, `dispatch: HTTP ${res.status}`);

    // 7. The handler's bot-side KV write is observable from the plugin.
    const stored = await until("kv read-back of the handler's write", async () => {
      const v = await (started as StartedPluginLike).kv.guild(GUILD_ID).get("ping");
      return v && (v as { pong?: boolean }).pong === true ? v : null;
    }, 15_000);
    assert.equal((stored as { from: string }).from, "900000000000000003");

    // 8. Graceful stop deregisters; the bot marks the plugin inactive
    //    without waiting for the heartbeat reaper.
    await (started as StartedPluginLike).stop();
    started = null;
    await until("plugin row inactive after deregister", async () => {
      const r = await getJson(`${botUrl}/api/plugins`);
      const rows = (r.body as { plugins: Array<Record<string, unknown>> }).plugins;
      const mine = rows.find((p) => p.pluginKey === PLUGIN_KEY);
      return mine && mine.status === "inactive" ? mine : null;
    }, 20_000);

    t.diagnostic("full lifecycle verified: register → enable → dispatch → KV → deregister");
  });
});
