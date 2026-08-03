/**
 * #29 decisions 4 / 6 / 7 — unknown event subscriptions, PHASE 1
 * (warn-only).
 *
 * Two halves:
 *
 *  1. The verdict itself (`evaluateEventSubscriptions`): every declared
 *     subscription — global and per guild feature — is classified by the
 *     wire's `classifyEventSubscription`, and the offending names are
 *     named with a reason.
 *  2. The register path: a manifest with a typo'd subscription STILL
 *     REGISTERS (200, real token) and the warning comes back in the
 *     response body. That is the whole content of phase 1 — nothing is
 *     rejected because of an unknown event name in this release.
 *
 * When `REJECT_UNKNOWN_EVENT_SUBSCRIPTIONS` flips to true (phase 2), the
 * guard test below goes red first and points at the tests that have to
 * be re-stated as reject tests.
 */
import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
});

// The SSRF gate would refuse a localhost plugin url on the register path.
vi.mock("../src/utils/host-policy.js", () => ({
  assertPluginTarget: vi.fn().mockResolvedValue(undefined),
  HostPolicyError: class HostPolicyError extends Error {},
}));

// Event bridge / command registry are not what this file is about.
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

import { EVENT_CEILING, Events } from "@karyl-chan/plugin-wire";
import type { PluginManifest } from "@karyl-chan/plugin-wire";

import { sequelize } from "../src/db.js";
import {
  Plugin,
  upsertPluginRegistration,
} from "../src/modules/plugin-system/models/plugin.model.js";
import { registerThrottle } from "../src/modules/plugin-system/plugin-routes.js";
import {
  REJECT_UNKNOWN_EVENT_SUBSCRIPTIONS,
  evaluateEventSubscriptions,
  evaluateEventSubscriptionsFromManifestJson,
} from "../src/modules/plugin-system/plugin-event-subscriptions.js";

/** Any version strictly above the ceiling — "built on a newer SDK". */
const ABOVE_CEILING = "99.0.0";
/** A typo of `guild.message_create` (missing trailing `e`). */
const TYPO_EVENT = "guild.message_creat";

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schema_version: "1",
    plugin: {
      id: "typo-plugin",
      name: "Typo Plugin",
      version: "1.0.0",
      url: "http://localhost:9998",
    },
    rpc_methods_used: [],
    ...overrides,
  } as PluginManifest;
}

// ── 1. The verdict ───────────────────────────────────────────────────

describe("evaluateEventSubscriptions", () => {
  it("is ok when every declared subscription is a Canonical Event", () => {
    const v = evaluateEventSubscriptions(
      manifest({
        sdk_version: ABOVE_CEILING,
        events_subscribed_global: [Events.GuildMessageCreate],
        guild_features: [
          {
            key: "f1",
            name: "F1",
            events_subscribed: [Events.DmMessageCreate],
          },
        ],
      }),
    );
    expect(v.status).toBe("ok");
    expect(v.unknown).toEqual([]);
    expect(v.ceiling).toBe(EVENT_CEILING);
  });

  it("is ok when the manifest declares no subscription at all", () => {
    const v = evaluateEventSubscriptions(manifest());
    expect(v.status).toBe("ok");
    expect(v.unknown).toEqual([]);
  });

  it("classifies an unknown name from a NEWER sdk_version as warn", () => {
    const v = evaluateEventSubscriptions(
      manifest({
        sdk_version: ABOVE_CEILING,
        events_subscribed_global: ["guild.not_yet_invented"],
      }),
    );
    expect(v.unknown).toHaveLength(1);
    expect(v.unknown[0].verdict).toBe("warn");
    expect(v.unknown[0].event).toBe("guild.not_yet_invented");
    // The reason has to be readable, not just machine-readable.
    expect(v.unknown[0].message).toContain("guild.not_yet_invented");
    expect(v.unknown[0].message).toContain(EVENT_CEILING);
    expect(v.unknown[0].message).toContain(ABOVE_CEILING);
  });

  it("classifies an unknown name at or below the ceiling as reject (typo)", () => {
    const v = evaluateEventSubscriptions(
      manifest({
        sdk_version: EVENT_CEILING,
        events_subscribed_global: [TYPO_EVENT],
      }),
    );
    expect(v.unknown).toHaveLength(1);
    expect(v.unknown[0].verdict).toBe("reject");
    expect(v.unknown[0].message).toContain(TYPO_EVENT);
    expect(v.unknown[0].message).toMatch(/typo/i);
  });

  it("classifies a legacy manifest (no sdk_version) as reject — decision 7", () => {
    const v = evaluateEventSubscriptions(
      manifest({ events_subscribed_global: [TYPO_EVENT] }),
    );
    expect(v.sdkVersion).toBeNull();
    expect(v.unknown).toHaveLength(1);
    expect(v.unknown[0].verdict).toBe("reject");
    // Phase 1: classified reject, reported as a warning. The flip is a
    // change of behaviour, not of classification.
    expect(v.status).toBe("warn");
  });

  it("names the guild feature an unknown subscription came from", () => {
    const v = evaluateEventSubscriptions(
      manifest({
        sdk_version: ABOVE_CEILING,
        guild_features: [
          {
            key: "radio",
            name: "Radio",
            events_subscribed: [Events.GuildMessageCreate, TYPO_EVENT],
          },
        ],
      }),
    );
    expect(v.unknown).toHaveLength(1);
    expect(v.unknown[0].event).toBe(TYPO_EVENT);
    expect(v.unknown[0].source).toContain("radio");
    expect(v.unknown[0].message).toContain("radio");
  });

  it("reports the same name twice when two places declare it", () => {
    const v = evaluateEventSubscriptions(
      manifest({
        sdk_version: ABOVE_CEILING,
        events_subscribed_global: [TYPO_EVENT],
        guild_features: [
          { key: "radio", name: "Radio", events_subscribed: [TYPO_EVENT] },
        ],
      }),
    );
    expect(v.unknown.map((u) => u.source)).toEqual([
      "events_subscribed_global",
      "guild_features[radio].events_subscribed",
    ]);
  });

  it("does not report the same (event, source) pair twice", () => {
    const v = evaluateEventSubscriptions(
      manifest({
        sdk_version: ABOVE_CEILING,
        events_subscribed_global: [TYPO_EVENT, TYPO_EVENT],
      }),
    );
    expect(v.unknown).toHaveLength(1);
  });

  it("ignores non-string junk in the subscription arrays", () => {
    const v = evaluateEventSubscriptions(
      manifest({
        sdk_version: ABOVE_CEILING,
        events_subscribed_global: [42, null, "", Events.GuildMessageCreate],
      } as unknown as Partial<PluginManifest>),
    );
    expect(v.status).toBe("ok");
  });
});

describe("evaluateEventSubscriptionsFromManifestJson", () => {
  it("reads the stored manifest column", () => {
    const v = evaluateEventSubscriptionsFromManifestJson(
      JSON.stringify(
        manifest({
          sdk_version: ABOVE_CEILING,
          events_subscribed_global: [TYPO_EVENT],
        }),
      ),
    );
    expect(v.status).toBe("warn");
    expect(v.unknown[0].event).toBe(TYPO_EVENT);
  });

  it("treats an unparseable manifest as having no subscriptions", () => {
    const v = evaluateEventSubscriptionsFromManifestJson("{not json");
    expect(v.status).toBe("ok");
    expect(v.unknown).toEqual([]);
  });

  it("survives a placeholder / malformed stored manifest", () => {
    // The admin list route runs this over every row, including
    // setup-secret placeholders that never carried a real manifest. A
    // throw here would 500 the whole plugin list.
    expect(evaluateEventSubscriptionsFromManifestJson("{}").status).toBe("ok");
    expect(
      evaluateEventSubscriptionsFromManifestJson(
        '{"guild_features":"nope","events_subscribed_global":7}',
      ).status,
    ).toBe("ok");
  });
});

// ── 2. Phase-1 guard ─────────────────────────────────────────────────

describe("rollout phase (decision 6)", () => {
  it("is warn-only: the phase-2 boolean is still false", () => {
    // THE flip. When this goes true, every expectation below that says
    // "registers successfully with a warning" becomes "400, no row".
    expect(REJECT_UNKNOWN_EVENT_SUBSCRIPTIONS).toBe(false);
  });

  it("never reports status 'reject' while warn-only", () => {
    const v = evaluateEventSubscriptions(
      manifest({ events_subscribed_global: [TYPO_EVENT] }),
    );
    expect(v.enforced).toBe(false);
    expect(v.status).toBe("warn");
  });
});

// ── 3. The register path ─────────────────────────────────────────────

const SETUP_SECRET = "unknown-event-setup-secret";
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
});

afterEach(async () => {
  await Plugin.destroy({ where: {} });
});

afterAll(async () => {
  await server.close();
});

/** Provision the placeholder row + setup secret the route demands. */
async function seed(pluginKey: string): Promise<void> {
  await upsertPluginRegistration({
    pluginKey,
    name: "Typo Plugin",
    version: "1.0.0",
    url: "http://localhost:9998",
    manifestJson: JSON.stringify(manifest()),
    tokenHash: "init-hash",
  });
  const res = await server.inject({
    method: "POST",
    url: "/api/plugins/setup-secret",
    payload: { pluginKey, secret: SETUP_SECRET },
  });
  expect(res.statusCode).toBe(200);
}

async function register(m: unknown) {
  return server.inject({
    method: "POST",
    url: "/api/plugins/register",
    headers: { "x-plugin-setup-secret": SETUP_SECRET },
    payload: { manifest: m },
  });
}

interface RegisterBody {
  token?: string;
  eventSubscriptions?: {
    status: string;
    enforced: boolean;
    ceiling: string;
    sdkVersion: string | null;
    unknown: { event: string; source: string; verdict: string; message: string }[];
  };
}

describe("POST /api/plugins/register — phase 1 is warn-only", () => {
  it("registers a typo'd subscription successfully and warns in the response", async () => {
    await seed("typo-plugin");
    const res = await register(
      manifest({
        sdk_version: ABOVE_CEILING,
        events_subscribed_global: [TYPO_EVENT],
      }),
    );

    // Registration SUCCEEDS: status 200 and a real token.
    expect(res.statusCode).toBe(200);
    const body = res.json() as RegisterBody;
    expect(typeof body.token).toBe("string");
    expect(body.token!.length).toBeGreaterThan(0);

    // …and the warning rides back with it.
    const check = body.eventSubscriptions!;
    expect(check.status).toBe("warn");
    expect(check.enforced).toBe(false);
    expect(check.ceiling).toBe(EVENT_CEILING);
    expect(check.unknown).toHaveLength(1);
    expect(check.unknown[0].event).toBe(TYPO_EVENT);
    expect(check.unknown[0].message).toContain(TYPO_EVENT);
  });

  it("registers a LEGACY manifest (no sdk_version) with a reject-classified warning", async () => {
    await seed("typo-plugin");
    const res = await register(
      manifest({ events_subscribed_global: [TYPO_EVENT] }),
    );
    expect(res.statusCode).toBe(200);
    const check = (res.json() as RegisterBody).eventSubscriptions!;
    expect(check.sdkVersion).toBeNull();
    expect(check.status).toBe("warn");
    expect(check.unknown[0].verdict).toBe("reject");
  });

  it("keeps the plugin row and its subscriptions — nothing is dropped", async () => {
    await seed("typo-plugin");
    const res = await register(
      manifest({
        sdk_version: ABOVE_CEILING,
        events_subscribed_global: [Events.GuildMessageCreate, TYPO_EVENT],
      }),
    );
    expect(res.statusCode).toBe(200);
    const row = await Plugin.findOne({ where: { pluginKey: "typo-plugin" } });
    expect(row).not.toBeNull();
    const stored = JSON.parse(
      row!.getDataValue("manifestJson") as string,
    ) as PluginManifest;
    expect(stored.events_subscribed_global).toEqual([
      Events.GuildMessageCreate,
      TYPO_EVENT,
    ]);
  });

  it("reports an all-known manifest as ok", async () => {
    await seed("typo-plugin");
    const res = await register(
      manifest({
        sdk_version: ABOVE_CEILING,
        events_subscribed_global: [Events.GuildMessageCreate],
      }),
    );
    expect(res.statusCode).toBe(200);
    const check = (res.json() as RegisterBody).eventSubscriptions!;
    expect(check.status).toBe("ok");
    expect(check.unknown).toEqual([]);
  });
});

describe("GET /api/plugins — the operator surface", () => {
  it("carries the verdict next to sdkCompat for an already-registered plugin", async () => {
    await seed("typo-plugin");
    await register(
      manifest({
        sdk_version: ABOVE_CEILING,
        events_subscribed_global: [TYPO_EVENT],
      }),
    );
    const res = await server.inject({ method: "GET", url: "/api/plugins" });
    expect(res.statusCode).toBe(200);
    const row = (
      res.json() as {
        plugins: {
          pluginKey: string;
          sdkCompat?: unknown;
          eventSubscriptions?: { status: string; unknown: { event: string }[] };
        }[];
      }
    ).plugins.find((p) => p.pluginKey === "typo-plugin")!;
    expect(row.sdkCompat).toBeDefined();
    expect(row.eventSubscriptions?.status).toBe("warn");
    expect(row.eventSubscriptions?.unknown[0].event).toBe(TYPO_EVENT);
  });
});
