/**
 * #51 (A4) — the admin reads that moved into Plugin Admin, driven over
 * HTTP against the real routes and the real sqlite test database:
 *   GET /api/plugins                  (the list assembly)
 *   GET /api/plugins/:id              (by-id detail)
 *   GET /api/plugins/by-key/:key      (by-key detail)
 *   GET /api/plugins/:id/config
 *   GET /api/plugins/:id/settings     (config + KV usage + overrides)
 *
 * This is a refactor pin, not new behaviour: the assertions snapshot the
 * response *shape* (field set and the four runtime sources — sdkCompat,
 * eventSubscriptions, dispatch health, command-sync state — plus KV
 * usage) exactly as the routes emitted it before the move. Nothing
 * internal is faked — the routes reach the real Plugin Admin and the
 * real models; only what's outside the process is mocked.
 *
 * The other half of #51 — the by-id reads no longer being written as
 * full-list scans — is not observable over HTTP (a scan and a by-id
 * lookup return the same rows); it is verified by construction: the
 * scans no longer exist in the source. No spy test against internals,
 * per the spec's testing decisions.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
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

vi.mock(
  "../src/modules/plugin-system/plugin-command-registry.service.js",
  () => ({
    pluginCommandRegistry: {
      assertNoCollisions: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      unregisterAll: vi.fn().mockResolvedValue(undefined),
      syncFeatureCommandsForGuild: vi.fn().mockResolvedValue(undefined),
    },
    ManifestCommandError: class ManifestCommandError extends Error {},
  }),
);

import { sequelize } from "../src/db.js";
import {
  Plugin,
  upsertPluginRegistration,
} from "../src/modules/plugin-system/models/plugin.model.js";
import { PluginKv } from "../src/modules/plugin-system/models/plugin-kv.model.js";

let server: import("fastify").FastifyInstance;

const PLUGIN_KEY = "admin-reads-plugin";

function manifest(): unknown {
  return {
    schema_version: "1",
    plugin: {
      id: PLUGIN_KEY,
      name: "Admin Reads Plugin",
      version: "1.0.0",
      url: "http://localhost:9999",
    },
    rpc_methods_used: ["messages.send"],
    events_subscribed_global: [],
    config_schema: [
      { key: "greeting", label: "Greeting", type: "string" },
      { key: "api_key", label: "API key", type: "secret" },
    ],
  };
}

async function seedPlugin(): Promise<number> {
  const row = await upsertPluginRegistration({
    pluginKey: PLUGIN_KEY,
    name: "Admin Reads Plugin",
    version: "1.0.0",
    url: "http://localhost:9999",
    manifestJson: JSON.stringify(manifest()),
    tokenHash: "seed-hash",
    approvedRpcScopes: ["messages.send"],
    approvedGlobalEventSubs: [],
  });
  return row.id;
}

beforeAll(async () => {
  const fastify = (await import("fastify")).default;
  // Import the routes BEFORE sync so every model they touch (plugin
  // config, plugin commands, feature rows) is registered on the
  // sequelize instance when the tables are created.
  const { registerPluginRoutes } = await import(
    "../src/modules/plugin-system/plugin-routes.js"
  );
  await sequelize.sync({ force: true });
  server = fastify({ logger: false });
  server.addHook("onRequest", (req, _reply, done) => {
    (req as unknown as { authUserId: string }).authUserId = "admin-user";
    (req as unknown as { authCapabilities: Set<string> }).authCapabilities =
      new Set(["admin"]);
    done();
  });
  await registerPluginRoutes(server, {
    reconciler: {
      reconcileAll: vi.fn().mockResolvedValue(undefined),
    } as never,
  });
  await server.ready();
});

beforeEach(async () => {
  await Plugin.destroy({ where: {} });
  await PluginKv.destroy({ where: {} });
});

afterAll(async () => {
  await server.close();
  await sequelize.close();
});

describe("GET /api/plugins — the list assembly, now one Plugin Admin operation", () => {
  it("carries the row fields plus all four runtime sources, shape pinned", async () => {
    const id = await seedPlugin();

    const res = await server.inject({ method: "GET", url: "/api/plugins" });
    expect(res.statusCode).toBe(200);
    const { plugins } = res.json();
    expect(plugins).toHaveLength(1);
    const entry = plugins[0];

    // The exact field set (and order — JSON.stringify preserves
    // insertion order, and the frontend consumes this body verbatim).
    expect(Object.keys(entry)).toEqual([
      "id",
      "pluginKey",
      "name",
      "version",
      "url",
      "status",
      "enabled",
      "lastHeartbeatAt",
      "manifest",
      "rpcMethods",
      "approvedRpcScopes",
      "pendingRpcScopes",
      "approvedGlobalEventSubs",
      "pendingGlobalEventSubs",
      "commandSync",
      "dispatch",
      "sdkCompat",
      "eventSubscriptions",
    ]);

    expect(entry.id).toBe(id);
    expect(entry.pluginKey).toBe(PLUGIN_KEY);
    expect(entry.manifest).toEqual(manifest());
    expect(entry.rpcMethods).toEqual(["messages.send"]);
    expect(entry.approvedRpcScopes).toEqual(["messages.send"]);
    expect(entry.pendingRpcScopes).toEqual([]);
    // The four runtime sources the route used to compose inline:
    // no sync/dispatch attempted since this process started → null …
    expect(entry.commandSync).toBeNull();
    expect(entry.dispatch).toBeNull();
    // … and the two manifest verdicts, evaluated exactly as before.
    // This manifest has no sdk_version, so the compat verdict flags it.
    expect(entry.sdkCompat.status).toBe("unknown");
    expect(entry.eventSubscriptions.status).toBe("ok");
    expect(entry.eventSubscriptions.unknown).toEqual([]);
  });
});

describe("GET /api/plugins/:id — by-id detail via Plugin Admin", () => {
  it("returns the detail body with verdicts inline", async () => {
    const id = await seedPlugin();

    const res = await server.inject({
      method: "GET",
      url: `/api/plugins/${id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body)).toEqual([
      "plugin",
      "commandSync",
      "dispatch",
      "sdkCompat",
      "eventSubscriptions",
    ]);
    expect(body.plugin.id).toBe(id);
    expect(body.plugin.pluginKey).toBe(PLUGIN_KEY);
    expect(body.plugin.manifest).toEqual(manifest());
    expect(body.sdkCompat.status).toBe("unknown");
    expect(body.eventSubscriptions.status).toBe("ok");
  });

  it("404s a missing id with the unchanged body", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/plugins/999999",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "plugin not found" });
  });
});

describe("GET /api/plugins/by-key/:pluginKey — by-key detail via Plugin Admin", () => {
  it("returns the security-tab fields and third-track commands", async () => {
    const id = await seedPlugin();

    const res = await server.inject({
      method: "GET",
      url: `/api/plugins/by-key/${PLUGIN_KEY}`,
    });
    expect(res.statusCode).toBe(200);
    const { plugin } = res.json();
    expect(plugin.id).toBe(id);
    expect(plugin.rpcMethods).toEqual(["messages.send"]);
    expect(plugin.pendingRpcScopes).toEqual([]);
    expect(typeof plugin.autoApproveScopes).toBe("boolean");
    expect(plugin.pluginCommands).toEqual([]);
    expect(plugin.sdkCompat.status).toBe("unknown");
    expect(plugin.eventSubscriptions.status).toBe("ok");
  });

  it("404s an unknown key with the unchanged body", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/plugins/by-key/no-such-plugin",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "plugin not found" });
  });
});

describe("GET /api/plugins/:id/config and /settings via Plugin Admin", () => {
  it("joins the schema with stored values, secrets masked", async () => {
    const id = await seedPlugin();

    const res = await server.inject({
      method: "GET",
      url: `/api/plugins/${id}/config`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body)).toEqual([
      "schema",
      "configSchemaVersion",
      "storedConfigSchemaVersion",
      "values",
    ]);
    expect(body.values).toEqual([
      { key: "greeting", set: false, value: null },
      { key: "api_key", set: false, value: null },
    ]);
  });

  it("settings carries the config payload plus KV usage vs quota", async () => {
    const id = await seedPlugin();
    // Two keys in one guild — usage must aggregate, never expose values.
    await PluginKv.create({
      pluginId: id,
      guildId: "guild-1",
      key: "a",
      value: "xxxx",
      bytes: 4,
    });
    await PluginKv.create({
      pluginId: id,
      guildId: "guild-1",
      key: "b",
      value: "xxxxxx",
      bytes: 6,
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/plugins/${id}/settings`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body)).toEqual([
      "config",
      "kv",
      "featureOverrides",
      "guildNames",
    ]);
    expect(body.config.schema).toHaveLength(2);
    // Manifest declares no storage quota → the bot-wide 64 KiB default.
    expect(body.kv).toEqual({
      quotaBytes: 64 * 1024,
      guilds: [{ guildId: "guild-1", keyCount: 2, usedBytes: 10 }],
    });
    expect(body.featureOverrides).toEqual([]);
    // No bot client injected in this test server → cache miss → null,
    // exactly what the route produced before the move.
    expect(body.guildNames).toEqual({ "guild-1": null });
  });

  it("404s a missing id on both, bodies unchanged", async () => {
    for (const url of [
      "/api/plugins/999999/config",
      "/api/plugins/999999/settings",
    ]) {
      const res = await server.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "plugin not found" });
    }
  });
});
