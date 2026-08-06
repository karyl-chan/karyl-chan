/**
 * #52 (A5) — the last admin routes brought behind Plugin Admin, driven
 * over HTTP against the real routes and the real sqlite test database:
 *   PUT   /api/plugins/:id/feature-defaults/:featureKey
 *   PATCH /api/plugin-commands/:id/admin-enabled
 *   POST  /api/plugins/:id/dispatch-probe
 *
 * Nothing internal is faked — the routes reach the real Plugin Admin
 * and the real models. Only what is outside the process is mocked:
 * host policy (it resolves DNS), the Discord command registry, and the
 * event bridge's outbound dispatch. Assertions are on what an operator
 * can observe: status codes, bodies, and persisted rows — never on
 * which internal function got called.
 *
 * (The routes this increment merely re-homed — the delete 409 now
 * returned as the `conflict` refusal, the guild-override DELETE, and
 * setup-secret — keep their existing HTTP coverage in
 * plugin-admin-teardown.test.ts, plugin-guild-feature-routes.test.ts,
 * and plugin-per-plugin-secret.test.ts.)
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
      syncFeatureCommandsAcrossGuilds: vi.fn().mockResolvedValue(undefined),
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
  PluginCommand,
  findPluginCommandsByPlugin,
  upsertPluginCommand,
} from "../src/modules/plugin-system/models/plugin-command.model.js";
import {
  PluginFeatureDefault,
  findFeatureDefault,
} from "../src/modules/feature-toggle/models/plugin-feature-default.model.js";

let server: import("fastify").FastifyInstance;

const PLUGIN_KEY = "remaining-routes-plugin";

const MANIFEST = {
  schema_version: "1",
  plugin: {
    id: PLUGIN_KEY,
    name: "Remaining Routes Plugin",
    version: "1.0.0",
    url: "http://localhost:9999",
  },
  guild_features: [
    {
      key: "greeter",
      name: "Greeter",
      enabled_by_default: false,
    },
  ],
};

async function seedPlugin(): Promise<number> {
  const row = await upsertPluginRegistration({
    pluginKey: PLUGIN_KEY,
    name: "Remaining Routes Plugin",
    version: "1.0.0",
    url: "http://localhost:9999",
    manifestJson: JSON.stringify(MANIFEST),
    tokenHash: "seed-hash",
  });
  return row.id;
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
    // Both reconcile entry points are fire-and-forget; the routes only
    // need getReconciler() to resolve.
    reconciler: {
      reconcileAll: vi.fn().mockResolvedValue(undefined),
      reconcileForPluginCommand: vi.fn().mockResolvedValue(undefined),
    } as never,
  });
  await server.ready();
});

beforeEach(async () => {
  await Plugin.destroy({ where: {} });
  await PluginCommand.destroy({ where: {} });
  await PluginFeatureDefault.destroy({ where: {} });
});

afterAll(async () => {
  await server.close();
  await sequelize.close();
});

describe("PUT /api/plugins/:id/feature-defaults/:featureKey", () => {
  it("persists the Operator Default and returns it", async () => {
    const id = await seedPlugin();

    const res = await server.inject({
      method: "PUT",
      url: `/api/plugins/${id}/feature-defaults/greeter`,
      payload: { enabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      default: { pluginId: id, featureKey: "greeter", enabled: true },
    });
    expect((await findFeatureDefault(id, "greeter"))?.enabled).toBe(true);
  });

  it("rejects a feature the manifest never declared with 404", async () => {
    const id = await seedPlugin();
    const res = await server.inject({
      method: "PUT",
      url: `/api/plugins/${id}/feature-defaults/never-declared`,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: "feature 'never-declared' not declared by plugin",
    });
    expect(await findFeatureDefault(id, "never-declared")).toBeNull();
  });

  it("returns 404 for a missing plugin", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/plugins/99999/feature-defaults/greeter",
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "plugin not found" });
  });

  it("rejects a non-boolean body with 400 before touching anything", async () => {
    const id = await seedPlugin();
    const res = await server.inject({
      method: "PUT",
      url: `/api/plugins/${id}/feature-defaults/greeter`,
      payload: { enabled: "yes" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "enabled boolean required" });
    expect(await findFeatureDefault(id, "greeter")).toBeNull();
  });
});

describe("PATCH /api/plugin-commands/:id/admin-enabled", () => {
  it("toggles a third-track (featureKey=null) command and persists it", async () => {
    const pluginId = await seedPlugin();
    const cmd = await upsertPluginCommand({
      pluginId,
      guildId: null,
      name: "ping",
      discordCommandId: null,
      featureKey: null,
      manifestJson: "{}",
    });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/plugin-commands/${cmd.id}/admin-enabled`,
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      command: { id: cmd.id, adminEnabled: false },
    });
    const [persisted] = await findPluginCommandsByPlugin(pluginId);
    expect(persisted.adminEnabled).toBe(false);
  });

  it("refuses a feature command with the pre-existing 400 body", async () => {
    const pluginId = await seedPlugin();
    const cmd = await upsertPluginCommand({
      pluginId,
      guildId: "g1",
      name: "greet",
      discordCommandId: null,
      featureKey: "greeter",
      manifestJson: "{}",
    });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/plugin-commands/${cmd.id}/admin-enabled`,
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error:
        "cannot toggle feature commands via this endpoint; use guild feature toggle",
    });
    // Untouched — the refusal happened before any write.
    const [persisted] = await findPluginCommandsByPlugin(pluginId);
    expect(persisted.adminEnabled).toBe(true);
  });

  it("returns 404 for a missing command row", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/api/plugin-commands/99999/admin-enabled",
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "plugin command not found" });
  });

  it("rejects a non-boolean body with 400", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/api/plugin-commands/1/admin-enabled",
      payload: { enabled: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "enabled boolean required" });
  });
});

describe("POST /api/plugins/:id/dispatch-probe", () => {
  it("skips an inactive plugin without any traffic", async () => {
    const id = await seedPlugin();
    await Plugin.update({ status: "inactive" }, { where: { id } });

    const res = await server.inject({
      method: "POST",
      url: `/api/plugins/${id}/dispatch-probe`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.probe).toEqual({
      outcome: "skipped",
      reason: "plugin inactive",
    });
    // The dispatch-health window rides along (null = never dispatched).
    expect(body).toHaveProperty("dispatch");
  });

  it("returns 404 for a missing plugin", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/plugins/99999/dispatch-probe",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "plugin not found" });
  });

  it("rejects an invalid id with 400", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/plugins/0/dispatch-probe",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid plugin id" });
  });
});
