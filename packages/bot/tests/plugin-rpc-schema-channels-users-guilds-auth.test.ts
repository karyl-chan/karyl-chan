/**
 * Declared request parsing for the `channels`, `users`, `guilds` and
 * `auth` RPC families (#55), observed over HTTP — the fourth and last
 * batch to copy the `messages` worked example (#48), after storage/me
 * (#53) and members/interactions/roles/config (#54).
 *
 * Three things are pinned:
 *
 *  1. converted guards refuse exactly what the hand-rolled checks
 *     refused, in the family's `{ error }` body shape;
 *  2. the refusal texts an operator's tooling may match on are
 *     byte-identical (users.get's array message, auth.session's folded
 *     "user_id required" for the empty string) — those go through
 *     per-route formatter overrides;
 *  3. the normalisers are still normalisers: a wrong-typed optional
 *     field is ignored/defaulted with a 200, never refused. These tests
 *     exist so #58's deliberate tightening can't happen by accident.
 *
 * Everything Discord-shaped goes through a mocked `bot.rest` /
 * `bot.users`; auth.session's mint goes through a spied `jwtService`
 * so the test can see the normalised ttl/guild claims.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

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
import { sequelize } from "../src/db.js";
import { createWebServer } from "../src/modules/web-core/server.js";
import { pluginAuthStore } from "../src/modules/plugin-system/plugin-auth.service.js";
import { jwtService } from "../src/modules/web-core/jwt.service.js";
import { findPluginById } from "../src/modules/plugin-system/models/plugin.model.js";
import { findFeatureRowsByPluginGuild } from "../src/modules/feature-toggle/models/plugin-guild-feature.model.js";
import { findFeatureDefaultsByPlugin } from "../src/modules/feature-toggle/models/plugin-feature-default.model.js";
import { featureReachResolver } from "../src/modules/feature-toggle/feature-reach-resolver.js";
import type { PluginGuildFeatureRow } from "../src/modules/feature-toggle/models/plugin-guild-feature.model.js";

// ── helpers ─────────────────────────────────────────────────────────────────

const PLUGIN_ID = 99;
const PLUGIN_KEY = "batch4-plugin";
const GUILD_SNOWFLAKE = "222222222222222222";
const CHANNEL_SNOWFLAKE = "555555555555555555";
const USER_SNOWFLAKE = "333333333333333333";

/** `auth.session`'s default ttl for kind='session' (6 h). */
const SESSION_DEFAULT_TTL_MS = 6 * 60 * 60_000;

const ALL_SCOPES = [
  "channels.get",
  "channels.list",
  "users.get",
  "guilds.get",
  "auth.session",
];

function stubPluginAuth() {
  vi.spyOn(pluginAuthStore, "verify").mockReturnValue({
    pluginId: PLUGIN_ID,
    pluginKey: PLUGIN_KEY,
    scopes: new Set(ALL_SCOPES),
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
    guildId: GUILD_SNOWFLAKE,
    featureKey: "my-feature",
    enabled: true,
    configJson: "{}",
    metricsJson: "{}",
    updatedAt: new Date(),
  };
}

/** Open the per-guild feature gate so well-formed calls reach Discord. */
function featureGateOpen() {
  featureReachResolver.clear();
  (
    findFeatureRowsByPluginGuild as ReturnType<typeof vi.fn>
  ).mockResolvedValue([fakeFeatureRow()]);
  (findFeatureDefaultsByPlugin as ReturnType<typeof vi.fn>).mockResolvedValue(
    [],
  );
}

function fakeRest() {
  return {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue(undefined),
    patch: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeUser(id: string) {
  return {
    id,
    username: "karyl",
    globalName: "Karyl",
    bot: false,
    avatar: null,
    banner: null,
    accentColor: null,
    displayAvatarURL: () => "https://cdn.example/av.webp",
    bannerURL: () => null,
  };
}

function fakeBot(rest: ReturnType<typeof fakeRest>) {
  return {
    user: { id: "bot-1" },
    application: { id: "app-1" },
    isReady: () => true,
    uptime: 0,
    guilds: { cache: new Map(), fetch: vi.fn() },
    channels: { fetch: vi.fn(), cache: { get: vi.fn() } },
    users: {
      fetch: vi.fn(async (id: string) => fakeUser(id)),
    },
    rest,
  };
}

describe("plugin RPC schema errors — channels, users, guilds, auth", () => {
  let server: FastifyInstance;
  let rest: ReturnType<typeof fakeRest>;
  let bot: ReturnType<typeof fakeBot>;
  let signSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    await sequelize.sync({ force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    stubPluginAuth();
    stubActivePlugin();
    featureGateOpen();
    signSpy = vi
      .spyOn(jwtService, "signPluginSession")
      .mockReturnValue({ token: "session-token", expiresAt: 1234567890 });
    rest = fakeRest();
    bot = fakeBot(rest);
    server = await createWebServer({
      staticRoot: undefined,
      bot: bot as never,
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

  // ── channels.get: two snowflake guards, unchanged accepted set ────────────

  it("channels.get refuses a missing guild_id", async () => {
    const res = await post("/api/plugin/channels.get", {
      channel_id: CHANNEL_SNOWFLAKE,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "guild_id required" });
    expect(rest.get).not.toHaveBeenCalled();
  });

  it("channels.get renders the snowflake pattern as the family does", async () => {
    const res = await post("/api/plugin/channels.get", {
      guild_id: "not-a-snowflake",
      channel_id: CHANNEL_SNOWFLAKE,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "guild_id must be a Discord id" });
  });

  it("channels.get refuses a wrong-typed channel_id", async () => {
    const res = await post("/api/plugin/channels.get", {
      guild_id: GUILD_SNOWFLAKE,
      channel_id: 5,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "channel_id must be string" });
  });

  it("channels.get fetches a valid channel", async () => {
    rest.get.mockResolvedValue({
      id: CHANNEL_SNOWFLAKE,
      guild_id: GUILD_SNOWFLAKE,
    });
    const res = await post("/api/plugin/channels.get", {
      guild_id: GUILD_SNOWFLAKE,
      channel_id: CHANNEL_SNOWFLAKE,
      unknown_field: "kept",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      channel: { id: CHANNEL_SNOWFLAKE, guild_id: GUILD_SNOWFLAKE },
    });
  });

  // ── channels.list: snowflake guard + the types normaliser ─────────────────

  it("channels.list refuses a missing guild_id", async () => {
    const res = await post("/api/plugin/channels.list", {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "guild_id required" });
  });

  it("channels.list still ignores a wrong-typed types filter", async () => {
    // `Array.isArray(body.types) && …` — a string means "no filter",
    // never a 400. Pinned so #58's tightening is a deliberate change.
    rest.get.mockResolvedValue([
      { id: "1", type: 0 },
      { id: "2", type: 2 },
    ]);
    const res = await post("/api/plugin/channels.list", {
      guild_id: GUILD_SNOWFLAKE,
      types: "not-an-array",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().channels).toHaveLength(2);
  });

  it("channels.list filters by a valid types array", async () => {
    rest.get.mockResolvedValue([
      { id: "1", type: 0 },
      { id: "2", type: 2 },
    ]);
    const res = await post("/api/plugin/channels.list", {
      guild_id: GUILD_SNOWFLAKE,
      types: [0],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().channels).toEqual([{ id: "1", type: 0 }]);
  });

  // ── guilds.get: one snowflake guard ───────────────────────────────────────

  it("guilds.get renders the snowflake pattern as the family does", async () => {
    const res = await post("/api/plugin/guilds.get", {
      guild_id: "not-a-snowflake",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "guild_id must be a Discord id" });
  });

  it("guilds.get fetches a valid guild", async () => {
    rest.get.mockResolvedValue({ id: GUILD_SNOWFLAKE, name: "g" });
    const res = await post("/api/plugin/guilds.get", {
      guild_id: GUILD_SNOWFLAKE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      guild: { id: GUILD_SNOWFLAKE, name: "g" },
    });
  });

  // ── users.get: the array guard + per-item normaliser ──────────────────────

  it("users.get refuses a missing user_ids", async () => {
    // The old `!Array.isArray` caught this too, with the array message;
    // missing sharpens to the family's "required" (members.get trade).
    const res = await post("/api/plugin/users.get", {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "user_ids required" });
  });

  it("users.get keeps the array message verbatim on a wrong-typed user_ids", async () => {
    const res = await post("/api/plugin/users.get", {
      user_ids: "not-an-array",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "user_ids must be an array" });
  });

  it("users.get still filters malformed ids instead of refusing them", async () => {
    // Per-item snowflake filtering is a normaliser: a wrong-typed or
    // malformed entry is dropped before the fetch, never a 400.
    const res = await post("/api/plugin/users.get", {
      user_ids: [5, "not-an-id"],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ users: [] });
    expect(bot.users.fetch).not.toHaveBeenCalled();
  });

  it("users.get resolves a valid batch", async () => {
    const res = await post("/api/plugin/users.get", {
      user_ids: [USER_SNOWFLAKE],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().users).toEqual([
      {
        userId: USER_SNOWFLAKE,
        username: "karyl",
        globalName: "Karyl",
        displayName: "Karyl",
        avatarUrl: "https://cdn.example/av.webp",
        bannerUrl: null,
        accentColor: null,
        isBot: false,
      },
    ]);
  });

  // ── auth.session: user_id guard + kind/guild_id/ttl_ms normalisers ────────

  it("auth.session refuses a missing user_id with the old text", async () => {
    const res = await post("/api/plugin/auth.session", {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "user_id required" });
  });

  it("auth.session keeps the empty-user_id message verbatim", async () => {
    const res = await post("/api/plugin/auth.session", { user_id: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "user_id required" });
  });

  it("auth.session names the field on a type failure", async () => {
    const res = await post("/api/plugin/auth.session", { user_id: 5 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "user_id must be string" });
    expect(signSpy).not.toHaveBeenCalled();
  });

  it("auth.session still defaults wrong-typed kind, guild_id and ttl_ms", async () => {
    // All three are normalisers at HEAD:
    //   kind:     anything but the literal "manage" means "session"
    //   guild_id: non-string / empty → null claim
    //   ttl_ms:   non-number → the session default (6 h)
    const res = await post("/api/plugin/auth.session", {
      user_id: USER_SNOWFLAKE,
      kind: 5,
      guild_id: 7,
      ttl_ms: "soon",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      allowed: true,
      token: "session-token",
      expiresAt: 1234567890,
    });
    expect(signSpy).toHaveBeenCalledWith(
      PLUGIN_KEY,
      {
        purpose: "plugin-session",
        userId: USER_SNOWFLAKE,
        guildId: null,
        capabilities: [],
      },
      { ttlMs: SESSION_DEFAULT_TTL_MS },
    );
  });

  it("auth.session mints a valid session token", async () => {
    const res = await post("/api/plugin/auth.session", {
      user_id: USER_SNOWFLAKE,
      kind: "session",
      guild_id: GUILD_SNOWFLAKE,
      ttl_ms: 120_000,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      allowed: true,
      token: "session-token",
      expiresAt: 1234567890,
    });
    expect(signSpy).toHaveBeenCalledWith(
      PLUGIN_KEY,
      {
        purpose: "plugin-session",
        userId: USER_SNOWFLAKE,
        guildId: GUILD_SNOWFLAKE,
        capabilities: [],
      },
      { ttlMs: 120_000 },
    );
  });
});
