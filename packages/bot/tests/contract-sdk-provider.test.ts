/**
 * Provider-side (bot) contract test against the canonical wire-contract
 * fixtures.
 *
 * SINGLE SOURCE OF TRUTH: `CONTRACT_FIXTURES`, owned by
 * `@karyl-chan/plugin-wire` and IMPORTED here as a package export —
 * there is no second copy and no cross-package `fs` read. The SDK's
 * `tests/contract/sdk-contract.test.ts` asserts the consumer half
 * against the same literals, so the two sides can never silently drift.
 *
 * Every suite below asserts on OBSERVED BEHAVIOUR, not on source text
 * (#29 decision 8). The four suites this file used to carry were
 * `SRC.includes("…")` greps over the bot's own source — they passed
 * while `sub_command_group` and `member.permissions` were missing from
 * the wire, and would have failed on a harmless rename. They are
 * replaced by fixture replay:
 *
 *   - RPC paths          → injected through the real Fastify instance;
 *                          a served path reaches a handler, a removed
 *                          one 404s.
 *   - Canonical events   → value-compared against plugin-wire's
 *                          `CANONICAL_EVENTS`, then a manifest
 *                          subscribing to all of them is registered
 *                          through the real route and each one is
 *                          asserted to become a live dispatch route.
 *   - Register envelope  → the real `POST /api/plugins/register`
 *                          response body.
 *   - Dispatch envelope  → the JSON the bot actually POSTs, captured
 *                          off a stubbed `fetch`, asserted field by
 *                          field for all four interaction kinds.
 *
 * The two behavioural suites that were already honest (HMAC golden
 * vectors, Redis-stream producer keys) are unchanged apart from the
 * fixture import.
 *
 * Pure: no live Discord, no Redis, no network (fetch is stubbed).
 */

import {
  vi,
  describe,
  expect,
  it,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
} from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
  // Makes the register response emit `publicBaseUrl`, so the envelope
  // suite observes the full optional field set rather than a subset.
  process.env.WEB_BASE_URL = "https://karyl.test";
});

// Host policy is the SSRF gate on BOTH the register path (validateManifest
// would refuse a localhost plugin url) and the dispatch path
// (`preflightPluginTarget` wraps `assertPluginTarget`). Opening it lets
// both flows run end-to-end against a loopback plugin URL.
vi.mock("../src/utils/host-policy.js", () => ({
  assertPluginTarget: vi.fn().mockResolvedValue(undefined),
  HostPolicyError: class HostPolicyError extends Error {},
}));

// Command registration talks to Discord; nothing in this file asserts on
// it. The event bridge and every dispatch service stay REAL — they are
// what is under test.
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

import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";

import {
  CONTRACT_FIXTURES as fixtures,
  CANONICAL_EVENTS,
} from "@karyl-chan/plugin-wire";

import {
  signBody,
  verifyInboundSignature,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  REPLAY_WINDOW_SECONDS,
} from "../src/utils/hmac.js";
import { RedisStreamsPluginEventBus } from "../src/adapters/redis/plugin-event-bus.js";
import type { RedisLike } from "../src/adapters/redis/client.js";
import { sequelize } from "../src/db.js";
import { createWebServer } from "../src/modules/web-core/server.js";
import { pluginAuthStore } from "../src/modules/plugin-system/plugin-auth.service.js";
import { Plugin } from "../src/modules/plugin-system/models/plugin.model.js";
import {
  PluginCommand,
  upsertPluginCommand,
} from "../src/modules/plugin-system/models/plugin-command.model.js";
import { registerThrottle } from "../src/modules/plugin-system/plugin-routes.js";
import {
  rebuildEventIndex,
  getEventIndexSize,
} from "../src/modules/plugin-system/plugin-event-bridge.service.js";
import { dispatchInteractionToPlugin } from "../src/modules/plugin-system/plugin-interaction-dispatch.service.js";
import { dispatchComponentToPlugin } from "../src/modules/plugin-system/plugin-component-dispatch.service.js";
import { dispatchModalToPlugin } from "../src/modules/plugin-system/plugin-modal-dispatch.service.js";
import {
  createPluginDispatcher,
  type PluginDispatcher,
} from "../src/modules/plugin-system/plugin-dispatch.service.js";
import type { PluginDispatchPool } from "../src/modules/plugin-system/plugin-dispatch-pool.js";
import type { PluginRow } from "../src/modules/plugin-system/models/plugin.model.js";

// ════════════════════════════════════════════════════════════════════
//  Behavioural suite 1 — HMAC headers, window, golden vectors
// ════════════════════════════════════════════════════════════════════

describe("contract: hmac headers + window (bot side)", () => {
  it("bot signature header matches the contract", () => {
    expect(SIGNATURE_HEADER).toBe(fixtures.hmac.signatureHeader);
  });
  it("bot timestamp header matches the contract", () => {
    expect(TIMESTAMP_HEADER).toBe(fixtures.hmac.timestampHeader);
  });
  it("bot replay window matches the contract", () => {
    expect(REPLAY_WINDOW_SECONDS).toBe(fixtures.hmac.replayWindowSeconds);
  });
});

describe("contract: bot signBody reproduces golden hex", () => {
  for (const g of fixtures.hmac.golden) {
    it(`signBody() matches golden for '${g.name}'`, () => {
      expect(signBody(g.secret, g.method, g.path, g.ts, g.nonce, g.body)).toBe(
        g.expectedHex,
      );
    });

    it(`verifyInboundSignature accepts the golden signature for '${g.name}'`, () => {
      const headers = new Headers({
        [fixtures.hmac.timestampHeader]: g.ts,
        [fixtures.hmac.nonceHeader]: g.nonce,
        [fixtures.hmac.signatureHeader]: g.expectedHex,
      });
      const result = verifyInboundSignature(
        g.secret,
        headers,
        g.body,
        Number(g.ts), // now == ts so the timestamp is fresh
        g.method,
        g.path,
      );
      expect(result.ok).toBe(true);
    });

    it(`verifyInboundSignature rejects a tampered body for '${g.name}'`, () => {
      const headers = new Headers({
        [fixtures.hmac.timestampHeader]: g.ts,
        [fixtures.hmac.nonceHeader]: g.nonce,
        [fixtures.hmac.signatureHeader]: g.expectedHex,
      });
      const result = verifyInboundSignature(
        g.secret,
        headers,
        g.body + "X",
        Number(g.ts),
        g.method,
        g.path,
      );
      expect(result.ok).toBe(false);
    });
  }
});

// ════════════════════════════════════════════════════════════════════
//  Behavioural suite 2 — Redis-streams producer key convention
// ════════════════════════════════════════════════════════════════════

interface XaddCall {
  key: string;
  args: Array<string | number>;
}
function makeXaddStub(): { client: RedisLike; calls: XaddCall[] } {
  const calls: XaddCall[] = [];
  const client = {
    async get() {
      return null;
    },
    async set() {
      return "OK";
    },
    async del() {
      return 0;
    },
    async xadd(
      this: void,
      key: string,
      ...args: Array<string | number>
    ): Promise<unknown> {
      calls.push({ key, args });
      return "0-1";
    },
  } as unknown as RedisLike;
  return { client, calls };
}

describe("contract: streams producer key convention (bot side)", () => {
  for (const s of fixtures.streams.samples) {
    it(`producer XADDs to '${s.pluginKey}'s mailbox per the contract`, async () => {
      const { client, calls } = makeXaddStub();
      new RedisStreamsPluginEventBus(client).dispatchToPlugin(
        1,
        s.pluginKey,
        "guild.message_create",
        { a: 1 },
      );
      await new Promise((r) => setTimeout(r, 5));
      expect(calls.length).toBe(1);
      expect(calls[0].key).toBe(s.streamKey);
      // The DLQ key is the SDK-consumer's derivation off this same
      // stream key + suffix; assert the contract's dlqKey is consistent
      // with what the producer wrote so the two halves agree.
      expect(s.dlqKey).toBe(s.streamKey + fixtures.streams.dlqSuffix);
    });
  }

  it("producer fields include every contract field name", async () => {
    const { client, calls } = makeXaddStub();
    new RedisStreamsPluginEventBus(client).dispatchToPlugin(
      1,
      "my-plugin",
      "guild.message_create",
      { x: 1 },
    );
    await new Promise((r) => setTimeout(r, 5));
    const args = calls[0].args;
    const fieldNames = new Set<string>();
    // Fields start after MAXLEN ~ N *  (index 4), as name/value pairs.
    for (let i = 4; i < args.length; i += 2) fieldNames.add(String(args[i]));
    for (const f of fixtures.streams.fields) {
      expect(fieldNames.has(f)).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
//  Shared fixture-replay harness
// ════════════════════════════════════════════════════════════════════

const PLUGIN_KEY = "contract-plugin";
const PLUGIN_ID = 4242;
const PLUGIN_URL = "http://localhost:9997";
const SETUP_SECRET = "contract-setup-secret";
const GUILD_ID = "guild-1";
const CHANNEL_ID = "chan-1";
const USER_ID = "user-1";
const COMMAND_NAME = "contract-cmd";
const DISPATCH_KEY = "dispatch-key-abc";

/** The manifest the register-envelope + canonical-event suites POST. */
function contractManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: "1",
    plugin: {
      id: PLUGIN_KEY,
      name: "Contract Plugin",
      version: "1.0.0",
      url: PLUGIN_URL,
    },
    rpc_methods_used: [],
    ...overrides,
  };
}

/** Row the dispatch suites drive the real dispatch services against. */
async function seedPluginRow(): Promise<void> {
  await Plugin.destroy({ where: {} });
  await PluginCommand.destroy({ where: {} });
  // Registering the same pluginKey several times across these suites is
  // well inside the 10/min budget, but reset so adding a suite later
  // can't turn a green run into a 429.
  registerThrottle.reset();
  await Plugin.create({
    id: PLUGIN_ID,
    pluginKey: PLUGIN_KEY,
    name: "Contract Plugin",
    version: "1.0.0",
    url: PLUGIN_URL,
    enabled: true,
    status: "active",
    manifestJson: JSON.stringify(contractManifest()),
    setupSecretHash: createHash("sha256").update(SETUP_SECRET).digest("hex"),
    tokenHash: null,
    dispatchHmacKey: DISPATCH_KEY,
    lastHeartbeatAt: null,
  } as unknown as Record<string, unknown>);
}

let server: FastifyInstance;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  server = await createWebServer({
    bot: {
      isReady: () => true,
      user: { id: "bot-1", tag: "bot#1" },
      guilds: { cache: { size: 0 } },
      uptime: 1,
      channels: { fetch: vi.fn() },
    } as never,
  });
  await server.ready();
});

afterAll(async () => {
  if (server) await server.close();
});

// ════════════════════════════════════════════════════════════════════
//  Replaces the `bot serves every RPC path the SDK calls` grep suite
// ════════════════════════════════════════════════════════════════════
/**
 * The old suite asserted the path appeared as a string literal in
 * `plugin-rpc-routes.ts` / `voice-rpc.ts`. This one asks the real
 * server: a served path reaches its handler (which then rejects the
 * empty body / missing precondition with 4xx-but-not-404), a path the
 * bot does not serve 404s. The negative control below proves the 404
 * signal is real rather than an artefact of the auth hook.
 */
describe("contract: bot serves every RPC path the SDK calls", () => {
  beforeAll(async () => {
    await seedPluginRow();
    // Authenticate as the seeded plugin with every scope, so requests
    // get PAST the `/api/plugin/*` bearer-token hook and actually reach
    // routing — without this every path (served or not) answers 401 and
    // the 404 signal is unobservable.
    vi.spyOn(pluginAuthStore, "verify").mockReturnValue({
      pluginId: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      scopes: new Set(
        fixtures.rpc.pathsCalledBySdk.map((p) =>
          p.slice("/api/plugin/".length),
        ),
      ),
      expiresAt: Date.now() + 60_000,
    } as never);
  });

  for (const path of fixtures.rpc.pathsCalledBySdk) {
    it(`provider serves '${path}'`, async () => {
      const res = await server.inject({
        method: "POST",
        url: path,
        headers: { authorization: "Bearer contract-token" },
        payload: {},
      });
      expect(res.statusCode).not.toBe(404);
      // Also assert Fastify's route table agrees — catches a route that
      // only answers because some catch-all swallowed it.
      expect(server.hasRoute({ method: "POST", url: path })).toBe(true);
    });
  }

  it("negative control: a path the bot does not serve 404s", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/plugin/definitely.not.a.route",
      headers: { authorization: "Bearer contract-token" },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════════
//  Replaces the `bot emits every canonical event` grep suite
// ════════════════════════════════════════════════════════════════════
/**
 * The old suite grepped two bot source files for each event literal.
 * The bot now IMPORTS the canonical set from `plugin-wire`, so the
 * meaningful assertions are (a) the fixture list is the ledger, and
 * (b) the bot's register path accepts a subscription to every one of
 * them and turns each into a live dispatch route. (b) is the drift that
 * actually breaks plugins — a bot that rejects or fails to index an
 * event the SDK declares canonical delivers nothing.
 */
describe("contract: bot's canonical event set", () => {
  it("fixture canonical list equals plugin-wire's CANONICAL_EVENTS", () => {
    expect([...fixtures.events.canonical].sort()).toEqual(
      CANONICAL_EVENTS.map((e) => e.name).sort(),
    );
  });

  it("register accepts a global subscription to every canonical event, and each becomes a live dispatch route", async () => {
    await seedPluginRow();
    const res = await server.inject({
      method: "POST",
      url: fixtures.register.endpoint,
      headers: { [fixtures.register.setupSecretHeader]: SETUP_SECRET },
      payload: {
        manifest: contractManifest({
          events_subscribed_global: [...fixtures.events.canonical],
        }),
      },
    });
    expect(res.statusCode).toBe(200);

    await rebuildEventIndex();
    // One route per subscribed event — a canonical name the bot refused
    // to index (or silently deduped away) shows up as a smaller index.
    expect(getEventIndexSize()).toBe(fixtures.events.canonical.length);
  });
});

// ════════════════════════════════════════════════════════════════════
//  Replaces the `register response envelope` grep suite
// ════════════════════════════════════════════════════════════════════
/**
 * The old suite regex-matched field names in `plugin-routes.ts`. This
 * one registers a real plugin through the real route with the
 * contract's setup-secret header and reads the response body.
 *
 * The extras assertion is deliberate: a new register response field has
 * to be declared in the fixtures before it can ship, which is what
 * makes the fixtures a contract rather than a description.
 */
describe("contract: register response envelope", () => {
  let body: Record<string, unknown>;

  beforeAll(async () => {
    await seedPluginRow();
    const res = await server.inject({
      method: "POST",
      url: fixtures.register.endpoint,
      headers: { [fixtures.register.setupSecretHeader]: SETUP_SECRET },
      payload: { manifest: contractManifest() },
    });
    expect(res.statusCode).toBe(200);
    body = res.json() as Record<string, unknown>;
  });

  it("the contract endpoint is what actually serves register", () => {
    expect(server.hasRoute({ method: "POST", url: fixtures.register.endpoint }))
      .toBe(true);
  });

  for (const field of fixtures.register.requiredResponseFields) {
    it(`response carries the required field '${field}'`, () => {
      expect(Object.hasOwn(body, field)).toBe(true);
      expect(body[field]).not.toBeNull();
      expect(body[field]).not.toBeUndefined();
    });
  }

  for (const field of fixtures.register.optionalResponseFields) {
    it(`response carries the declared optional field '${field}'`, () => {
      // Every optional field is unconditional in the handler except
      // publicBaseUrl, which needs WEB_BASE_URL — set in vi.hoisted so
      // the whole declared set is observable here.
      expect(Object.hasOwn(body, field)).toBe(true);
    });
  }

  it("introduces no response field the contract does not declare", () => {
    const declared = new Set<string>([
      ...fixtures.register.requiredResponseFields,
      ...fixtures.register.optionalResponseFields,
    ]);
    const extras = Object.keys(body).filter((k) => !declared.has(k));
    expect(extras).toEqual([]);
  });

  it("the response's heartbeat path is the contract's heartbeat endpoint", () => {
    const heartbeat = body.heartbeat as { path?: string } | undefined;
    expect(heartbeat?.path).toBe(fixtures.register.heartbeatEndpoint);
  });

  it("the heartbeat endpoint the response advertises is actually served", () => {
    expect(
      server.hasRoute({
        method: "POST",
        url: fixtures.register.heartbeatEndpoint,
      }),
    ).toBe(true);
  });

  it("the contract's setup-secret header is the one the route reads", async () => {
    await seedPluginRow();
    const wrongHeader = await server.inject({
      method: "POST",
      url: fixtures.register.endpoint,
      headers: { "x-some-other-header": SETUP_SECRET },
      payload: { manifest: contractManifest() },
    });
    expect(wrongHeader.statusCode).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════
//  Replaces the `dispatch envelope shape` grep suite
// ════════════════════════════════════════════════════════════════════
/**
 * The old suite asserted a VERBATIM source string —
 * `dispatch.includes("{ type: req.label, data: req.payload.data }")` —
 * which broke on any harmless refactor while catching nothing about the
 * bytes on the wire. These suites capture what the bot actually POSTs.
 */

function okFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(null, { status: 204 }));
}

/** The JSON body of the Nth outbound POST captured by a fetch stub. */
function capturedBody(
  spy: ReturnType<typeof vi.fn>,
  n = 0,
): Record<string, unknown> {
  const call = spy.mock.calls[n] as [string, RequestInit] | undefined;
  expect(call, "expected an outbound dispatch POST").toBeDefined();
  return JSON.parse(String(call![1].body)) as Record<string, unknown>;
}

/** The URL of the Nth outbound POST captured by a fetch stub. */
function capturedUrl(spy: ReturnType<typeof vi.fn>, n = 0): string {
  return (spy.mock.calls[n] as [string, RequestInit])[0];
}

describe("contract: event/lifecycle dispatch envelope", () => {
  function pluginRow(): PluginRow {
    return {
      id: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      name: PLUGIN_KEY,
      version: "1.0.0",
      url: PLUGIN_URL,
      manifestJson: JSON.stringify(
        contractManifest({ endpoints: { plugin_lifecycle: "/_kc/lifecycle" } }),
      ),
      status: "active",
      tokenHash: null,
      enabled: true,
      lastHeartbeatAt: null,
      setupSecretHash: null,
      dispatchHmacKey: DISPATCH_KEY,
      approvedRpcScopes: [],
      approvedGlobalEventSubs: [],
      configSchemaVersion: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as unknown as PluginRow;
  }

  const reachOpen = {
    hasAnyFeatureEnabledInGuild: vi.fn(async () => true),
    isFeatureEnabledInGuild: vi.fn(async () => true),
  };

  it("the lifecycle POST body has exactly the contract's envelope keys", async () => {
    const fetchImpl = okFetch();
    const d: PluginDispatcher = createPluginDispatcher({
      reach: reachOpen,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const outcome = await d.deliver({
      kind: "lifecycle",
      plugin: pluginRow(),
      label: "plugin.guild.enabled",
      payload: { data: { guild_id: GUILD_ID, feature_key: "f" } },
    });
    expect(outcome.status).toBe("ok");
    const body = capturedBody(fetchImpl);
    expect(Object.keys(body).sort()).toEqual(
      [...fixtures.dispatchEnvelope.httpBodyKeys].sort(),
    );
    expect(body.type).toBe("plugin.guild.enabled");
    expect(body.data).toEqual({ guild_id: GUILD_ID, feature_key: "f" });
  });

  it("the event POST body has exactly the contract's envelope keys", async () => {
    const posted: string[] = [];
    const pool = {
      post: vi.fn(async (_key: string, _url: string, _h: unknown, b: string) => {
        posted.push(b);
        return { ok: true, status: 204, bodyText: "" };
      }),
    } as unknown as PluginDispatchPool;
    const d = createPluginDispatcher({
      reach: reachOpen,
      pool,
      // No out-of-process bus, so the event kind takes the HTTP path
      // through the pool where the envelope is actually serialized.
      getEventBus: () => null,
    });
    const outcome = await d.deliver({
      kind: "event",
      plugin: pluginRow(),
      label: fixtures.events.canonical[0],
      payload: { data: { id: "1" } },
    });
    expect(outcome.status).toBe("ok");
    const body = JSON.parse(posted[0]) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [...fixtures.dispatchEnvelope.httpBodyKeys].sort(),
    );
    expect(body.type).toBe(fixtures.events.canonical[0]);
    expect(body.data).toEqual({ id: "1" });
  });
});

// ── Field-level interaction dispatch payloads ───────────────────────
/**
 * THE regression guard the source greps never gave us: drive each of
 * the four interaction kinds through its real dispatch service and
 * assert, field by field, on the JSON the bot POSTs. `Object.hasOwn`
 * rather than truthiness — a legitimately-null `sub_command_group`
 * still counts, a dropped one does not (`JSON.stringify` omits
 * `undefined` keys, which is exactly how a field vanishes silently).
 */

function assertPayloadMatchesContract(
  kind: keyof typeof fixtures.dispatchEnvelope.payloads,
  body: Record<string, unknown>,
): void {
  const spec = fixtures.dispatchEnvelope.payloads[kind];
  for (const field of spec.requiredFields) {
    expect(
      Object.hasOwn(body, field),
      `${kind} payload is missing the contract field '${field}'`,
    ).toBe(true);
  }
  const user = body.user as Record<string, unknown> | undefined;
  expect(user, `${kind} payload has no user object`).toBeDefined();
  for (const field of spec.userFields) {
    expect(
      Object.hasOwn(user!, field),
      `${kind} payload is missing 'user.${field}'`,
    ).toBe(true);
  }
  if (spec.memberFields !== null) {
    const member = body.member as Record<string, unknown> | null | undefined;
    expect(member, `${kind} payload has no member object`).toBeTruthy();
    for (const field of spec.memberFields) {
      expect(
        Object.hasOwn(member!, field),
        `${kind} payload is missing 'member.${field}'`,
      ).toBe(true);
    }
  }
}

const memberPermissions = { bitfield: 8n };

function fakeSlashInteraction(): unknown {
  return {
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    id: "interaction-1",
    token: "interaction-token-1",
    applicationId: "application-1",
    commandName: COMMAND_NAME,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    locale: "en-US",
    guildLocale: "en-GB",
    user: { id: USER_ID, username: "tester", globalName: "Tester" },
    member: { voice: { channelId: "voice-1" } },
    memberPermissions,
    options: {
      getSubcommandGroup: () => "admin",
      getSubcommand: () => "reset",
      _hoistedOptions: [{ name: "target", type: 3, value: "x" }],
    },
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
}

function fakeAutocompleteInteraction(): unknown {
  return {
    isChatInputCommand: () => false,
    isAutocomplete: () => true,
    id: "interaction-2",
    commandName: COMMAND_NAME,
    guildId: GUILD_ID,
    locale: "en-US",
    guildLocale: "en-GB",
    user: { id: USER_ID, username: "tester", globalName: "Tester" },
    options: {
      getFocused: () => ({ name: "target", value: "par", type: 3 }),
      getSubcommandGroup: () => "admin",
      getSubcommand: () => "reset",
      _hoistedOptions: [{ name: "target", type: 3, value: "par" }],
    },
    respond: vi.fn(async () => {}),
  };
}

function fakeSelectMenuInteraction(): unknown {
  return {
    // A select menu rather than a button: `selected_values` is
    // `undefined` for buttons and JSON.stringify drops undefined keys,
    // so the select is the interaction that actually puts the field on
    // the wire.
    isAnySelectMenu: () => true,
    values: ["opt-a", "opt-b"],
    componentType: 3,
    id: "interaction-3",
    token: "interaction-token-3",
    applicationId: "application-1",
    customId: `kc:${PLUGIN_KEY}:pick`,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    message: { id: "message-1" },
    locale: "en-US",
    guildLocale: "en-GB",
    user: { id: USER_ID, username: "tester", globalName: "Tester" },
    member: { voice: { channelId: "voice-1" } },
    memberPermissions,
    deferUpdate: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
}

function fakeModalInteraction(): unknown {
  return {
    id: "interaction-4",
    token: "interaction-token-4",
    applicationId: "application-1",
    customId: `kc:${PLUGIN_KEY}:feedback`,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    locale: "en-US",
    guildLocale: "en-GB",
    user: { id: USER_ID, username: "tester", globalName: "Tester" },
    member: {},
    memberPermissions,
    fields: {
      fields: new Map([
        ["body", { type: 4, customId: "body", value: "hello" }],
      ]),
    },
    deferReply: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
}

describe("contract: interaction dispatch payloads (field-level)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await seedPluginRow();
    await upsertPluginCommand({
      pluginId: PLUGIN_ID,
      guildId: null,
      name: COMMAND_NAME,
      discordCommandId: null,
      manifestJson: JSON.stringify({ name: COMMAND_NAME }),
    });
    // The production dispatcher resolves `globalThis.fetch` at call
    // time, so this spy captures the real outbound POST without any
    // dependency injection seam in the interaction services.
    fetchSpy = okFetch();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      fetchSpy as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("slash-command payload carries every contract field", async () => {
    const claimed = await dispatchInteractionToPlugin(
      fakeSlashInteraction() as never,
    );
    expect(claimed).toBe(true);
    expect(capturedUrl(fetchSpy)).toBe(`${PLUGIN_URL}/commands/${COMMAND_NAME}`);

    const body = capturedBody(fetchSpy);
    assertPayloadMatchesContract("command", body);

    // Value-level spot checks on the two fields that once dropped
    // silently plus the identifiers a plugin cannot work without.
    expect(body.sub_command_group).toBe("admin");
    expect(body.sub_command_name).toBe("reset");
    expect((body.member as Record<string, unknown>).permissions).toBe("8");
    expect(body.command_name).toBe(COMMAND_NAME);
    expect(body.guild_id).toBe(GUILD_ID);
    expect(body.channel_id).toBe(CHANNEL_ID);
    expect(body.interaction_id).toBe("interaction-1");
    expect(body.interaction_token).toBe("interaction-token-1");
    expect(body.application_id).toBe("application-1");
    expect(body.options).toEqual([{ name: "target", type: 3, value: "x" }]);
    expect(body.user).toMatchObject({ id: USER_ID, username: "tester" });
    expect(body.locale).toBe("en-US");
    expect(body.guild_locale).toBe("en-GB");
  });

  it("slash-command payload keeps null-valued contract fields as own keys", async () => {
    const interaction = fakeSlashInteraction() as Record<string, unknown>;
    (interaction.options as Record<string, unknown>).getSubcommandGroup = () =>
      null;
    (interaction.options as Record<string, unknown>).getSubcommand = () => null;
    await dispatchInteractionToPlugin(interaction as never);
    const body = capturedBody(fetchSpy);
    // The null case is where a dropped field hides: `undefined` would
    // vanish from the JSON entirely and the SDK would see no key at all.
    expect(Object.hasOwn(body, "sub_command_group")).toBe(true);
    expect(Object.hasOwn(body, "sub_command_name")).toBe(true);
    expect(body.sub_command_group).toBeNull();
    expect(body.sub_command_name).toBeNull();
  });

  it("autocomplete payload carries every contract field", async () => {
    const claimed = await dispatchInteractionToPlugin(
      fakeAutocompleteInteraction() as never,
    );
    expect(claimed).toBe(true);
    expect(capturedUrl(fetchSpy)).toBe(
      `${PLUGIN_URL}/commands/${COMMAND_NAME}/autocomplete`,
    );

    const body = capturedBody(fetchSpy);
    assertPayloadMatchesContract("autocomplete", body);
    expect(body.sub_command_group).toBe("admin");
    expect(body.focused).toEqual({ name: "target", value: "par", type: 3 });
  });

  it("component payload carries every contract field", async () => {
    const claimed = await dispatchComponentToPlugin(
      fakeSelectMenuInteraction() as never,
    );
    expect(claimed).toBe(true);
    expect(capturedUrl(fetchSpy)).toBe(`${PLUGIN_URL}/components`);

    const body = capturedBody(fetchSpy);
    assertPayloadMatchesContract("component", body);
    expect(body.custom_id).toBe(`kc:${PLUGIN_KEY}:pick`);
    expect(body.message_id).toBe("message-1");
    expect(body.component_type).toBe(3);
    expect(body.selected_values).toEqual(["opt-a", "opt-b"]);
    const member = body.member as Record<string, unknown>;
    expect(member.permissions).toBe("8");
    expect(member.voice_channel_id).toBe("voice-1");
  });

  it("modal payload carries every contract field", async () => {
    const claimed = await dispatchModalToPlugin(fakeModalInteraction() as never);
    expect(claimed).toBe(true);
    expect(capturedUrl(fetchSpy)).toBe(`${PLUGIN_URL}/modals/feedback`);

    const body = capturedBody(fetchSpy);
    assertPayloadMatchesContract("modal", body);
    expect(body.custom_id).toBe(`kc:${PLUGIN_KEY}:feedback`);
    expect(body.components).toEqual([{ custom_id: "body", value: "hello" }]);
    expect((body.member as Record<string, unknown>).permissions).toBe("8");
  });

  it("every interaction dispatch is HMAC-signed with the contract headers", async () => {
    await dispatchInteractionToPlugin(fakeSlashInteraction() as never);
    const init = (fetchSpy.mock.calls[0] as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    const lower = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    for (const h of [
      fixtures.hmac.signatureHeader,
      fixtures.hmac.timestampHeader,
      fixtures.hmac.nonceHeader,
    ]) {
      expect(Object.hasOwn(lower, h), `missing dispatch header '${h}'`).toBe(
        true,
      );
    }
    // The signature is reproducible from the contract's payload format.
    expect(lower[fixtures.hmac.signatureHeader]).toBe(
      signBody(
        DISPATCH_KEY,
        "POST",
        `/commands/${COMMAND_NAME}`,
        lower[fixtures.hmac.timestampHeader],
        lower[fixtures.hmac.nonceHeader],
        String(init.body),
      ),
    );
  });
});
