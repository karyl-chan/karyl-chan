/**
 * #49 — the delete teardown moved into Plugin Admin, asserted through
 * observable consequences over HTTP (never by spying on which cache-
 * clearing function was called — the step ordering stays free to
 * change):
 *
 *   - after DELETE the row is gone (re-GET → 404) and the records the
 *     teardown explicitly cleans are gone (plugin_capabilities rows,
 *     `plugin:<key>:*` grants in admin_role_capabilities)
 *   - a dispatch after the delete no longer reaches the plugin (a real
 *     local HTTP server plays the plugin; the positive control proves
 *     the harness would see a delivery)
 *   - a plugin re-registered under the same key inherits no health /
 *     metrics / dispatch-health / dispatch-pool state
 *   - a best-effort step that throws (command registry unregisterAll
 *     rejecting) does not fail the delete
 *
 * Real routes over `server.inject`, real sqlite test DB, real Plugin
 * Admin, real event bridge and dispatch pool. Faked: host policy (it
 * resolves DNS) and the Discord command registry (outside the process);
 * outbound HTTP terminates at the local fake plugin server.
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
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
});

vi.mock("../src/utils/host-policy.js", () => ({
  assertPluginTarget: vi.fn().mockResolvedValue(undefined),
  HostPolicyError: class HostPolicyError extends Error {},
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
  findPluginById,
} from "../src/modules/plugin-system/models/plugin.model.js";
import {
  PluginCapability,
  findCapabilitiesByPlugin,
} from "../src/modules/plugin-system/models/plugin-capability.model.js";
import { AdminRole } from "../src/modules/admin/models/admin-role.model.js";
import { AdminRoleCapability } from "../src/modules/admin/models/admin-role-capability.model.js";
import { makePluginCapabilityToken } from "../src/modules/admin/admin-capabilities.js";
import {
  rebuildEventIndex,
  dispatchEventToPlugins,
  getDispatchPoolSnapshot,
  stopDispatchPool,
} from "../src/modules/plugin-system/plugin-event-bridge.service.js";
import {
  setHealth,
  getHealth,
} from "../src/modules/plugin-system/plugin-health-store.js";
import {
  setSnapshot,
  getSnapshot,
} from "../src/modules/plugin-system/plugin-metrics-store.js";
import {
  recordDispatchHttpFailure,
  getDispatchHealth,
  __resetDispatchHealthForTests,
} from "../src/modules/plugin-system/plugin-dispatch-health.service.js";
import { pluginCommandRegistry } from "../src/modules/plugin-system/plugin-command-registry.service.js";

let server: import("fastify").FastifyInstance;
let pluginServer: Server;
let pluginUrl: string;
/** POST bodies the fake plugin actually received, by path. */
let received: string[];

const PLUGIN_KEY = "doomed-teardown-plugin";
const EVENT = "guild.message_create";

async function seedPlugin(): Promise<number> {
  const manifest = {
    schema_version: "1",
    plugin: {
      id: PLUGIN_KEY,
      name: "Doomed Teardown Plugin",
      version: "1.0.0",
      url: pluginUrl,
    },
    events_subscribed_global: [EVENT],
  };
  const row = await upsertPluginRegistration({
    pluginKey: PLUGIN_KEY,
    name: "Doomed Teardown Plugin",
    version: "1.0.0",
    url: pluginUrl,
    manifestJson: JSON.stringify(manifest),
    tokenHash: "hash-doomed-teardown",
    approvedGlobalEventSubs: [EVENT],
  });
  // The dispatch path refuses to POST unsigned; give the row a key the
  // way register would.
  await Plugin.update(
    { dispatchHmacKey: "test-hmac-key" },
    { where: { id: row.id } },
  );
  await rebuildEventIndex();
  return row.id;
}

/** Flip to inactive — the DELETE route 409s an active plugin. */
async function deactivate(id: number): Promise<void> {
  await Plugin.update({ status: "inactive" }, { where: { id } });
}

async function deletePluginOverHttp(id: number): Promise<number> {
  const res = await server.inject({
    method: "DELETE",
    url: `/api/plugins/${id}`,
  });
  return res.statusCode;
}

/** Let the fire-and-forget dispatch fan-out settle. */
function settle(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeAll(async () => {
  await sequelize.sync({ force: true });

  // A real local HTTP server plays the plugin, so "a dispatch reached
  // the plugin" is observed at the seam that matters: the wire.
  received = [];
  pluginServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      received.push(`${req.method} ${req.url}`);
      res.statusCode = 200;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => pluginServer.listen(0, "127.0.0.1", r));
  const addr = pluginServer.address() as AddressInfo;
  pluginUrl = `http://127.0.0.1:${addr.port}`;

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
    reconciler: {
      reconcileAll: vi.fn().mockResolvedValue(undefined),
    } as never,
  });
  await server.ready();
});

beforeEach(async () => {
  await AdminRoleCapability.destroy({ where: {} });
  await AdminRole.destroy({ where: {} });
  await PluginCapability.destroy({ where: {} });
  await Plugin.destroy({ where: {} });
  await rebuildEventIndex();
  __resetDispatchHealthForTests();
  received.length = 0;
  vi.mocked(pluginCommandRegistry.unregisterAll).mockReset();
  vi.mocked(pluginCommandRegistry.unregisterAll).mockResolvedValue(undefined);
});

afterAll(async () => {
  await stopDispatchPool();
  await server.close();
  await new Promise<void>((r) => pluginServer.close(() => r()));
  await sequelize.close();
});

describe("DELETE /api/plugins/:id (Plugin Admin teardown)", () => {
  it("removes the row (re-GET 404) and the records the teardown owns", async () => {
    const id = await seedPlugin();
    await deactivate(id);

    expect(await deletePluginOverHttp(id)).toBe(204);

    const get = await server.inject({
      method: "GET",
      url: `/api/plugins/${id}`,
    });
    expect(get.statusCode).toBe(404);
    expect(await findPluginById(id)).toBeNull();
  });

  it("purges the plugin's capability grants from admin roles, and only those", async () => {
    const id = await seedPlugin();
    await deactivate(id);
    await PluginCapability.create({
      pluginId: id,
      capKey: "panel.view",
      description: "view the panel",
    });
    await AdminRole.create({ name: "ops", description: null });
    const doomedToken = makePluginCapabilityToken(PLUGIN_KEY, "panel.view");
    await AdminRoleCapability.create({ role: "ops", capability: doomedToken });
    await AdminRoleCapability.create({
      role: "ops",
      capability: "plugin:other-plugin:panel.view",
    });

    expect(await deletePluginOverHttp(id)).toBe(204);

    expect(await findCapabilitiesByPlugin(id)).toEqual([]);
    const remaining = (
      await AdminRoleCapability.findAll({ where: { role: "ops" } })
    ).map((r) => r.getDataValue("capability"));
    expect(remaining).not.toContain(doomedToken);
    // Another plugin's grant is untouched.
    expect(remaining).toContain("plugin:other-plugin:panel.view");
  });

  it("a dispatch after the delete no longer reaches the plugin", async () => {
    const id = await seedPlugin();

    // Positive control: while registered and active, a dispatch reaches
    // the fake plugin server — so silence below is meaningful.
    dispatchEventToPlugins(EVENT, { n: 1 });
    await vi.waitFor(() => {
      expect(received.some((r) => r === "POST /events")).toBe(true);
    });

    await deactivate(id);
    expect(await deletePluginOverHttp(id)).toBe(204);

    received.length = 0;
    dispatchEventToPlugins(EVENT, { n: 2 });
    await settle();
    expect(received).toEqual([]);
  });

  it("a same-key re-register inherits no health / metrics / dispatch state", async () => {
    const id = await seedPlugin();

    // Leave every per-key trace a live plugin would have left behind.
    await setHealth(PLUGIN_KEY, { status: "healthy", checkedAt: Date.now() });
    await setSnapshot(PLUGIN_KEY, {
      ts: Date.now(),
      counters: [],
      gauges: [],
      histograms: [],
    });
    recordDispatchHttpFailure(PLUGIN_KEY, "event", EVENT, 500, "boom");
    dispatchEventToPlugins(EVENT, { n: 1 });
    await vi.waitFor(() => {
      expect(
        getDispatchPoolSnapshot().some((e) => e.pluginKey === PLUGIN_KEY),
      ).toBe(true);
    });

    await deactivate(id);
    expect(await deletePluginOverHttp(id)).toBe(204);

    // Re-register under the same key: genuinely clean slate.
    const freshId = await seedPlugin();
    expect(freshId).not.toBe(id);
    expect(await getHealth(PLUGIN_KEY)).toBeNull();
    expect(await getSnapshot(PLUGIN_KEY)).toBeNull();
    expect(getDispatchHealth(PLUGIN_KEY)).toBeNull();
    expect(
      getDispatchPoolSnapshot().some((e) => e.pluginKey === PLUGIN_KEY),
    ).toBe(false);
  });

  it("a best-effort step that throws does not fail the delete", async () => {
    const id = await seedPlugin();
    await deactivate(id);
    vi.mocked(pluginCommandRegistry.unregisterAll).mockRejectedValue(
      new Error("discord is down"),
    );

    expect(await deletePluginOverHttp(id)).toBe(204);
    expect(await findPluginById(id)).toBeNull();
  });

  it("404s an unknown id and 400s a malformed one (parsing stays route-side)", async () => {
    expect(await deletePluginOverHttp(999999)).toBe(404);
    const res = await server.inject({
      method: "DELETE",
      url: "/api/plugins/not-a-number",
    });
    expect(res.statusCode).toBe(400);
  });

  it("still refuses an active plugin with 409 (pre-existing guard, unchanged)", async () => {
    const id = await seedPlugin(); // upsert leaves status "active"
    expect(await deletePluginOverHttp(id)).toBe(409);
    expect(await findPluginById(id)).not.toBeNull();
  });
});
