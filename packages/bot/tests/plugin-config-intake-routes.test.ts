/**
 * A3 (#50) — Config Intake: the two config-write paths share one front
 * half (normalize → validate → secret sentinel → encryption) feeding
 * two Plugin Admin operations that keep their own persistence and
 * follow-on effects.
 *
 * Pins, per the #30 consensus:
 *  - decision 8 (the ONE behaviour change): the plugin-level path now
 *    accepts JSON booleans/numbers and coerces them to string form —
 *    with the documented caveat that per-key string storage cannot
 *    round-trip a native type, while the document-backed guild path
 *    returns it verbatim
 *  - a secret left untouched (sentinel) keeps its stored value on BOTH
 *    paths — including the guild path, whose document is replaced
 *    wholesale
 *  - a failed save reports EVERY bad field at once, in the exact
 *    `{ error, fieldErrors }` shape the frontend parses
 *  - unknown-key policy stays per-caller: guild tolerates + preserves
 *    native, plugin-level rejects
 *  - request parsing resolves before the operation (400 before 404)
 */
import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/utils/host-policy.js", () => ({
  assertPluginTarget: vi.fn().mockResolvedValue(undefined),
  HostPolicyError: class HostPolicyError extends Error {},
}));

vi.mock("../src/modules/plugin-system/plugin-event-bridge.service.js", () => ({
  rebuildEventIndex: vi.fn().mockResolvedValue(undefined),
  dispatchEventToPlugins: vi.fn(),
  getEventIndexSize: vi.fn().mockReturnValue(0),
  applyPluginChange: vi.fn(),
  removePluginFromIndex: vi.fn(),
  dropDispatchPoolForPlugin: vi.fn(),
  getDispatchPoolSnapshot: vi.fn().mockReturnValue([]),
  stopDispatchPool: vi.fn().mockResolvedValue(undefined),
}));

const syncFeatureCommandsForGuild = vi.fn().mockResolvedValue(undefined);
vi.mock(
  "../src/modules/plugin-system/plugin-command-registry.service.js",
  () => ({
    pluginCommandRegistry: {
      assertNoCollisions: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      unregisterAll: vi.fn().mockResolvedValue(undefined),
      syncFeatureCommandsForGuild,
    },
    ManifestCommandError: class ManifestCommandError extends Error {},
  }),
);

const dispatchLifecycleToPlugin = vi.fn();
vi.mock(
  "../src/modules/plugin-system/plugin-lifecycle-dispatch.service.js",
  () => ({
    dispatchLifecycleToPlugin,
  }),
);

import { sequelize } from "../src/db.js";
import {
  Plugin,
  findPluginById,
  upsertPluginRegistration,
} from "../src/modules/plugin-system/models/plugin.model.js";
import {
  PluginConfig,
  findConfigKey,
} from "../src/modules/plugin-system/models/plugin-config.model.js";
import {
  PluginGuildFeature,
  findFeatureRow,
} from "../src/modules/feature-toggle/models/plugin-guild-feature.model.js";
// Side-effect imports: register the plugin_feature_defaults and
// bot_events models so sync() creates their tables — the feature-reach
// resolver queries the former, the bot event log writes the latter.
import "../src/modules/feature-toggle/models/plugin-feature-default.model.js";
import "../src/modules/bot-events/models/bot-event.model.js";
import { decryptSecret } from "../src/utils/crypto.js";

const GUILD = "900000000000000060";

function manifest() {
  return {
    schema_version: "1",
    plugin: {
      id: "intake-plugin",
      name: "Intake Plugin",
      version: "1.0.0",
      url: "http://localhost:9999",
    },
    config_schema_version: 3,
    config_schema: [
      { key: "flag", type: "boolean", label: "Flag" },
      { key: "n", type: "number", label: "N", min: 1, max: 100 },
      { key: "sec", type: "secret", label: "Sec" },
      { key: "note", type: "text", label: "Note" },
    ],
    guild_features: [
      {
        key: "cfg",
        name: "Configurable",
        enabled_by_default: false,
        config_schema: [
          { key: "flag", type: "boolean", label: "Flag" },
          { key: "n", type: "number", label: "N", min: 1, max: 100 },
          { key: "sec", type: "secret", label: "Sec" },
          { key: "note", type: "text", label: "Note" },
        ],
      },
    ],
  };
}

async function seedPlugin(): Promise<number> {
  const row = await upsertPluginRegistration({
    pluginKey: "intake-plugin",
    name: "Intake Plugin",
    version: "1.0.0",
    url: "http://localhost:9999",
    manifestJson: JSON.stringify(manifest()),
    tokenHash: "seed-hash",
  });
  return row.id;
}

let server: import("fastify").FastifyInstance;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  const fastify = (await import("fastify")).default;
  const { registerPluginRoutes } = await import(
    "../src/modules/plugin-system/plugin-routes.js"
  );
  server = fastify({ logger: false });
  server.addHook("onRequest", (req, _reply, done) => {
    (req as unknown as { authUserId: string }).authUserId = "admin-user";
    (req as unknown as { authCapabilities: Set<string> }).authCapabilities =
      new Set(["admin"]);
    done();
  });
  await registerPluginRoutes(server);
  await server.ready();
});

beforeEach(async () => {
  await Plugin.destroy({ where: {} });
  await PluginConfig.destroy({ where: {} });
  await PluginGuildFeature.destroy({ where: {} });
  syncFeatureCommandsForGuild.mockClear();
  dispatchLifecycleToPlugin.mockClear();
});

afterAll(async () => {
  await server.close();
});

const putConfig = (id: number | string, values: unknown) =>
  server.inject({
    method: "PUT",
    url: `/api/plugins/${id}/config`,
    payload: { values },
  });

const putFeature = (id: number | string, body: Record<string, unknown>) =>
  server.inject({
    method: "PUT",
    url: `/api/plugins/${id}/guilds/${GUILD}/features/cfg`,
    payload: body,
  });

const featureDoc = async (id: number) => {
  const row = await findFeatureRow(id, GUILD, "cfg");
  return JSON.parse(row!.configJson) as Record<string, unknown>;
};

describe("PUT /api/plugins/:id/config — plugin-level save", () => {
  it("decision 8 widening: accepts JSON boolean/number and stores their string forms", async () => {
    const id = await seedPlugin();
    const res = await putConfig(id, { flag: false, n: 42 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: ["flag", "n"], skipped: [] });
    // Per-key string storage: the native types are coerced, not kept.
    expect((await findConfigKey(id, "flag"))?.value).toBe("false");
    expect((await findConfigKey(id, "n"))?.value).toBe("42");
    // Round-trip caveat pinned: this path returns the coerced STRING,
    // not the boolean/number the caller sent (the document-backed
    // guild path is the only one that returns natives verbatim).
    const read = await server.inject({
      method: "GET",
      url: `/api/plugins/${id}/config`,
    });
    const byKey = new Map(
      (read.json().values as Array<{ key: string; value: unknown }>).map(
        (v) => [v.key, v.value],
      ),
    );
    expect(byKey.get("flag")).toBe("false");
    expect(byKey.get("n")).toBe("42");
    // Coerced values still hit the validator: 442 is out of range.
    const bad = await putConfig(id, { n: 442 });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().fieldErrors).toEqual([
      { key: "n", message: "N must be ≤ 100", code: "range" },
    ]);
  });

  it("still stamps the schema version after a widened save", async () => {
    const id = await seedPlugin();
    await putConfig(id, { flag: true });
    expect((await findPluginById(id))?.configSchemaVersion).toBe(3);
  });

  it("a secret left untouched (sentinel) keeps its stored value", async () => {
    const id = await seedPlugin();
    expect((await putConfig(id, { sec: "hunter2" })).statusCode).toBe(200);
    const stored = (await findConfigKey(id, "sec"))!.value;
    expect(decryptSecret(stored)).toBe("hunter2");

    const res = await putConfig(id, { sec: "********", note: "hi" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: ["note"], skipped: ["sec"] });
    // Byte-identical ciphertext: the row was never rewritten.
    expect((await findConfigKey(id, "sec"))!.value).toBe(stored);
  });

  it("422 accumulates EVERY bad field at once, in the exact shape", async () => {
    const id = await seedPlugin();
    const res = await putConfig(id, {
      obj: { nested: true },
      n: "nope",
      flag: "maybe",
      ghost: "x",
    });
    expect(res.statusCode).toBe(422);
    // Exact body: normalization errors first, then unknown keys, then
    // schema-order field errors. The frontend parses this shape.
    expect(res.json()).toEqual({
      error: "config validation failed",
      fieldErrors: [
        { key: "obj", message: "'obj' must be a string", code: "type_mismatch" },
        { key: "ghost", message: 'unknown config key "ghost"', code: "unknown_key" },
        { key: "flag", message: 'Flag must be "true" or "false"', code: "type_mismatch" },
        { key: "n", message: "N must be a number", code: "type_mismatch" },
      ],
    });
    // Nothing persisted on refusal.
    expect(await findConfigKey(id, "flag")).toBeNull();
  });

  it("parsing resolves before the operation: malformed body 400s even for a missing plugin", async () => {
    const bad = await putConfig(999999, "not-an-object");
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "values object required" });
    const missing = await putConfig(999999, { flag: true });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "plugin not found" });
  });
});

describe("PUT /api/plugins/:id/guilds/:guildId/features/:featureKey — per-guild save", () => {
  it("keeps native types in the document and tolerates unknown keys (per-caller policy)", async () => {
    const id = await seedPlugin();
    const res = await putFeature(id, {
      enabled: true,
      config: { flag: false, n: 42, mystery: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().feature).toMatchObject({
      pluginId: id,
      guildId: GUILD,
      featureKey: "cfg",
      enabled: true,
    });
    // Document-backed storage round-trips natives verbatim — including
    // the unknown key, preserved with the caller's native type.
    expect(await featureDoc(id)).toEqual({ flag: false, n: 42, mystery: 7 });
  });

  it("a secret left untouched (sentinel) keeps its stored value across the wholesale document replace", async () => {
    const id = await seedPlugin();
    expect(
      (await putFeature(id, { config: { sec: "hunter2", note: "a" } }))
        .statusCode,
    ).toBe(200);
    const doc1 = await featureDoc(id);
    expect(decryptSecret(doc1.sec as string)).toBe("hunter2");

    const res = await putFeature(id, {
      config: { sec: "********", note: "b" },
    });
    expect(res.statusCode).toBe(200);
    const doc2 = await featureDoc(id);
    // Untouched secret survives byte-identically; the touched field moved.
    expect(doc2.sec).toBe(doc1.sec);
    expect(doc2.note).toBe("b");
  });

  it("an UNKNOWN key holding the literal sentinel is dropped, not stored", async () => {
    const id = await seedPlugin();
    const res = await putFeature(id, {
      config: { ghost: "********", note: "a" },
    });
    expect(res.statusCode).toBe(200);
    expect(await featureDoc(id)).toEqual({ note: "a" });
  });

  it("422 uses the same accumulated shape as the plugin-level path", async () => {
    const id = await seedPlugin();
    const res = await putFeature(id, {
      config: { n: "nope", flag: "maybe" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: "config validation failed",
      fieldErrors: [
        { key: "flag", message: 'Flag must be "true" or "false"', code: "type_mismatch" },
        { key: "n", message: "N must be a number", code: "type_mismatch" },
      ],
    });
    expect(await findFeatureRow(id, GUILD, "cfg")).toBeNull();
  });

  it("404s carry the pre-existing bodies for a missing plugin / undeclared feature", async () => {
    const id = await seedPlugin();
    const badPlugin = await putFeature(999999, { enabled: true });
    expect(badPlugin.statusCode).toBe(404);
    expect(badPlugin.json()).toEqual({ error: "plugin not found" });
    const badFeature = await server.inject({
      method: "PUT",
      url: `/api/plugins/${id}/guilds/${GUILD}/features/nope`,
      payload: { enabled: true },
    });
    expect(badFeature.statusCode).toBe(404);
    expect(badFeature.json()).toEqual({
      error: "feature 'nope' not declared by plugin",
    });
  });

  it("parsing resolves before the operation: non-object config 400s even for a missing plugin", async () => {
    const res = await putFeature(999999, { config: "not-an-object" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "config must be an object" });
  });

  it("keeps the follow-on effects: command sync every save, lifecycle only on a real flip", async () => {
    const id = await seedPlugin();
    const first = await putFeature(id, { enabled: true });
    expect(first.statusCode).toBe(200);
    expect(syncFeatureCommandsForGuild).toHaveBeenCalledTimes(1);
    expect(dispatchLifecycleToPlugin).toHaveBeenCalledTimes(1);
    expect(dispatchLifecycleToPlugin).toHaveBeenCalledWith(
      id,
      "plugin.guild.enabled",
      GUILD,
      "cfg",
    );
    // Unchanged re-submit: synced again, but no lifecycle re-fire.
    await putFeature(id, { enabled: true });
    expect(syncFeatureCommandsForGuild).toHaveBeenCalledTimes(2);
    expect(dispatchLifecycleToPlugin).toHaveBeenCalledTimes(1);
    // Config-only save: keeps the effective enabled, no lifecycle.
    const cfgOnly = await putFeature(id, { config: { note: "x" } });
    expect(cfgOnly.json().feature.enabled).toBe(true);
    expect(dispatchLifecycleToPlugin).toHaveBeenCalledTimes(1);
  });
});
