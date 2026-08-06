/**
 * The plugin RPC family's declared request parsing, observed over HTTP.
 *
 * Two things are pinned here, and both are inherited by every scope
 * family converted after `messages`:
 *
 *  1. a schema failure answers with the family's historical body shape
 *     — `{ error: "<message>" }` and a 400, not Fastify's default
 *     `{statusCode, error, message}`;
 *  2. a schema refuses what the hand-rolled `typeof` check refused. The
 *     interesting half is the one that is easy to lose silently: ajv's
 *     Fastify default coerces `12345` into `"12345"` for a
 *     `type: "string"` field, which would widen every converted route.
 *
 * Same harness as plugin-rpc-typing-reply.test.ts: mock the
 * Sequelize-backed reads and stub plugin auth, drive the real routes.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

// ── module-level mocks ──────────────────────────────────────────────────────

vi.mock("../src/modules/plugin-system/models/plugin.model.js", () => ({
  findPluginById: vi.fn(),
}));

vi.mock(
  "../src/modules/feature-toggle/models/plugin-guild-feature.model.js",
  () => ({
    findEnabledFeaturesByPluginGuild: vi.fn(),
    findFeatureRowsByPluginGuild: vi.fn(),
    findEnabledFeaturesByPluginGuildLegacy: vi.fn(),
    deleteFeatureRow: vi.fn(),
    findFeatureRow: vi.fn(),
    findFeatureRowsByGuild: vi.fn(),
    findFeatureRowsByPlugin: vi.fn(),
    upsertFeatureRow: vi.fn(),
    updateMetricsJson: vi.fn(),
    PluginGuildFeature: { destroy: vi.fn(), findAll: vi.fn() },
  }),
);

vi.mock(
  "../src/modules/feature-toggle/models/plugin-feature-default.model.js",
  () => ({
    findFeatureDefaultsByPlugin: vi.fn(),
    findAllFeatureDefaults: vi.fn(),
    upsertFeatureDefault: vi.fn(),
    PluginFeatureDefault: { destroy: vi.fn(), findAll: vi.fn() },
  }),
);

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
  setBotEventLogMetric: vi.fn(),
}));

vi.mock("../src/modules/bot-events/bot-event-dedup.js", () => ({
  shouldRecord: vi.fn(() => true),
}));

// ── imports after mocks ─────────────────────────────────────────────────────

import type { FastifyInstance } from "fastify";
import { createWebServer } from "../src/modules/web-core/server.js";
import { pluginAuthStore } from "../src/modules/plugin-system/plugin-auth.service.js";
import { findPluginById } from "../src/modules/plugin-system/models/plugin.model.js";
import { findFeatureRowsByPluginGuild } from "../src/modules/feature-toggle/models/plugin-guild-feature.model.js";
import { findFeatureDefaultsByPlugin } from "../src/modules/feature-toggle/models/plugin-feature-default.model.js";
import { featureReachResolver } from "../src/modules/feature-toggle/feature-reach-resolver.js";
import type { PluginGuildFeatureRow } from "../src/modules/feature-toggle/models/plugin-guild-feature.model.js";

// ── helpers ─────────────────────────────────────────────────────────────────

const PLUGIN_ID = 77;
const PLUGIN_KEY = "schema-plugin";
const GUILD_ID = "guild-123";
const CHANNEL_ID = "chan-456";
const SNOWFLAKE = "123456789012345678";
const GUILD_SNOWFLAKE = "222222222222222222";

const ALL_SCOPES = [
  "messages.send",
  "messages.send_dm",
  "messages.delete",
  "messages.edit",
  "messages.add_reaction",
  "messages.trigger_typing",
  "messages.get",
  "messages.fetch_history",
  "messages.remove_reaction",
];

function stubPluginAuth(scopes: string[] = ALL_SCOPES) {
  vi.spyOn(pluginAuthStore, "verify").mockReturnValue({
    pluginId: PLUGIN_ID,
    pluginKey: PLUGIN_KEY,
    scopes: new Set(scopes),
    expiresAt: Date.now() + 60_000,
  });
}

function stubActivePlugin() {
  (findPluginById as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: PLUGIN_ID,
    pluginKey: PLUGIN_KEY,
    enabled: true,
    status: "active",
    manifestJson: JSON.stringify({
      guild_features: [
        { key: "my-feature", name: "my-feature", enabled_by_default: false },
      ],
    }),
  });
}

function fakeFeatureRow(): PluginGuildFeatureRow {
  return {
    id: 1,
    pluginId: PLUGIN_ID,
    guildId: GUILD_ID,
    featureKey: "my-feature",
    enabled: true,
    configJson: "{}",
    metricsJson: "{}",
    updatedAt: new Date(),
  };
}

/** Open the per-guild feature gate so a well-formed send reaches Discord. */
function featureGateOpen() {
  featureReachResolver.clear();
  (
    findFeatureRowsByPluginGuild as ReturnType<typeof vi.fn>
  ).mockResolvedValue([fakeFeatureRow()]);
  (findFeatureDefaultsByPlugin as ReturnType<typeof vi.fn>).mockResolvedValue(
    [],
  );
}

function fakeChannel() {
  const send = vi
    .fn()
    .mockResolvedValue({ id: "msg-1", channelId: CHANNEL_ID });
  return {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    isTextBased: () => true,
    isDMBased: () => false,
    send,
    _send: send,
  };
}

/** REST surface for the guild-scoped message routes (get / fetch_history
 *  / remove_reaction), which talk to Discord directly rather than
 *  through a channel object. */
function fakeRest() {
  return {
    get: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeBot(channel: unknown, rest: ReturnType<typeof fakeRest>) {
  return {
    user: { id: "bot-1" },
    isReady: () => true,
    guilds: { cache: { size: 0 } },
    uptime: 0,
    channels: {
      fetch: vi.fn().mockResolvedValue(channel),
      // assertChannelInGuild's cache hit — the channel belongs to the
      // guild the guild-scoped routes are asked about.
      cache: {
        get: vi.fn().mockReturnValue({
          isDMBased: () => false,
          guildId: GUILD_SNOWFLAKE,
        }),
      },
    },
    rest,
  };
}

describe("plugin RPC schema errors", () => {
  let server: FastifyInstance;
  let channel: ReturnType<typeof fakeChannel>;
  let rest: ReturnType<typeof fakeRest>;

  beforeEach(async () => {
    vi.clearAllMocks();
    stubPluginAuth();
    stubActivePlugin();
    featureGateOpen();
    channel = fakeChannel();
    rest = fakeRest();
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(channel, rest) as never,
    });
    await server.ready();
    featureGateOpen();
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  function post(url: string, payload?: unknown) {
    return server.inject({
      method: "POST",
      url,
      headers: { authorization: "Bearer fake-token" },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
  }

  // ── the body shape every later family inherits ────────────────────────────

  it("answers a missing required field with the family's own error body", async () => {
    const res = await post("/api/plugin/messages.trigger_typing", {});
    expect(res.statusCode).toBe(400);
    // Not Fastify's {statusCode, error, message}: exactly the one-key
    // body the hand-rolled checks sent, with the same message.
    expect(res.json()).toEqual({ error: "channel_id required" });
  });

  it("still names channel_id when only that is missing", async () => {
    const res = await post("/api/plugin/messages.send", { content: "hi" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "channel_id required" });
  });

  it("names the offending field on a type failure", async () => {
    // The old guard here answered "channel_id + message_id + emoji
    // required" whichever of the three was wrong. Same status, same
    // shape, one field named.
    const res = await post("/api/plugin/messages.add_reaction", {
      channel_id: CHANNEL_ID,
      message_id: SNOWFLAKE,
      emoji: 5,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "emoji must be string" });
  });

  it("renders the snowflake pattern as something a plugin author can act on", async () => {
    const res = await post("/api/plugin/messages.get", {
      guild_id: "not-a-snowflake",
      channel_id: SNOWFLAKE,
      message_id: SNOWFLAKE,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "guild_id must be a Discord id" });
  });

  it("keeps the either-or guard, which stayed in the handler", async () => {
    // `!content && !embeds` reads emptiness (`content: ""` counts as
    // absent), which a per-field type cannot express — it stays in the
    // handler with its wording unchanged.
    const res = await post("/api/plugin/messages.send", {
      channel_id: CHANNEL_ID,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "content or embeds required" });
    expect(channel._send).not.toHaveBeenCalled();
  });

  it("treats an empty content as absent, as `!content` did", async () => {
    const res = await post("/api/plugin/messages.send", {
      channel_id: CHANNEL_ID,
      content: "",
    });
    expect(res.statusCode).toBe(400);
    expect(channel._send).not.toHaveBeenCalled();
  });

  it("still accepts an empty content alongside embeds", async () => {
    const res = await post("/api/plugin/messages.send", {
      channel_id: CHANNEL_ID,
      content: "",
      embeds: [{ title: "t" }],
    });
    expect(res.statusCode).toBe(200);
  });

  it("reports a body that is not an object at all", async () => {
    const res = await post("/api/plugin/messages.trigger_typing");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "body must be object" });
  });

  // ── the schema must not be wider than the check it replaced ───────────────

  it("refuses a number where the old typeof check demanded a string", async () => {
    // Ajv's Fastify default (`coerceTypes: 'array'`) would rewrite this
    // to "12345678" and send the message. See STRICT_RPC_AJV_OPTIONS.
    const res = await post("/api/plugin/messages.send", {
      channel_id: 12345678,
      content: "hi",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "channel_id must be string" });
    expect(channel._send).not.toHaveBeenCalled();
  });

  it("refuses a non-snowflake reply_to", async () => {
    const res = await post("/api/plugin/messages.send", {
      channel_id: CHANNEL_ID,
      content: "hi",
      reply_to: "not-an-id",
    });
    expect(res.statusCode).toBe(400);
    expect(channel._send).not.toHaveBeenCalled();
  });

  it("lets a well-formed request through untouched", async () => {
    const res = await post("/api/plugin/messages.send", {
      channel_id: CHANNEL_ID,
      content: "hi",
      // Unknown fields stay accepted — the SDK sends `attachments` on
      // routes that ignore it, so no schema here closes the object.
      unknown_field: "kept",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "msg-1", channel_id: CHANNEL_ID });
    expect(channel._send).toHaveBeenCalledTimes(1);
  });

  // ── #58: wrong-typed optional fields are refused, naming the field ────────
  //
  // Every field below was normalise-and-continue until #58 — a wrong
  // type was treated as absent and the call still answered 200 (the
  // author's field silently never reached Discord). #58 flipped that,
  // deliberately and release-noted: a wrong-typed value is a 400 naming
  // the field, in the family's `{ error }` body shape.

  it("refuses a wrong-typed content even when embeds carry the message", async () => {
    const res = await post("/api/plugin/messages.send", {
      channel_id: CHANNEL_ID,
      content: 5,
      embeds: [{ title: "t" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "content must be string" });
    expect(channel._send).not.toHaveBeenCalled();
  });

  it("refuses wrong-typed embeds and components", async () => {
    const res = await post("/api/plugin/messages.send", {
      channel_id: CHANNEL_ID,
      content: "hi",
      embeds: "not-an-array",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "embeds must be array" });
    const res2 = await post("/api/plugin/messages.send", {
      channel_id: CHANNEL_ID,
      content: "hi",
      components: "not-an-array",
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.json()).toEqual({ error: "components must be array" });
    expect(channel._send).not.toHaveBeenCalled();
  });

  it("refuses a wrong-typed content on messages.edit instead of leaving the field untouched", async () => {
    const res = await post("/api/plugin/messages.edit", {
      channel_id: CHANNEL_ID,
      message_id: SNOWFLAKE,
      content: 5,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "content must be string" });
  });

  it("refuses a wrong-typed content on messages.send_dm", async () => {
    const res = await post("/api/plugin/messages.send_dm", {
      user_id: SNOWFLAKE,
      content: 5,
      embeds: [{ title: "t" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "content must be string" });
  });

  it("refuses a non-object allowed_mentions", async () => {
    const res = await post("/api/plugin/messages.send", {
      channel_id: CHANNEL_ID,
      content: "hi",
      reply_to: SNOWFLAKE,
      allowed_mentions: "nope",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "allowed_mentions must be object" });
    expect(channel._send).not.toHaveBeenCalled();
  });

  it("refuses a non-integer fetch_history limit instead of defaulting to 50", async () => {
    const res = await post("/api/plugin/messages.fetch_history", {
      guild_id: GUILD_SNOWFLAKE,
      channel_id: SNOWFLAKE,
      limit: "10",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "limit must be integer" });
    expect(rest.get).not.toHaveBeenCalled();
  });

  it("still clamps an out-of-range fetch_history limit rather than refusing it", async () => {
    // KEPT after #58: an out-of-range *integer* is a valid-typed value;
    // clamping to Discord's documented [1, 100] window stays.
    const res = await post("/api/plugin/messages.fetch_history", {
      guild_id: GUILD_SNOWFLAKE,
      channel_id: SNOWFLAKE,
      limit: 500,
    });
    expect(res.statusCode).toBe(200);
    const [, opts] = rest.get.mock.calls[0]!;
    expect((opts as { query: URLSearchParams }).query.get("limit")).toBe("100");
  });

  it("refuses a malformed fetch_history cursor instead of dropping it", async () => {
    const res = await post("/api/plugin/messages.fetch_history", {
      guild_id: GUILD_SNOWFLAKE,
      channel_id: SNOWFLAKE,
      before: "not-an-id",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "before must be a Discord id" });
    expect(rest.get).not.toHaveBeenCalled();
  });

  it("refuses a malformed remove_reaction user_id instead of removing the bot's own", async () => {
    // The old fallback silently removed the BOT'S reaction when the
    // caller's user_id was malformed — the sharpest silent surprise
    // #58 removed.
    const res = await post("/api/plugin/messages.remove_reaction", {
      guild_id: GUILD_SNOWFLAKE,
      channel_id: SNOWFLAKE,
      message_id: SNOWFLAKE,
      emoji: "👍",
      user_id: "not-an-id",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "user_id must be a Discord id" });
    expect(rest.delete).not.toHaveBeenCalled();
  });

  it("still removes the bot's own reaction when user_id is absent", async () => {
    const res = await post("/api/plugin/messages.remove_reaction", {
      guild_id: GUILD_SNOWFLAKE,
      channel_id: SNOWFLAKE,
      message_id: SNOWFLAKE,
      emoji: "👍",
    });
    expect(res.statusCode).toBe(200);
    const [route] = rest.delete.mock.calls[0]!;
    expect(String(route)).toContain("/@me");
  });

  // ── consequences a reviewer should see ────────────────────────────────────

  it("validates before the handler, so a malformed body outranks a missing scope", async () => {
    // Deliberate: schema validation is a lifecycle step ahead of the
    // handler, where requireScope lives. A plugin holding the scope sees
    // no difference; one that holds neither now learns about the body
    // first. Auth (401) still resolves earlier, in the onRequest hook.
    stubPluginAuth([]);
    const res = await post("/api/plugin/messages.trigger_typing", {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "channel_id required" });
  });

  it("leaves routes outside the RPC scope on Fastify's default error body", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/auth/exchange",
      payload: {},
    });
    // No schema, no RPC error handler: whatever this route answers, it
    // is still the one-key admin body rather than anything this file
    // installed.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(Object.keys(res.json())).toEqual(["error"]);
  });
});
