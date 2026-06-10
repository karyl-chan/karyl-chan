/**
 * PM-3.2 — PUT /api/plugins/:id/scopes (admin approve / deny RPC scopes).
 * The service logic is covered in plugin-scope-approval.test.ts; this
 * locks the HTTP wrapper: auth guard, id / body validation, clamp to the
 * requested set, and the { scopes } response shape.
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

let server: import("fastify").FastifyInstance;

function manifest(scopes: string[]) {
  return {
    schema_version: "1",
    plugin: {
      id: "scope-route-plugin",
      name: "Scope Route Plugin",
      version: "1.0.0",
      url: "http://localhost:9999",
    },
    rpc_methods_used: scopes,
  };
}

async function seedPlugin(scopes: string[]): Promise<number> {
  const row = await upsertPluginRegistration({
    pluginKey: "scope-route-plugin",
    name: "Scope Route Plugin",
    version: "1.0.0",
    url: "http://localhost:9999",
    manifestJson: JSON.stringify(manifest(scopes)),
    tokenHash: "seed-hash",
    approvedRpcScopes: [],
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
  await registerPluginRoutes(server);
  await server.ready();
});

beforeEach(async () => {
  await Plugin.destroy({ where: {} });
});

afterAll(async () => {
  await server.close();
});

describe("PUT /api/plugins/:id/scopes", () => {
  it("approves a subset and returns the new scope state", async () => {
    const id = await seedPlugin(["messages.send", "config.get"]);
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
    // Persisted.
    const row = await findPluginByKey("scope-route-plugin");
    expect(row?.approvedRpcScopes).toEqual(["messages.send"]);
  });

  it("clamps to the requested set — an undeclared scope is ignored", async () => {
    const id = await seedPlugin(["messages.send"]);
    const res = await server.inject({
      method: "PUT",
      url: `/api/plugins/${id}/scopes`,
      payload: { approved: ["messages.send", "messages.delete"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().scopes.approved).toEqual(["messages.send"]);
  });

  it("rejects a non-array body with 400", async () => {
    const id = await seedPlugin(["messages.send"]);
    const res = await server.inject({
      method: "PUT",
      url: `/api/plugins/${id}/scopes`,
      payload: { approved: "messages.send" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid id with 400", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/plugins/0/scopes",
      payload: { approved: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for a missing plugin", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/plugins/99999/scopes",
      payload: { approved: [] },
    });
    expect(res.statusCode).toBe(404);
  });
});
