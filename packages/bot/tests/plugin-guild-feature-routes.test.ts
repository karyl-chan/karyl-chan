/**
 * PD-1.3 — guild feature routes: the GET aggregate's fallback-tier
 * fields (operatorDefault / manifestDefault / defaultEnabled) and the
 * DELETE clear-override route. PUT/upsert mechanics are covered in
 * plugin-guild-feature.test.ts (model) and feature-resolve.test.ts
 * (resolution); this file locks the HTTP layer the guild panel reads.
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
  upsertPluginRegistration,
} from "../src/modules/plugin-system/models/plugin.model.js";
import {
  PluginGuildFeature,
  findFeatureRow,
  upsertFeatureRow,
} from "../src/modules/feature-toggle/models/plugin-guild-feature.model.js";
import {
  PluginFeatureDefault,
  upsertFeatureDefault,
} from "../src/modules/feature-toggle/models/plugin-feature-default.model.js";

const GUILD = "900000000000000050";

function manifest() {
  return {
    schema_version: "1",
    plugin: {
      id: "gf-route-plugin",
      name: "GF Route Plugin",
      version: "1.0.0",
      url: "http://localhost:9999",
    },
    guild_features: [
      { key: "on-by-default", name: "On", enabled_by_default: true },
      { key: "off-by-default", name: "Off", enabled_by_default: false },
    ],
  };
}

async function seedPlugin(): Promise<number> {
  const row = await upsertPluginRegistration({
    pluginKey: "gf-route-plugin",
    name: "GF Route Plugin",
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
  await PluginGuildFeature.destroy({ where: {} });
  await PluginFeatureDefault.destroy({ where: {} });
  syncFeatureCommandsForGuild.mockClear();
  dispatchLifecycleToPlugin.mockClear();
});

afterAll(async () => {
  await server.close();
});

describe("GET /api/plugins/guilds/:guildId/features — fallback tiers", () => {
  it("names the tier each default comes from", async () => {
    const id = await seedPlugin();
    // Operator default flips off-by-default ON; the other feature has
    // no operator default and follows the manifest.
    await upsertFeatureDefault(id, "off-by-default", true);
    const res = await server.inject({
      method: "GET",
      url: `/api/plugins/guilds/${GUILD}/features`,
    });
    expect(res.statusCode).toBe(200);
    const byKey = new Map(
      (res.json().features as Array<Record<string, unknown>>).map((f) => [
        f.featureKey,
        f,
      ]),
    );
    expect(byKey.get("on-by-default")).toMatchObject({
      operatorDefault: null,
      manifestDefault: true,
      defaultEnabled: true,
      enabled: true,
      overridden: false,
    });
    expect(byKey.get("off-by-default")).toMatchObject({
      operatorDefault: true,
      manifestDefault: false,
      defaultEnabled: true,
      enabled: true,
      overridden: false,
    });
  });
});

describe("DELETE /api/plugins/:id/guilds/:guildId/features/:featureKey", () => {
  it("clears the override, resyncs commands to the default, and fires lifecycle on a flip", async () => {
    const id = await seedPlugin();
    // Guild explicitly disabled an on-by-default feature; clearing the
    // override flips the effective state back to enabled.
    await upsertFeatureRow({
      pluginId: id,
      guildId: GUILD,
      featureKey: "on-by-default",
      enabled: false,
      configJson: '{"k":"v"}',
    });
    const res = await server.inject({
      method: "DELETE",
      url: `/api/plugins/${id}/guilds/${GUILD}/features/on-by-default`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().feature).toMatchObject({
      enabled: true,
      overridden: false,
    });
    expect(await findFeatureRow(id, GUILD, "on-by-default")).toBeNull();
    expect(syncFeatureCommandsForGuild).toHaveBeenCalledWith(
      expect.anything(),
      "on-by-default",
      GUILD,
      true,
      expect.anything(),
    );
    expect(dispatchLifecycleToPlugin).toHaveBeenCalledWith(
      id,
      "plugin.guild.enabled",
      GUILD,
      "on-by-default",
    );
  });

  it("does not fire lifecycle when the effective value doesn't change", async () => {
    const id = await seedPlugin();
    // Override matches the default → clearing changes nothing effective.
    await upsertFeatureRow({
      pluginId: id,
      guildId: GUILD,
      featureKey: "on-by-default",
      enabled: true,
    });
    const res = await server.inject({
      method: "DELETE",
      url: `/api/plugins/${id}/guilds/${GUILD}/features/on-by-default`,
    });
    expect(res.statusCode).toBe(200);
    expect(dispatchLifecycleToPlugin).not.toHaveBeenCalled();
  });

  it("404s when there is no override, an unknown feature, or an unknown plugin", async () => {
    const id = await seedPlugin();
    const noRow = await server.inject({
      method: "DELETE",
      url: `/api/plugins/${id}/guilds/${GUILD}/features/on-by-default`,
    });
    expect(noRow.statusCode).toBe(404);
    const badFeature = await server.inject({
      method: "DELETE",
      url: `/api/plugins/${id}/guilds/${GUILD}/features/nope`,
    });
    expect(badFeature.statusCode).toBe(404);
    const badPlugin = await server.inject({
      method: "DELETE",
      url: `/api/plugins/99999/guilds/${GUILD}/features/on-by-default`,
    });
    expect(badPlugin.statusCode).toBe(404);
  });
});
