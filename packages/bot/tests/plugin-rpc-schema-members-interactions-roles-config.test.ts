/**
 * Declared request parsing for the `members`, `interactions`, `roles`
 * and `config` RPC families (#54), observed over HTTP — the third batch
 * to copy the `messages` worked example (#48) and the storage/me batch
 * (#53).
 *
 * Three things are pinned:
 *
 *  1. converted guards refuse exactly what the hand-rolled checks
 *     refused, in the family's `{ error }` body shape;
 *  2. the refusal texts an operator's tooling may match on are
 *     byte-identical (config.set's key/value messages, send_modal's
 *     folded "modal required", members.get's array message) — those go
 *     through per-route formatter overrides;
 *  3. the normalisers are still normalisers: a wrong-typed optional
 *     field is ignored/defaulted with a 200, never refused. These tests
 *     exist so #58's deliberate tightening can't happen by accident.
 *
 * config.set drives the real plugin-config model against the in-memory
 * sqlite DB, same reasoning as the storage suite; everything Discord-
 * shaped goes through a mocked `bot.rest`.
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
import { findPluginById } from "../src/modules/plugin-system/models/plugin.model.js";
import { findFeatureRowsByPluginGuild } from "../src/modules/feature-toggle/models/plugin-guild-feature.model.js";
import { findFeatureDefaultsByPlugin } from "../src/modules/feature-toggle/models/plugin-feature-default.model.js";
import { featureReachResolver } from "../src/modules/feature-toggle/feature-reach-resolver.js";
import type { PluginGuildFeatureRow } from "../src/modules/feature-toggle/models/plugin-guild-feature.model.js";
import {
  PluginConfig,
  findConfigKey,
} from "../src/modules/plugin-system/models/plugin-config.model.js";

// ── helpers ─────────────────────────────────────────────────────────────────

const PLUGIN_ID = 99;
const PLUGIN_KEY = "batch3-plugin";
const GUILD_SNOWFLAKE = "222222222222222222";
const USER_SNOWFLAKE = "333333333333333333";
const ROLE_SNOWFLAKE = "444444444444444444";
const TOKEN = "interaction-token-abc";

const ALL_SCOPES = [
  "members.get",
  "members.add_role",
  "members.remove_role",
  "interactions.respond",
  "interactions.followup",
  "interactions.delete_followup",
  "interactions.edit_followup",
  "interactions.send_modal",
  "roles.list",
  "roles.get",
  "config.get",
  "config.set",
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
    get: vi.fn().mockResolvedValue([{ id: ROLE_SNOWFLAKE }]),
    post: vi.fn().mockResolvedValue({ id: "followup-1" }),
    patch: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeMember(id: string) {
  return {
    id,
    displayName: "Karyl",
    avatar: null,
    user: { avatar: null },
    displayAvatarURL: () => "https://cdn.example/av.webp",
  };
}

function fakeBot(rest: ReturnType<typeof fakeRest>) {
  return {
    user: { id: "bot-1" },
    application: { id: "app-1" },
    isReady: () => true,
    uptime: 0,
    guilds: {
      cache: new Map(),
      fetch: vi.fn().mockResolvedValue({
        members: {
          fetch: vi
            .fn()
            .mockResolvedValue(new Map([[USER_SNOWFLAKE, fakeMember(USER_SNOWFLAKE)]])),
        },
      }),
    },
    channels: { fetch: vi.fn(), cache: { get: vi.fn() } },
    rest,
  };
}

describe("plugin RPC schema errors — members, interactions, roles, config", () => {
  let server: FastifyInstance;
  let rest: ReturnType<typeof fakeRest>;

  beforeAll(async () => {
    await sequelize.sync({ force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    stubPluginAuth();
    stubActivePlugin();
    featureGateOpen();
    await PluginConfig.destroy({ where: {} });
    rest = fakeRest();
    server = await createWebServer({
      staticRoot: undefined,
      bot: fakeBot(rest) as never,
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

  // ── config.set: guards, with the historical texts verbatim ────────────────

  it("config.set refuses a missing key with the old text", async () => {
    const res = await post("/api/plugin/config.set", { value: "v" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "key required" });
  });

  it("config.set keeps the empty-key message verbatim", async () => {
    const res = await post("/api/plugin/config.set", { key: "", value: "v" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "key required" });
  });

  it("config.set keeps the over-long-key message verbatim", async () => {
    const res = await post("/api/plugin/config.set", {
      key: "k".repeat(201),
      value: "v",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "key exceeds 200 chars" });
  });

  it("config.set keeps the value union message verbatim", async () => {
    const res = await post("/api/plugin/config.set", { key: "k", value: 5 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "value must be string or null" });
  });

  it("config.set still writes a string value", async () => {
    const res = await post("/api/plugin/config.set", { key: "k", value: "v" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect((await findConfigKey(PLUGIN_ID, "k"))?.value).toBe("v");
  });

  it("config.set still treats an explicit null value as delete", async () => {
    await post("/api/plugin/config.set", { key: "k", value: "v" });
    const res = await post("/api/plugin/config.set", { key: "k", value: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: true });
  });

  it("config.set still treats an absent value as delete", async () => {
    const res = await post("/api/plugin/config.set", { key: "nope" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: false });
  });

  it("config.get stays unvalidated — a number body is still accepted", async () => {
    // The route reads no body at all; per the #53 ruling the correct
    // conversion is no schema, not an invented constraint.
    const res = await post("/api/plugin/config.get", 5);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ values: {}, schema: [] });
  });

  // ── interactions.*: token/id guards, family body shape ────────────────────

  it("interactions.respond refuses a missing interaction_token", async () => {
    const res = await post("/api/plugin/interactions.respond", {
      content: "hi",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "interaction_token required" });
  });

  it("interactions.respond names the field on a type failure", async () => {
    const res = await post("/api/plugin/interactions.respond", {
      interaction_token: 5,
      content: "hi",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "interaction_token must be string" });
  });

  it("interactions.respond keeps the either-or guard in the handler", async () => {
    const res = await post("/api/plugin/interactions.respond", {
      interaction_token: TOKEN,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "content, embeds or components required",
    });
    expect(rest.patch).not.toHaveBeenCalled();
  });

  it("interactions.respond still ignores wrong-typed content and flags", async () => {
    const res = await post("/api/plugin/interactions.respond", {
      interaction_token: TOKEN,
      content: 5,
      embeds: [{ title: "t" }],
      flags: "not-a-number",
    });
    expect(res.statusCode).toBe(200);
    const [, opts] = rest.patch.mock.calls[0]!;
    const sent = (opts as { body: Record<string, unknown> }).body;
    expect(sent.content).toBeUndefined();
    expect(sent.flags).toBeUndefined();
  });

  it("interactions.respond PATCHes @original on a valid request", async () => {
    const res = await post("/api/plugin/interactions.respond", {
      interaction_token: TOKEN,
      content: "done",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const [route] = rest.patch.mock.calls[0]!;
    expect(String(route)).toContain("/messages/%40original");
  });

  it("interactions.followup refuses a missing interaction_token", async () => {
    const res = await post("/api/plugin/interactions.followup", {
      content: "hi",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "interaction_token required" });
  });

  it("interactions.followup still treats a wrong-typed ephemeral as public", async () => {
    // `body.ephemeral === true` — the string "yes" was never ephemeral.
    const res = await post("/api/plugin/interactions.followup", {
      interaction_token: TOKEN,
      content: "hi",
      ephemeral: "yes",
    });
    expect(res.statusCode).toBe(200);
    const [, opts] = rest.post.mock.calls[0]!;
    expect((opts as { body: { flags?: number } }).body.flags).toBeUndefined();
  });

  it("interactions.followup posts a valid follow-up", async () => {
    const res = await post("/api/plugin/interactions.followup", {
      interaction_token: TOKEN,
      content: "hi",
      ephemeral: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, id: "followup-1" });
    const [, opts] = rest.post.mock.calls[0]!;
    expect((opts as { body: { flags?: number } }).body.flags).toBe(64);
  });

  it("interactions.delete_followup refuses a missing message_id", async () => {
    const res = await post("/api/plugin/interactions.delete_followup", {
      interaction_token: TOKEN,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "message_id required" });
  });

  it("interactions.delete_followup refuses a wrong-typed message_id", async () => {
    const res = await post("/api/plugin/interactions.delete_followup", {
      interaction_token: TOKEN,
      message_id: 5,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "message_id must be string" });
  });

  it("interactions.delete_followup deletes on a valid request", async () => {
    // message_id was never snowflake-checked — any non-empty string goes.
    const res = await post("/api/plugin/interactions.delete_followup", {
      interaction_token: TOKEN,
      message_id: "followup-1",
      unknown_field: "kept",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(rest.delete).toHaveBeenCalledTimes(1);
  });

  it("interactions.edit_followup refuses a missing interaction_token", async () => {
    const res = await post("/api/plugin/interactions.edit_followup", {
      message_id: "followup-1",
      content: "x",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "interaction_token required" });
  });

  it("interactions.edit_followup still drops wrong-typed optional fields", async () => {
    const res = await post("/api/plugin/interactions.edit_followup", {
      interaction_token: TOKEN,
      message_id: "followup-1",
      content: 5,
      embeds: "not-an-array",
      allowed_mentions: "nope",
    });
    expect(res.statusCode).toBe(200);
    const [, opts] = rest.patch.mock.calls[0]!;
    const sent = (opts as { body: Record<string, unknown> }).body;
    expect("content" in sent).toBe(false);
    expect("embeds" in sent).toBe(false);
    expect(sent.allowed_mentions).toEqual({ parse: [] });
  });

  it("interactions.edit_followup patches on a valid request", async () => {
    const res = await post("/api/plugin/interactions.edit_followup", {
      interaction_token: TOKEN,
      message_id: "followup-1",
      content: "new",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("interactions.send_modal keeps the folded 'modal required' for every modal failure", async () => {
    for (const modal of [undefined, null, false, 0, "x"]) {
      const res = await post("/api/plugin/interactions.send_modal", {
        interaction_id: USER_SNOWFLAKE,
        interaction_token: TOKEN,
        ...(modal === undefined ? {} : { modal }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "modal required" });
    }
    expect(rest.post).not.toHaveBeenCalled();
  });

  it("interactions.send_modal refuses a missing interaction_id", async () => {
    const res = await post("/api/plugin/interactions.send_modal", {
      interaction_token: TOKEN,
      modal: { custom_id: `kc:${PLUGIN_KEY}:m` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "interaction_id required" });
  });

  it("interactions.send_modal still accepts an array modal, as `typeof [] === 'object'` did", async () => {
    const res = await post("/api/plugin/interactions.send_modal", {
      interaction_id: USER_SNOWFLAKE,
      interaction_token: TOKEN,
      modal: [],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("interactions.send_modal opens a valid modal", async () => {
    const res = await post("/api/plugin/interactions.send_modal", {
      interaction_id: USER_SNOWFLAKE,
      interaction_token: TOKEN,
      modal: { custom_id: `kc:${PLUGIN_KEY}:m`, title: "t", components: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const [route] = rest.post.mock.calls[0]!;
    expect(String(route)).toContain("/callback");
  });

  // ── members.*: guards mirror each route's OWN old check ───────────────────

  it("members.get refuses a missing guild_id", async () => {
    const res = await post("/api/plugin/members.get", {
      user_ids: [USER_SNOWFLAKE],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "guild_id required" });
  });

  it("members.get keeps the array message verbatim on a wrong-typed user_ids", async () => {
    const res = await post("/api/plugin/members.get", {
      guild_id: GUILD_SNOWFLAKE,
      user_ids: "not-an-array",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "user_ids must be an array" });
  });

  it("members.get still accepts a non-snowflake guild_id, as the bare typeof did", async () => {
    // Unlike members.add_role, HEAD never ran SNOWFLAKE_RE on this
    // guild_id — upgrading it here would be a narrowing (#48 lesson).
    // All-malformed user_ids are filtered to nothing, which returns
    // an empty list before any guild work.
    const res = await post("/api/plugin/members.get", {
      guild_id: "not-a-snowflake",
      user_ids: [5, "also-not-an-id"],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ members: [] });
  });

  it("members.get resolves a valid batch", async () => {
    const res = await post("/api/plugin/members.get", {
      guild_id: GUILD_SNOWFLAKE,
      user_ids: [USER_SNOWFLAKE],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toEqual([
      {
        userId: USER_SNOWFLAKE,
        displayName: "Karyl",
        avatarUrl: "https://cdn.example/av.webp",
      },
    ]);
  });

  it("members.add_role renders the snowflake pattern as the family does", async () => {
    const res = await post("/api/plugin/members.add_role", {
      guild_id: "not-a-snowflake",
      user_id: USER_SNOWFLAKE,
      role_id: ROLE_SNOWFLAKE,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "guild_id must be a Discord id" });
    expect(rest.put).not.toHaveBeenCalled();
  });

  it("members.add_role refuses a missing user_id", async () => {
    const res = await post("/api/plugin/members.add_role", {
      guild_id: GUILD_SNOWFLAKE,
      role_id: ROLE_SNOWFLAKE,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "user_id required" });
  });

  it("members.add_role assigns on a valid request", async () => {
    const res = await post("/api/plugin/members.add_role", {
      guild_id: GUILD_SNOWFLAKE,
      user_id: USER_SNOWFLAKE,
      role_id: ROLE_SNOWFLAKE,
      unknown_field: "kept",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(rest.put).toHaveBeenCalledTimes(1);
  });

  it("members.remove_role refuses a wrong-typed role_id", async () => {
    const res = await post("/api/plugin/members.remove_role", {
      guild_id: GUILD_SNOWFLAKE,
      user_id: USER_SNOWFLAKE,
      role_id: 5,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "role_id must be string" });
    expect(rest.delete).not.toHaveBeenCalled();
  });

  it("members.remove_role removes on a valid request", async () => {
    const res = await post("/api/plugin/members.remove_role", {
      guild_id: GUILD_SNOWFLAKE,
      user_id: USER_SNOWFLAKE,
      role_id: ROLE_SNOWFLAKE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(rest.delete).toHaveBeenCalledTimes(1);
  });

  // ── roles.*: snowflake guards, unchanged accepted set ─────────────────────

  it("roles.list refuses a missing guild_id", async () => {
    const res = await post("/api/plugin/roles.list", {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "guild_id required" });
  });

  it("roles.list renders the snowflake pattern as the family does", async () => {
    const res = await post("/api/plugin/roles.list", {
      guild_id: "not-a-snowflake",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "guild_id must be a Discord id" });
  });

  it("roles.list answers a valid guild", async () => {
    const res = await post("/api/plugin/roles.list", {
      guild_id: GUILD_SNOWFLAKE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ roles: [{ id: ROLE_SNOWFLAKE }] });
  });

  it("roles.get refuses a non-snowflake role_id", async () => {
    const res = await post("/api/plugin/roles.get", {
      guild_id: GUILD_SNOWFLAKE,
      role_id: "not-a-snowflake",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "role_id must be a Discord id" });
  });

  it("roles.get finds a valid role", async () => {
    const res = await post("/api/plugin/roles.get", {
      guild_id: GUILD_SNOWFLAKE,
      role_id: ROLE_SNOWFLAKE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ role: { id: ROLE_SNOWFLAKE } });
  });
});
