/**
 * #142：同一份 manifest 把同一個名稱同時宣告成軌三指令與 feature 指令，
 * 兩列的註冊目標一定重疊（Discord 只會留一個），所以註冊時就拒絕。
 * 規則是 plugin-wire 的 Protocol Rule；這裡確認 bot 的 register 路由
 * 真的跑它、回 400 帶協定錯誤，而且什麼都沒寫入。
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

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

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
    CommandSyncRateLimitedError: class CommandSyncRateLimitedError extends Error {},
    ManifestCommandError: class ManifestCommandError extends Error {},
  }),
);

import { sequelize } from "../src/db.js";
import {
  Plugin,
  findPluginByKey,
  upsertPluginRegistration,
} from "../src/modules/plugin-system/models/plugin.model.js";
import { registerThrottle } from "../src/modules/plugin-system/plugin-routes.js";

const PLUGIN_KEY = "overlap-plugin";
const SETUP_SECRET = "overlap-secret";
const PLACEHOLDER_TOKEN_HASH = "placeholder-token-hash";

function manifest(featureCommandName: string): Record<string, unknown> {
  return {
    plugin: {
      id: PLUGIN_KEY,
      name: "Overlap Plugin",
      version: "1.0.0",
      url: "http://localhost:9995",
    },
    rpc_methods_used: [],
    plugin_commands: [
      {
        name: "foo",
        description: "Foo",
        scope: "guild",
        integration_types: ["guild_install"],
        contexts: ["Guild"],
      },
    ],
    guild_features: [
      {
        key: "x",
        name: "X",
        commands: [{ name: featureCommandName, description: "Feature" }],
      },
    ],
  };
}

let server: import("fastify").FastifyInstance;

function register(featureCommandName: string) {
  return server.inject({
    method: "POST",
    url: "/api/plugins/register",
    headers: { "x-plugin-setup-secret": SETUP_SECRET },
    payload: { manifest: manifest(featureCommandName) },
  });
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
  const fastify = (await import("fastify")).default;
  const { registerPluginRoutes } = await import(
    "../src/modules/plugin-system/plugin-routes.js"
  );
  server = fastify({ logger: false });
  // setup-secret is an admin route; register itself authenticates with
  // the setup secret.
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
  registerThrottle.reset();
  await upsertPluginRegistration({
    pluginKey: PLUGIN_KEY,
    name: "Overlap Plugin",
    version: "1.0.0",
    url: "http://localhost:9995",
    manifestJson: "{}",
    tokenHash: PLACEHOLDER_TOKEN_HASH,
  });
  const res = await server.inject({
    method: "POST",
    url: "/api/plugins/setup-secret",
    payload: { pluginKey: PLUGIN_KEY, secret: SETUP_SECRET },
  });
  expect(res.statusCode).toBe(200);
});

afterAll(async () => {
  await server.close();
});

describe("register: a name declared as both a track-3 and a feature command", () => {
  it("answers 400 with the protocol error and persists nothing", async () => {
    const res = await register("foo");

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe(
      "guild_features[x].commands: command.name 'foo' is also declared in plugin_commands",
    );
    const row = await findPluginByKey(PLUGIN_KEY);
    expect(row!.tokenHash).toBe(PLACEHOLDER_TOKEN_HASH);
    expect(row!.manifestJson).toBe("{}");
  });

  it("registers when the names differ", async () => {
    const res = await register("bar");

    expect(res.statusCode).toBe(200);
  });
});
