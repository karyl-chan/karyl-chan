/**
 * Behavior actions (#127): a plugin declares them with
 * `definePluginBehaviorAction`, `buildManifest` publishes them, and the
 * SDK serves `/behavior-actions/:actionKey`:
 *
 *   - the definition is checked at once (V-09 key, V-10 name /
 *     description, a handler); duplicates and the count at build (V-11,
 *     V-12)
 *   - the manifest carries `behavior_actions` and
 *     `endpoints.behavior_action`, and no extra `rpc_methods_used`
 *   - the route verifies the bot's HMAC, answers 204 and runs the
 *     handler; `ctx.reply` / `ctx.followup` (and a returned reply) call
 *     `interactions.respond` / `followup` with the run's callback token as
 *     Bearer — never the plugin's own token — on paths the contract lists
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { CONTRACT_FIXTURES } from "@karyl-chan/plugin-wire";

import { buildManifest } from "../src/manifest-builder.js";
import { definePluginBehaviorAction, type PluginConfig } from "../src/plugin.js";
import type { PluginBehaviorActionDefinition } from "../src/plugin.js";
import type { BehaviorActionContext } from "../src/types.js";
import { BEHAVIOR_ACTION_RPC_PATHS, createPluginServer } from "../src/server.js";
import { NONCE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, generateNonce, sign } from "../src/hmac.js";

const SECRET = "dispatch-secret";
const PLUGIN_TOKEN = "plugin-own-token";
const CALLBACK_TOKEN = "run-callback-token";

function action(over: Partial<PluginBehaviorActionDefinition> = {}): PluginBehaviorActionDefinition {
  return { key: "weather", name: "Weather", description: "Tells the weather", handler: () => {}, ...over };
}

// ── the definition ───────────────────────────────────────────────────────────

describe("definePluginBehaviorAction", () => {
  it("returns a well-formed definition unchanged", () => {
    const def = action();
    assert.equal(definePluginBehaviorAction(def), def);
  });

  it("refuses a bad key, name, description or handler, naming the rule", () => {
    assert.throws(() => definePluginBehaviorAction(action({ key: "Weather" })), /key "Weather" must match .*\(V-09\)/);
    assert.throws(() => definePluginBehaviorAction(action({ key: "a".repeat(33) })), /\(V-09\)/);
    assert.throws(() => definePluginBehaviorAction(action({ name: " " })), /'weather'\.name .*\(V-10\)/);
    assert.throws(() => definePluginBehaviorAction(action({ description: "d".repeat(201) })), /'weather'\.description .*\(V-10\)/);
    assert.throws(
      () => definePluginBehaviorAction(action({ handler: undefined as never })),
      /'weather'\.handler must be a function/,
    );
  });
});

// ── the manifest ─────────────────────────────────────────────────────────────

function cfg(over: Partial<PluginConfig> = {}): PluginConfig {
  return { key: "demo", name: "Demo", version: "1.0.0", ...over } as PluginConfig;
}

describe("buildManifest with behavior actions", () => {
  it("emits behavior_actions without handlers, and endpoints.behavior_action", () => {
    const m = buildManifest(
      cfg({ behaviorActions: [action(), action({ key: "remind", name: "Remind", description: "Sets a reminder" })] }),
      "http://demo:3000",
    );
    assert.deepEqual(m.behavior_actions, [
      { key: "weather", name: "Weather", description: "Tells the weather" },
      { key: "remind", name: "Remind", description: "Sets a reminder" },
    ]);
    assert.equal(m.endpoints?.behavior_action, "/behavior-actions/{action_key}");
    assert.equal(m.endpoints?.behavior_action, CONTRACT_FIXTURES.dispatchEnvelope.payloads.behavior_action.endpointTemplate);
  });

  it("adds no rpc_methods_used: the callback token is its own principal", () => {
    const without = buildManifest(cfg(), "http://demo:3000").rpc_methods_used;
    const withActions = buildManifest(cfg({ behaviorActions: [action()] }), "http://demo:3000").rpc_methods_used;
    assert.deepEqual(withActions, without);
  });

  it("omits both when no action is declared", () => {
    const m = buildManifest(cfg(), "http://demo:3000");
    assert.equal(m.behavior_actions, undefined);
    assert.equal(m.endpoints?.behavior_action, undefined);
  });

  it("refuses a duplicate key (V-11) and more than 25 actions (V-12)", () => {
    assert.throws(
      () => buildManifest(cfg({ behaviorActions: [action(), action()] }), "http://demo:3000"),
      /behavior_actions\[weather\]\.key is declared more than once \(V-11\)/,
    );
    assert.throws(
      () =>
        buildManifest(
          cfg({ behaviorActions: Array.from({ length: 26 }, (_, i) => action({ key: `a${i}` })) }),
          "http://demo:3000",
        ),
      /at most 25 allowed \(got 26\) \(V-12\)/,
    );
  });
});

// ── the route ────────────────────────────────────────────────────────────────

interface BotCall {
  path: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

let calls: BotCall[] = [];
let realFetch: typeof fetch;
/** Resolves when the bot has been called `n` times. */
let waitFor: (n: number) => Promise<void>;

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  waitFor = (n) =>
    calls.length >= n
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.push({ n, resolve }));
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      path: new URL(String(url)).pathname,
      authorization: headers.get("authorization"),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    for (const w of waiters) if (calls.length >= w.n) w.resolve();
    const followup = String(url).endsWith("interactions.followup");
    return new Response(JSON.stringify(followup ? { ok: true, id: "F1" } : { ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
});

function serverWith(actions: PluginBehaviorActionDefinition[]) {
  return createPluginServer({
    pluginKey: "demo",
    botUrl: "http://bot",
    getToken: () => PLUGIN_TOKEN,
    getDispatchHmacKey: () => SECRET,
    behaviorActions: actions,
  });
}

const callback = { token: CALLBACK_TOKEN, expires_at: "2026-11-10T00:15:00.000Z", api_base: "https://karyl.example" };
const user = { id: "U1", username: "mika", global_name: "Mika", discriminator: "0", avatar: null };

function commandPayload(actionKey = "weather"): Record<string, unknown> {
  return {
    action_key: actionKey,
    interaction_id: "I1",
    application_id: "A1",
    command_name: "weather",
    sub_command_name: null,
    sub_command_group: null,
    guild_id: "G1",
    channel_id: "C1",
    user,
    locale: "en-US",
    options: [{ name: "city", type: 3, value: "Taipei" }],
    behavior_id: 7,
    attachments: [],
    callback,
  };
}

function messagePayload(): Record<string, unknown> {
  return {
    action_key: "weather",
    user,
    message_id: "M1",
    channel_id: "C1",
    guild_id: null,
    behavior_id: 8,
    attachments: [],
    captures: ["Taipei"],
    callback,
  };
}

async function post(
  server: ReturnType<typeof serverWith>,
  path: string,
  payload: unknown,
  opts: { secret?: string } = {},
) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = generateNonce();
  return server.inject({
    method: "POST",
    url: path,
    headers: {
      "content-type": "application/json",
      [TIMESTAMP_HEADER]: ts,
      [NONCE_HEADER]: nonce,
      [SIGNATURE_HEADER]: sign(opts.secret ?? SECRET, "POST", path, ts, nonce, body),
    },
    payload: body,
  });
}

describe("POST /behavior-actions/:actionKey", () => {
  it("refuses a request the bot did not sign", async () => {
    let ran = false;
    const server = serverWith([action({ handler: () => void (ran = true) })]);
    try {
      const res = await post(server, "/behavior-actions/weather", commandPayload(), { secret: "not-the-key" });
      assert.equal(res.statusCode, 401);
      assert.equal(ran, false);
    } finally {
      await server.close();
    }
  });

  it("answers 204, then runs the handler; ctx.reply and ctx.followup use the callback token", async () => {
    let seen: BehaviorActionContext | null = null;
    let followupId: string | null = null;
    let finished!: () => void;
    const done = new Promise<void>((r) => (finished = r));
    const server = serverWith([
      action({
        handler: async (ctx) => {
          seen = ctx;
          await ctx.reply({ content: "Taipei: 24°C" });
          followupId = await ctx.followup({ content: "and rain later", ephemeral: true });
          finished();
        },
      }),
    ]);
    try {
      const res = await post(server, "/behavior-actions/weather", commandPayload());
      assert.equal(res.statusCode, 204);
      await done;

      assert.deepEqual(calls, [
        {
          path: "/api/plugin/interactions.respond",
          authorization: `Bearer ${CALLBACK_TOKEN}`,
          body: { content: "Taipei: 24°C" },
        },
        {
          path: "/api/plugin/interactions.followup",
          authorization: `Bearer ${CALLBACK_TOKEN}`,
          body: { content: "and rain later", ephemeral: true },
        },
      ]);
      assert.equal(followupId, "F1");
      const ctx = seen as unknown as BehaviorActionContext;
      assert.equal(ctx.actionKey, "weather");
      assert.equal(ctx.behaviorId, 7);
      assert.equal(ctx.trigger, "command");
      assert.equal(ctx.userId, "U1");
      assert.equal(ctx.userDisplayName, "Mika");
      assert.equal(ctx.guildId, "G1");
      assert.equal(ctx.channelId, "C1");
      assert.deepEqual((ctx.payload as { options: unknown }).options, [{ name: "city", type: 3, value: "Taipei" }]);
      // the paths the contract says a behavior action calls
      for (const c of calls) assert.ok(CONTRACT_FIXTURES.rpc.behaviorActionPathsCalledBySdk.includes(c.path), c.path);
    } finally {
      await server.close();
    }
  });

  it("sends a returned reply with the callback token; tells a message trigger from a command", async () => {
    let trigger: string | null = null;
    const server = serverWith([
      action({
        handler: (ctx) => {
          trigger = ctx.trigger;
          return { content: "done" };
        },
      }),
    ]);
    try {
      assert.equal((await post(server, "/behavior-actions/weather", messagePayload())).statusCode, 204);
      await waitFor(1);
      assert.equal(trigger, "message");
      assert.deepEqual(calls[0], {
        path: "/api/plugin/interactions.respond",
        authorization: `Bearer ${CALLBACK_TOKEN}`,
        body: { content: "done" },
      });
    } finally {
      await server.close();
    }
  });

  it("the plugin's own token is only for ctx.botRpc", async () => {
    const server = serverWith([
      action({
        handler: async (ctx) => {
          await ctx.botRpc("/api/plugin/storage.kv_get", { guild_id: "G1", key: "k" });
        },
      }),
    ]);
    try {
      await post(server, "/behavior-actions/weather", commandPayload());
      await waitFor(1);
      assert.equal(calls[0]!.authorization, `Bearer ${PLUGIN_TOKEN}`);
    } finally {
      await server.close();
    }
  });

  it("a handler that throws before replying answers with a generic private line", async () => {
    const server = serverWith([action({ handler: () => { throw new Error("boom"); } })]);
    try {
      await post(server, "/behavior-actions/weather", commandPayload());
      await waitFor(1);
      assert.equal(calls[0]!.path, "/api/plugin/interactions.respond");
      assert.equal(calls[0]!.authorization, `Bearer ${CALLBACK_TOKEN}`);
      assert.equal(calls[0]!.body.ephemeral, true);
      assert.doesNotMatch(String(calls[0]!.body.content), /boom/);
    } finally {
      await server.close();
    }
  });

  it("calls exactly the paths the contract lists for behavior actions", () => {
    assert.deepEqual(
      Object.values(BEHAVIOR_ACTION_RPC_PATHS).sort(),
      [...CONTRACT_FIXTURES.rpc.behaviorActionPathsCalledBySdk].sort(),
    );
  });

  it("a refused reply is logged as such: no fallback line, not a handler error", async () => {
    let threw: unknown = null;
    const server = serverWith([
      action({
        handler: async (ctx) => {
          try {
            await ctx.reply({ content: "too late" });
          } catch (err) {
            threw = err;
            throw err;
          }
        },
      }),
    ]);
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ path: new URL(String(url)).pathname, authorization: null, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("plugin token invalid or expired", { status: 401 });
    }) as typeof fetch;
    try {
      await post(server, "/behavior-actions/weather", commandPayload());
      for (let i = 0; i < 50 && threw === null; i++) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 30));
      assert.match(String(threw), /callback token expired/);
      // the refused reply only — no fallback attempt after it
      assert.equal(calls.length, 1);
    } finally {
      await server.close();
    }
  });

  it("a refused followup the handler caught does not hide a later bug: the fallback still goes out", async () => {
    const server = serverWith([
      action({
        handler: async (ctx) => {
          await ctx.followup({ content: "refused" }).catch(() => null);
          throw new Error("a real bug");
        },
      }),
    ]);
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, authorization: null, body: JSON.parse(String(init?.body ?? "{}")) });
      return path.endsWith("interactions.followup")
        ? new Response("refused", { status: 400 })
        : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await post(server, "/behavior-actions/weather", commandPayload());
      for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(
        calls.map((c) => c.path),
        ["/api/plugin/interactions.followup", "/api/plugin/interactions.respond"],
      );
      assert.equal(calls[1]!.body.ephemeral, true);
    } finally {
      await server.close();
    }
  });

  it("refuses an unknown action, a mismatched action_key and a missing callback token", async () => {
    const server = serverWith([action()]);
    try {
      assert.equal((await post(server, "/behavior-actions/nope", commandPayload("nope"))).statusCode, 404);
      const mismatch = await post(server, "/behavior-actions/weather", commandPayload("remind"));
      assert.equal(mismatch.statusCode, 400);
      assert.deepEqual(mismatch.json(), { error: "action_key mismatch" });
      const noToken = await post(server, "/behavior-actions/weather", { ...commandPayload(), callback: {} });
      assert.equal(noToken.statusCode, 400);
      assert.deepEqual(noToken.json(), { error: "missing callback.token" });
      assert.equal(calls.length, 0);
    } finally {
      await server.close();
    }
  });
});
