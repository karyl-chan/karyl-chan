/**
 * #29 decisions 4/6 — what PHASE 2 does, proven without shipping it.
 *
 * The rollout's second release flips one boolean
 * (`REJECT_UNKNOWN_EVENT_SUBSCRIPTIONS` in
 * `src/modules/plugin-system/plugin-event-subscriptions.ts`) and nothing
 * else. This file stands in for that flip by faking the verdict module
 * with a fixed `status: "reject"` — deliberately NOT re-deriving the
 * policy, so what is under test is only the register path's half of the
 * bargain:
 *
 *   - a reject verdict fails the register with 400 (a manifest-authoring
 *     error, same class as a bad command name), and
 *   - it fails BEFORE anything is persisted, so the flip can't leave
 *     half-registered rows behind.
 *
 * The warn-only behaviour that actually ships is in
 * `plugin-unknown-event-subscriptions.test.ts`.
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
    CommandSyncRateLimitedError: class CommandSyncRateLimitedError extends Error {},
    ManifestCommandError: class ManifestCommandError extends Error {},
  }),
);

// Hoisted with the `vi.mock` factory below, which cannot close over an
// ordinary module-level const.
const { TYPO_EVENT } = vi.hoisted(() => ({
  TYPO_EVENT: "guild.message_creat",
}));

// ── The flip, simulated ──────────────────────────────────────────────
vi.mock("../src/modules/plugin-system/plugin-event-subscriptions.js", () => {
  const verdict = {
    enforced: true,
    status: "reject" as const,
    ceiling: "0.11.1",
    sdkVersion: null,
    unknown: [
      {
        event: TYPO_EVENT,
        source: "events_subscribed_global",
        verdict: "reject" as const,
        message: `Unknown event '${TYPO_EVENT}' (declared in events_subscribed_global): the name is a typo.`,
      },
    ],
  };
  return {
    REJECT_UNKNOWN_EVENT_SUBSCRIPTIONS: true,
    evaluateEventSubscriptions: () => verdict,
    evaluateEventSubscriptionsFromManifestJson: () => verdict,
  };
});

import { sequelize } from "../src/db.js";
import {
  Plugin,
  findPluginByKey,
  upsertPluginRegistration,
} from "../src/modules/plugin-system/models/plugin.model.js";
import { registerThrottle } from "../src/modules/plugin-system/plugin-routes.js";

const PLUGIN_KEY = "reject-phase-plugin";
const SETUP_SECRET = "reject-phase-secret";
const PLACEHOLDER_TOKEN_HASH = "placeholder-token-hash";

function manifest(): Record<string, unknown> {
  return {
    schema_version: "1",
    plugin: {
      id: PLUGIN_KEY,
      name: "Reject Phase Plugin",
      version: "1.0.0",
      url: "http://localhost:9996",
    },
    rpc_methods_used: [],
    events_subscribed_global: [TYPO_EVENT],
  };
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
  registerThrottle.reset();
  await upsertPluginRegistration({
    pluginKey: PLUGIN_KEY,
    name: "Reject Phase Plugin",
    version: "1.0.0",
    url: "http://localhost:9996",
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

describe("phase 2 (flip simulated): a reject verdict fails the register", () => {
  it("answers 400 and names the offending event", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/plugins/register",
      headers: { "x-plugin-setup-secret": SETUP_SECRET },
      payload: { manifest: manifest() },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain(TYPO_EVENT);
  });

  it("persists nothing — no token issued, manifest snapshot untouched", async () => {
    await server.inject({
      method: "POST",
      url: "/api/plugins/register",
      headers: { "x-plugin-setup-secret": SETUP_SECRET },
      payload: { manifest: manifest() },
    });
    const row = await findPluginByKey(PLUGIN_KEY);
    expect(row).not.toBeNull();
    expect(row!.tokenHash).toBe(PLACEHOLDER_TOKEN_HASH);
    expect(row!.manifestJson).toBe("{}");
  });
});
