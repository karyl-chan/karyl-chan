/**
 * Declared request parsing for the `storage` and `me` RPC families (#53),
 * observed over HTTP — the second and third scope families to copy the
 * `messages` worked example (#48).
 *
 * Three things are pinned:
 *
 *  1. converted guards refuse exactly what the hand-rolled checks
 *     refused, in the family's `{ error }` body shape;
 *  2. the refusal texts an operator's tooling may match on are
 *     byte-identical (the kv key caps, delta, the log batch cap, the
 *     snapshot guard) — those go through per-route formatter overrides;
 *  3. #58's deliberate tightening: a wrong-typed optional field is now
 *     refused with a 400 naming the field, and the leniency that
 *     remains (the log.emit per-entry skip, the snapshot's inner
 *     fields, empty-string ids) is each a designed contract, pinned
 *     with the reason it was kept.
 *
 * Unlike the messages suite this one drives the real KV model against
 * the in-memory sqlite DB — the storage handlers are thin enough that
 * mocking the model would mostly test the mock.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

// ── module-level mocks ──────────────────────────────────────────────────────

vi.mock("../src/modules/plugin-system/models/plugin.model.js", () => ({
  findPluginById: vi.fn(),
}));

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
import { botEventLog } from "../src/modules/bot-events/bot-event-log.js";
import {
  PluginKv,
  getKv,
  setKv,
} from "../src/modules/plugin-system/models/plugin-kv.model.js";

// ── helpers ─────────────────────────────────────────────────────────────────

const PLUGIN_ID = 88;
const PLUGIN_KEY = "storage-plugin";
const GUILD_SNOWFLAKE = "222222222222222222";

const ALL_SCOPES = [
  "storage.kv_get",
  "storage.kv_set",
  "storage.kv_increment",
  "storage.kv_delete",
  "storage.kv_list",
  "storage.kv_list_values",
  "me.kv_usage",
  "me.enabled_guilds",
  "me.log",
  "me.metrics",
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
    manifestJson: JSON.stringify({}),
  });
}

describe("plugin RPC schema errors — storage and me families", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    await sequelize.sync({ force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    stubPluginAuth();
    stubActivePlugin();
    await PluginKv.destroy({ where: {} });
    server = await createWebServer({
      staticRoot: undefined,
      bot: {
        user: { id: "bot-1" },
        isReady: () => true,
        uptime: 0,
        guilds: { cache: new Map() },
      } as never,
    });
    await server.ready();
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

  // ── guards: same refusals, family body shape ──────────────────────────────

  it("kv_get refuses a wrong-typed guild_id with the family's body shape", async () => {
    const res = await post("/api/plugin/storage.kv_get", {
      guild_id: 5,
      key: "k",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "guild_id must be string" });
  });

  it("kv_get names key when only key is missing", async () => {
    const res = await post("/api/plugin/storage.kv_get", { guild_id: "g1" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "key required" });
  });

  it("kv_get round-trips a valid request", async () => {
    await setKv(PLUGIN_ID, "g1", "k", "v");
    const res = await post("/api/plugin/storage.kv_get", {
      guild_id: "g1",
      key: "k",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ found: true, value: "v", bytes: 1 });
  });

  // ── the byte-preserved refusal texts ──────────────────────────────────────

  it("kv_set keeps the historical over-long-key message verbatim", async () => {
    const res = await post("/api/plugin/storage.kv_set", {
      guild_id: "g1",
      key: "k".repeat(201),
      value: "v",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "key required (max 200 chars)" });
  });

  it("kv_set keeps the same message for an empty key, as the folded guard did", async () => {
    const res = await post("/api/plugin/storage.kv_set", {
      guild_id: "g1",
      key: "",
      value: "v",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "key required (max 200 chars)" });
  });

  it("kv_set still accepts a key of exactly 200 chars and stores the value", async () => {
    const key = "k".repeat(200);
    const res = await post("/api/plugin/storage.kv_set", {
      guild_id: "g1",
      key,
      value: "hello",
    });
    expect(res.statusCode).toBe(200);
    expect((await getKv(PLUGIN_ID, "g1", key))?.value).toBe("hello");
  });

  it("kv_set's serialised-bytes cap stayed in the handler (schema can't count bytes)", async () => {
    const res = await post("/api/plugin/storage.kv_set", {
      guild_id: "g1",
      key: "k",
      value: "x".repeat(65 * 1024),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/per-row hard cap/);
  });

  it("kv_increment keeps its own over-long-key message verbatim", async () => {
    const res = await post("/api/plugin/storage.kv_increment", {
      guild_id: "g1",
      key: "k".repeat(201),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "key exceeds 200 chars" });
  });

  it("kv_increment refuses a string delta with the historical message", async () => {
    const res = await post("/api/plugin/storage.kv_increment", {
      guild_id: "g1",
      key: "n",
      delta: "5",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "delta must be a finite number" });
  });

  it("log.emit keeps the batch-cap message verbatim", async () => {
    const res = await post("/api/plugin/log.emit", {
      entries: Array.from({ length: 101 }, () => ({
        level: "info",
        message: "m",
      })),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "max 100 entries per batch" });
  });

  it("metrics.push keeps the snapshot guard's message verbatim", async () => {
    const res = await post("/api/plugin/metrics.push", 5);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "snapshot object required" });
  });

  it("metrics.push answers a missing body with the same message", async () => {
    const res = await post("/api/plugin/metrics.push");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "snapshot object required" });
  });

  // ── the schema is no wider than the check it replaced ─────────────────────

  it("me/kv_usage renders the snowflake pattern as the family does", async () => {
    const res = await post("/api/plugin/me/kv_usage", {
      guild_id: "not-a-snowflake",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "guild_id must be a Discord id" });
  });

  it("me/kv_usage answers a valid guild", async () => {
    const res = await post("/api/plugin/me/kv_usage", {
      guild_id: GUILD_SNOWFLAKE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ used_bytes: 0, quota_bytes: 65536 });
  });

  it("kv_set refuses a null value as the typeof guard did", async () => {
    const res = await post("/api/plugin/storage.kv_set", {
      guild_id: "g1",
      key: "k",
      value: null,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "value must be string" });
  });

  it("log.emit refuses a non-array entries", async () => {
    const res = await post("/api/plugin/log.emit", { entries: "x" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "entries must be array" });
  });

  // ── #58: wrong-typed optional fields are refused, naming the field ────────
  //
  // Every refusal below answered 200 until #58 even though a field
  // carried the wrong type. The tightening is deliberate and
  // release-noted; what stays lenient below is each a designed
  // contract, called out where it is kept.

  it("kv_increment refuses an explicit null delta", async () => {
    // Until #58 null meant "default to 1" — an accident of the old
    // guard reading `body.delta ?? 1` before type-checking.
    const res = await post("/api/plugin/storage.kv_increment", {
      guild_id: "g1",
      key: "n",
      delta: null,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "delta must be a finite number" });
  });

  it("kv_increment still defaults an absent delta to 1", async () => {
    const res = await post("/api/plugin/storage.kv_increment", {
      guild_id: "g1",
      key: "n",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().value).toBe(1);
  });

  it("kv_delete still accepts empty-string ids, as the bare typeof did", async () => {
    // KEPT after #58: empty strings are the *right* type — the
    // tightening is about wrong-typed values only.
    const res = await post("/api/plugin/storage.kv_delete", {
      guild_id: "",
      key: "",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: false });
  });

  it("kv_list refuses wrong-typed prefix/limit/offset instead of defaulting", async () => {
    // Until #58 a wrong-typed option silently fell back to its default
    // (prefix → none, limit → 100, offset → 0).
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ prefix: 5 }, "prefix must be string"],
      [{ limit: "1" }, "limit must be number"],
      [{ offset: {} }, "offset must be number"],
    ];
    for (const [fields, message] of cases) {
      const res = await post("/api/plugin/storage.kv_list", {
        guild_id: "g1",
        ...fields,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: message });
    }
  });

  it("kv_list still defaults absent prefix/limit/offset", async () => {
    await setKv(PLUGIN_ID, "g1", "a", "1");
    await setKv(PLUGIN_ID, "g1", "b", "2");
    const res = await post("/api/plugin/storage.kv_list", { guild_id: "g1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ keys: ["a", "b"], total: 2 });
  });

  it("kv_list_values refuses a wrong-typed limit instead of defaulting it", async () => {
    const res = await post("/api/plugin/storage.kv_list_values", {
      guild_id: "g1",
      limit: "x",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "limit must be number" });
  });

  it("log.emit still skips a malformed entry rather than refusing the batch", async () => {
    // KEPT after #58: the per-entry skip is a documented batching
    // design — one bad entry must not sink the 99 good ones shipped
    // alongside it — not a normaliser accident. The route reports the
    // split via `accepted`/`deduped`.
    const res = await post("/api/plugin/log.emit", {
      entries: [
        { level: "info", message: 5 },
        { level: "shout", message: "m" },
        { level: "info", message: "kept" },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1, deduped: 0 });
    expect(botEventLog.record).toHaveBeenCalledTimes(1);
  });

  it("metrics.push still defaults wrong-typed snapshot fields", async () => {
    // KEPT after #58: the snapshot's inner shape belongs to the SDK's
    // MetricsCollector and is versioned with it; #58's enumeration
    // covers the body-level array quirk only.
    const res = await post("/api/plugin/metrics.push", {
      ts: "x",
      counters: "nope",
      gauges: 5,
      histograms: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("metrics.push refuses an array body instead of storing an empty snapshot", async () => {
    // Until #58 an array slipped through `typeof [] === 'object'` and
    // answered 200 with an empty snapshot stored.
    const res = await post("/api/plugin/metrics.push", [1, 2]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "snapshot object required" });
  });

  it("metrics.push's series cap stayed in the handler (it reads normalised values)", async () => {
    const res = await post("/api/plugin/metrics.push", {
      counters: Array.from({ length: 501 }, () => ({})),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "metric series cap exceeded" });
  });

  it("me/enabled_guilds stays unvalidated — a number body is still accepted", async () => {
    // The route reads no body at all today; per #53 the correct
    // conversion is no schema, not an invented constraint.
    const res = await post("/api/plugin/me/enabled_guilds", 5);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ guild_ids: [] });
  });
});
