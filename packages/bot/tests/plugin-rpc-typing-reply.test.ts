/**
 * Unit tests for POST /api/plugin/messages.trigger_typing and the
 * `reply_to` field on POST /api/plugin/messages.send.
 *
 * Same strategy as plugin-rpc-guild-feature-check.test.ts: mock the
 * Sequelize-backed functions and side-effect helpers so the tests run
 * without a real DB or Discord client; stub pluginAuthStore.verify to
 * bypass auth.
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

const PLUGIN_ID = 42;
const PLUGIN_KEY = "test-plugin";
const GUILD_ID = "guild-123";
const CHANNEL_ID = "chan-456";
const REPLY_TO_ID = "123456789012345678";

function stubPluginAuth(scopes: string[]) {
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

function fakeGuildChannel(overrides: Record<string, unknown> = {}) {
  const send = vi
    .fn()
    .mockResolvedValue({ id: "msg-1", channelId: CHANNEL_ID });
  const sendTyping = vi.fn().mockResolvedValue(undefined);
  return {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    isTextBased: () => true,
    isDMBased: () => false,
    send,
    sendTyping,
    _send: send,
    _sendTyping: sendTyping,
    ...overrides,
  };
}

function fakeBot(channel: unknown) {
  return {
    user: { id: "bot-1" },
    isReady: () => true,
    guilds: { cache: { size: 0 } },
    uptime: 0,
    channels: {
      fetch: vi.fn().mockResolvedValue(channel),
    },
  };
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

function featureGateOpen() {
  featureReachResolver.clear();
  (
    findFeatureRowsByPluginGuild as ReturnType<typeof vi.fn>
  ).mockResolvedValue([fakeFeatureRow()]);
  (
    findFeatureDefaultsByPlugin as ReturnType<typeof vi.fn>
  ).mockResolvedValue([]);
}

function featureGateClosed() {
  featureReachResolver.clear();
  (
    findFeatureRowsByPluginGuild as ReturnType<typeof vi.fn>
  ).mockResolvedValue([]);
  (
    findFeatureDefaultsByPlugin as ReturnType<typeof vi.fn>
  ).mockResolvedValue([]);
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("messages.trigger_typing", () => {
  let server: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    featureGateOpen();
    stubActivePlugin();
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  it("fires sendTyping on the channel and returns ok", async () => {
    stubPluginAuth(["messages.trigger_typing"]);
    const channel = fakeGuildChannel();
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(channel) as never,
    });
    await server.ready();
    featureGateOpen();

    const res = await server.inject({
      method: "POST",
      url: "/api/plugin/messages.trigger_typing",
      headers: { authorization: "Bearer fake-token" },
      payload: { channel_id: CHANNEL_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(channel._sendTyping).toHaveBeenCalledOnce();
    expect(findFeatureRowsByPluginGuild).toHaveBeenCalledWith(
      PLUGIN_ID,
      GUILD_ID,
    );
  });

  it("403s when the plugin has no enabled feature in the guild", async () => {
    stubPluginAuth(["messages.trigger_typing"]);
    const channel = fakeGuildChannel();
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(channel) as never,
    });
    await server.ready();
    featureGateClosed();

    const res = await server.inject({
      method: "POST",
      url: "/api/plugin/messages.trigger_typing",
      headers: { authorization: "Bearer fake-token" },
      payload: { channel_id: CHANNEL_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(channel._sendTyping).not.toHaveBeenCalled();
  });

  it("403s when the token lacks the messages.trigger_typing scope", async () => {
    stubPluginAuth(["messages.send"]);
    const channel = fakeGuildChannel();
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(channel) as never,
    });
    await server.ready();
    featureGateOpen();

    const res = await server.inject({
      method: "POST",
      url: "/api/plugin/messages.trigger_typing",
      headers: { authorization: "Bearer fake-token" },
      payload: { channel_id: CHANNEL_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(channel._sendTyping).not.toHaveBeenCalled();
  });

  it("400s when the channel does not support typing", async () => {
    stubPluginAuth(["messages.trigger_typing"]);
    const channel = fakeGuildChannel({ sendTyping: undefined });
    delete (channel as Record<string, unknown>).sendTyping;
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(channel) as never,
    });
    await server.ready();
    featureGateOpen();

    const res = await server.inject({
      method: "POST",
      url: "/api/plugin/messages.trigger_typing",
      headers: { authorization: "Bearer fake-token" },
      payload: { channel_id: CHANNEL_ID },
    });

    expect(res.statusCode).toBe(400);
  });

  it("400s when channel_id is missing", async () => {
    stubPluginAuth(["messages.trigger_typing"]);
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(fakeGuildChannel()) as never,
    });
    await server.ready();

    const res = await server.inject({
      method: "POST",
      url: "/api/plugin/messages.trigger_typing",
      headers: { authorization: "Bearer fake-token" },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("messages.send — reply_to", () => {
  let server: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    featureGateOpen();
    stubPluginAuth(["messages.send"]);
    stubActivePlugin();
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  it("passes reply_to through as a native reply with failIfNotExists false, pinging the author by default", async () => {
    const channel = fakeGuildChannel();
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(channel) as never,
    });
    await server.ready();
    featureGateOpen();

    const res = await server.inject({
      method: "POST",
      url: "/api/plugin/messages.send",
      headers: { authorization: "Bearer fake-token" },
      payload: { channel_id: CHANNEL_ID, content: "hi", reply_to: REPLY_TO_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(channel._send).toHaveBeenCalledWith(
      expect.objectContaining({
        reply: { messageReference: REPLY_TO_ID, failIfNotExists: false },
        // With allowed_mentions always attached, Discord would default
        // replied_user to false — the route must opt replies back in.
        allowedMentions: expect.objectContaining({ repliedUser: true }),
      }),
    );
  });

  it("respects an explicit repliedUser:false opt-out on replies", async () => {
    const channel = fakeGuildChannel();
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(channel) as never,
    });
    await server.ready();
    featureGateOpen();

    const res = await server.inject({
      method: "POST",
      url: "/api/plugin/messages.send",
      headers: { authorization: "Bearer fake-token" },
      payload: {
        channel_id: CHANNEL_ID,
        content: "hi",
        reply_to: REPLY_TO_ID,
        allowed_mentions: { repliedUser: false },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(channel._send).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedMentions: expect.objectContaining({ repliedUser: false }),
      }),
    );
  });

  it("does not set repliedUser on non-reply sends", async () => {
    const channel = fakeGuildChannel();
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(channel) as never,
    });
    await server.ready();
    featureGateOpen();

    const res = await server.inject({
      method: "POST",
      url: "/api/plugin/messages.send",
      headers: { authorization: "Bearer fake-token" },
      payload: { channel_id: CHANNEL_ID, content: "hi" },
    });

    expect(res.statusCode).toBe(200);
    const arg = channel._send.mock.calls[0][0] as { allowedMentions: Record<string, unknown> };
    expect("repliedUser" in arg.allowedMentions).toBe(false);
  });

  it("omits the reply option when reply_to is absent", async () => {
    const channel = fakeGuildChannel();
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(channel) as never,
    });
    await server.ready();
    featureGateOpen();

    const res = await server.inject({
      method: "POST",
      url: "/api/plugin/messages.send",
      headers: { authorization: "Bearer fake-token" },
      payload: { channel_id: CHANNEL_ID, content: "hi" },
    });

    expect(res.statusCode).toBe(200);
    const arg = channel._send.mock.calls[0][0] as Record<string, unknown>;
    expect("reply" in arg).toBe(false);
  });

  it("400s on a non-snowflake reply_to", async () => {
    const channel = fakeGuildChannel();
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(channel) as never,
    });
    await server.ready();
    featureGateOpen();

    const res = await server.inject({
      method: "POST",
      url: "/api/plugin/messages.send",
      headers: { authorization: "Bearer fake-token" },
      payload: { channel_id: CHANNEL_ID, content: "hi", reply_to: "not-an-id" },
    });

    expect(res.statusCode).toBe(400);
    expect(channel._send).not.toHaveBeenCalled();
  });
});

describe("messages.send — reply ping opt-out semantics (review #5)", () => {
  let server: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    featureGateOpen();
    stubPluginAuth(["messages.send"]);
    stubActivePlugin();
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  async function send(payload: Record<string, unknown>) {
    const channel = fakeGuildChannel();
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(channel) as never,
    });
    await server.ready();
    featureGateOpen();
    const res = await server.inject({
      method: "POST",
      url: "/api/plugin/messages.send",
      headers: { authorization: "Bearer fake-token" },
      payload: { channel_id: CHANNEL_ID, content: "hi", ...payload },
    });
    expect(res.statusCode).toBe(200);
    return channel._send.mock.calls[0]![0] as {
      allowedMentions: Record<string, unknown>;
    };
  }

  it("honors the wire-native snake_case replied_user:false opt-out", async () => {
    const arg = await send({
      reply_to: REPLY_TO_ID,
      allowed_mentions: { replied_user: false },
    });
    expect(arg.allowedMentions.repliedUser).toBe(false);
  });

  it("an explicit allowlist without replied_user keeps Discord's no-ping default", async () => {
    // {users: [], roles: []} = "ping nobody" — the route must not
    // force the reply ping over an explicit (even empty) allowlist.
    const arg = await send({
      reply_to: REPLY_TO_ID,
      allowed_mentions: { users: [], roles: [] },
    });
    expect("repliedUser" in arg.allowedMentions).toBe(false);
  });

  it("snake_case replied_user:true also works with a provided allowlist", async () => {
    const arg = await send({
      reply_to: REPLY_TO_ID,
      allowed_mentions: { users: [], replied_user: true },
    });
    expect(arg.allowedMentions.repliedUser).toBe(true);
  });
});
