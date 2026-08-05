/**
 * #47 — the operator actions that moved to Plugin Admin, driven over
 * HTTP against the real routes and the real sqlite test database:
 *   POST /api/plugins/:id/enabled
 *   PUT  /api/plugins/:id/scopes
 *   PUT  /api/plugins/:id/global-event-subs
 *
 * Nothing internal is faked — the routes reach the real Plugin Admin,
 * the real plugin auth store, and the real models. Only what is outside
 * the process is mocked: host policy (it resolves DNS), the Discord
 * command registry, and the event bridge's outbound dispatch.
 *
 * `PUT /:id/scopes` already has HTTP coverage in plugin-scopes-route
 * .test.ts; what this file adds there is the live-token effect, which is
 * the part of the move that a DB assertion alone would not notice.
 *
 * (The fourth moved action, `approveAllScopes`, has no route of its own —
 * the admin UI's "approve all" is a PUT /:id/scopes carrying the full
 * requested list. It stays covered at the service seam in
 * plugin-scope-approval.test.ts.)
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
  findPluginByKey,
} from "../src/modules/plugin-system/models/plugin.model.js";
import { pluginAuthStore } from "../src/modules/plugin-system/plugin-auth.service.js";

let server: import("fastify").FastifyInstance;

const PLUGIN_KEY = "admin-actions-plugin";

function manifest(opts: {
  scopes?: string[];
  globalEventSubs?: string[];
}): unknown {
  return {
    schema_version: "1",
    plugin: {
      id: PLUGIN_KEY,
      name: "Admin Actions Plugin",
      version: "1.0.0",
      url: "http://localhost:9999",
    },
    rpc_methods_used: opts.scopes ?? [],
    events_subscribed_global: opts.globalEventSubs ?? [],
  };
}

async function seedPlugin(opts: {
  scopes?: string[];
  globalEventSubs?: string[];
}): Promise<number> {
  const row = await upsertPluginRegistration({
    pluginKey: PLUGIN_KEY,
    name: "Admin Actions Plugin",
    version: "1.0.0",
    url: "http://localhost:9999",
    manifestJson: JSON.stringify(manifest(opts)),
    tokenHash: "seed-hash",
    approvedRpcScopes: [],
    approvedGlobalEventSubs: [],
  });
  return row.id;
}

/** Put a live token in the real auth store, as a registration would. */
function issueLiveToken(pluginId: number, scopes: string[] = []): string {
  return pluginAuthStore.issue({ pluginId, pluginKey: PLUGIN_KEY, scopes })
    .token;
}

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
  await registerPluginRoutes(server, {
    // getReconciler() throws if absent; reconcileAll is fire-and-forget.
    reconciler: {
      reconcileAll: vi.fn().mockResolvedValue(undefined),
    } as never,
  });
  await server.ready();
});

beforeEach(async () => {
  await Plugin.destroy({ where: {} });
});

afterAll(async () => {
  await server.close();
  await sequelize.close();
});

describe("POST /api/plugins/:id/enabled", () => {
  it("disables a plugin, persists it, and revokes its live token", async () => {
    const id = await seedPlugin({});
    const token = issueLiveToken(id);
    expect(pluginAuthStore.verify(token)).not.toBeNull();

    const res = await server.inject({
      method: "POST",
      url: `/api/plugins/${id}/enabled`,
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      plugin: { id, pluginKey: PLUGIN_KEY, enabled: false },
    });
    expect((await findPluginByKey(PLUGIN_KEY))?.enabled).toBe(false);
    // "Disabled" has to mean disabled now, not after a cache expiry.
    expect(pluginAuthStore.verify(token)).toBeNull();
  });

  it("re-enables a plugin", async () => {
    const id = await seedPlugin({});
    await server.inject({
      method: "POST",
      url: `/api/plugins/${id}/enabled`,
      payload: { enabled: false },
    });

    const res = await server.inject({
      method: "POST",
      url: `/api/plugins/${id}/enabled`,
      payload: { enabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().plugin.enabled).toBe(true);
    expect((await findPluginByKey(PLUGIN_KEY))?.enabled).toBe(true);
  });

  it("rejects an invalid id with 400", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/plugins/0/enabled",
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid id" });
  });

  it("returns 404 for a missing plugin", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/plugins/99999/enabled",
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "plugin not found" });
  });
});

describe("PUT /api/plugins/:id/scopes", () => {
  it("applies the approved set to the plugin's live token", async () => {
    const id = await seedPlugin({ scopes: ["messages.send", "config.get"] });
    const token = issueLiveToken(id);

    const res = await server.inject({
      method: "PUT",
      url: `/api/plugins/${id}/scopes`,
      payload: { approved: ["messages.send"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().scopes).toEqual({
      requested: ["messages.send", "config.get"],
      approved: ["messages.send"],
      pending: ["config.get"],
    });
    // Same token string, new grant — no re-register needed.
    expect([...(pluginAuthStore.verify(token)?.scopes ?? [])]).toEqual([
      "messages.send",
    ]);
  });
});

describe("PUT /api/plugins/:id/global-event-subs", () => {
  it("clamps to the declared set, persists, and returns the new state", async () => {
    const id = await seedPlugin({
      globalEventSubs: ["messageCreate", "guildMemberAdd"],
    });

    const res = await server.inject({
      method: "PUT",
      url: `/api/plugins/${id}/global-event-subs`,
      payload: { approved: ["messageCreate", "neverDeclared"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().globalEventSubs).toEqual({
      requested: ["messageCreate", "guildMemberAdd"],
      approved: ["messageCreate"],
      pending: ["guildMemberAdd"],
    });
    expect(
      (await findPluginByKey(PLUGIN_KEY))?.approvedGlobalEventSubs,
    ).toEqual(["messageCreate"]);
  });

  it("rejects a non-array body with 400", async () => {
    const id = await seedPlugin({ globalEventSubs: ["messageCreate"] });
    const res = await server.inject({
      method: "PUT",
      url: `/api/plugins/${id}/global-event-subs`,
      payload: { approved: "messageCreate" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "approved must be a string array" });
  });

  it("rejects an invalid id with 400", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/plugins/0/global-event-subs",
      payload: { approved: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid id" });
  });

  it("returns 404 for a missing plugin", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/plugins/99999/global-event-subs",
      payload: { approved: [] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "plugin not found" });
  });
});
