/**
 * DELETE /api/plugins/:id must clear the deleted plugin's health + metrics
 * snapshots (keyed by pluginKey), so a same-key re-register doesn't inherit
 * stale state and orphaned entries don't linger across delete churn.
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

// The delete handler fans out to the command registry, event bridge, and
// host policy; mock them so the test exercises only the store cleanup.
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
import {
  setHealth,
  getHealth,
} from "../src/modules/plugin-system/plugin-health-store.js";
import {
  setSnapshot,
  getSnapshot,
} from "../src/modules/plugin-system/plugin-metrics-store.js";

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

describe("DELETE /api/plugins/:id", () => {
  it("clears the plugin's health + metrics snapshots", async () => {
    const pluginKey = "doomed-plugin";
    const row = await upsertPluginRegistration({
      pluginKey,
      name: "Doomed",
      version: "1.0.0",
      url: "http://localhost:9999",
      manifestJson: JSON.stringify({}),
      tokenHash: "hash-doomed",
    });

    await setHealth(pluginKey, { status: "healthy", checkedAt: Date.now() });
    await setSnapshot(pluginKey, {
      ts: Date.now(),
      counters: [],
      gauges: [],
      histograms: [],
    });
    expect(await getHealth(pluginKey)).not.toBeNull();
    expect(await getSnapshot(pluginKey)).not.toBeNull();

    // Active plugins can't be deleted; the reaper would normally flip this.
    await Plugin.update({ status: "inactive" }, { where: { id: row.id } });

    const res = await server.inject({
      method: "DELETE",
      url: `/api/plugins/${row.id}`,
    });
    expect(res.statusCode).toBe(204);

    expect(await getHealth(pluginKey)).toBeNull();
    expect(await getSnapshot(pluginKey)).toBeNull();
  });
});
