/**
 * The Plugin Dispatch deep module (#28) — one gate/deliver path for all
 * six Dispatch Kinds, tested through the createPluginDispatcher factory
 * with injected fakes (no DB, no network): a fake fetch for the direct
 * transport, a fake pool for the pooled transport, a fake bus, and a
 * fake Feature Reach resolver. Health recording is asserted against the
 * real plugin-dispatch-health service (reset per test).
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

// Controllable SSRF preflight — default open; individual tests flip it.
const preflightMock = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: true } | { ok: false; reason: string }>>(),
);
vi.mock(
  "../src/modules/plugin-system/plugin-dispatch-util.js",
  async (orig) => {
    const real = (await orig()) as Record<string, unknown>;
    return { ...real, preflightPluginTarget: preflightMock };
  },
);

import {
  createPluginDispatcher,
  type PluginDispatcher,
} from "../src/modules/plugin-system/plugin-dispatch.service.js";
import type { PluginRow } from "../src/modules/plugin-system/models/plugin.model.js";
import type { PluginDispatchPool } from "../src/modules/plugin-system/plugin-dispatch-pool.js";
import type { PluginEventBus } from "../src/adapters/plugin-event-bus.js";
import {
  getDispatchHealth,
  __resetDispatchHealthForTests,
} from "../src/modules/plugin-system/plugin-dispatch-health.service.js";

function makePlugin(overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id: 1,
    pluginKey: "alpha",
    name: "alpha",
    version: "1.0.0",
    url: "http://alpha.invalid",
    manifestJson: JSON.stringify({
      schema_version: "1",
      plugin: {
        id: "alpha",
        name: "alpha",
        version: "1.0.0",
        url: "http://alpha.invalid",
      },
    }),
    status: "active",
    tokenHash: null,
    enabled: true,
    lastHeartbeatAt: null,
    setupSecretHash: null,
    dispatchHmacKey: "k",
    approvedRpcScopes: [],
    approvedGlobalEventSubs: [],
    configSchemaVersion: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as PluginRow;
}

const reachYes = {
  hasGuildReach: vi.fn(async () => true),
  isFeatureEnabledInGuild: vi.fn(async () => true),
};
const reachNo = {
  hasGuildReach: vi.fn(async () => false),
  isFeatureEnabledInGuild: vi.fn(async () => false),
};

function fakeFetchOk(status = 204, body: string | null = null): typeof fetch {
  return vi.fn(
    async () => new Response(body, { status }),
  ) as unknown as typeof fetch;
}

function makeDispatcher(
  deps: Parameters<typeof createPluginDispatcher>[0] = {},
): PluginDispatcher {
  return createPluginDispatcher({
    reach: reachYes,
    resolveReadyEndpoint: (_key, preferred) => preferred,
    ...deps,
  });
}

beforeEach(() => {
  __resetDispatchHealthForTests();
  preflightMock.mockReset();
  preflightMock.mockResolvedValue({ ok: true });
});

describe("gate", () => {
  it("skips every dispatch kind when no replica is ready", async () => {
    const d = makeDispatcher({ resolveReadyEndpoint: () => null });
    for (const kind of [
      "command",
      "autocomplete",
      "component",
      "modal",
      "lifecycle",
      "event",
      "behavior_action",
    ] as const) {
      const result = await d.gate({
        kind,
        plugin: makePlugin(),
        guildId: kind === "event" ? null : undefined,
        scopes: kind === "event" ? ["global"] : undefined,
      });
      expect(result).toEqual({ ok: false, reason: "plugin_not_ready" });
    }
  });

  it("skips a disabled or non-active plugin", async () => {
    const d = makeDispatcher();
    const off = await d.gate({
      kind: "command",
      plugin: makePlugin({ enabled: false }),
    });
    expect(off).toEqual({ ok: false, reason: "plugin_offline" });
    const inactive = await d.gate({
      kind: "command",
      plugin: makePlugin({ status: "inactive" }),
    });
    expect(inactive).toEqual({ ok: false, reason: "plugin_offline" });
  });

  it("skips an unparseable manifest for manifest-requiring kinds", async () => {
    const d = makeDispatcher();
    const res = await d.gate({
      kind: "command",
      plugin: makePlugin({ manifestJson: "{nope" }),
    });
    expect(res).toEqual({ ok: false, reason: "manifest_invalid" });
  });

  it("component/modal Guild Reach: denied only when a guild is present and Guild Reach says no", async () => {
    const denied = makeDispatcher({ reach: reachNo });
    const plugin = makePlugin();
    const inGuild = await denied.gate({
      kind: "component",
      plugin,
      guildId: "g1",
    });
    expect(inGuild).toEqual({ ok: false, reason: "reach_denied" });
    // Guild Reach is asked about the plugin itself (Command Reach reads
    // its track-3 rows), not just its feature map.
    expect(reachNo.hasGuildReach).toHaveBeenCalledWith(
      plugin,
      "g1",
      expect.objectContaining({ plugin: expect.anything() }),
    );
    const modal = await denied.gate({ kind: "modal", plugin, guildId: "g1" });
    expect(modal).toEqual({ ok: false, reason: "reach_denied" });
    const granted = await makeDispatcher({ reach: reachYes }).gate({
      kind: "modal",
      plugin,
      guildId: "g1",
    });
    expect(granted.ok).toBe(true);
    // No guild (DM) → the gate does not consult reach at all.
    const dm = await denied.gate({
      kind: "component",
      plugin: makePlugin(),
      guildId: null,
    });
    expect(dm.ok).toBe(true);
  });

  it("skips when the dispatch HMAC key is missing", async () => {
    const d = makeDispatcher();
    const res = await d.gate({
      kind: "modal",
      plugin: makePlugin({ dispatchHmacKey: null }),
      guildId: null,
    });
    expect(res).toEqual({ ok: false, reason: "no_dispatch_key" });
  });

  it("event per-scope reach: global passes, feature scope needs guild + reach, DM never matches a feature scope", async () => {
    const d = makeDispatcher({ reach: reachNo });
    const global = await d.gate({
      kind: "event",
      plugin: makePlugin(),
      guildId: null,
      scopes: ["global"],
    });
    expect(global.ok).toBe(true);
    const featDenied = await d.gate({
      kind: "event",
      plugin: makePlugin(),
      guildId: "g1",
      scopes: [{ featureKey: "f" }],
    });
    expect(featDenied).toEqual({ ok: false, reason: "reach_denied" });
    const dm = await d.gate({
      kind: "event",
      plugin: makePlugin(),
      guildId: null,
      scopes: [{ featureKey: "f" }],
    });
    expect(dm).toEqual({ ok: false, reason: "reach_denied" });
  });

  it("event kind gates without a parseable manifest when a global scope grants delivery", async () => {
    const d = makeDispatcher();
    const res = await d.gate({
      kind: "event",
      plugin: makePlugin({ manifestJson: "{nope" }),
      guildId: null,
      scopes: ["global"],
    });
    expect(res.ok).toBe(true);
  });
});

describe("deliver — direct transport", () => {
  it("routes to a ready sibling instead of an initializing preferred replica", async () => {
    const fetchImpl = fakeFetchOk(204);
    const d = makeDispatcher({
      fetchImpl,
      resolveReadyEndpoint: () => "http://alpha-ready.invalid",
    });
    await d.deliver({
      kind: "command",
      plugin: makePlugin({ url: "http://alpha-initializing.invalid" }),
      label: "ping",
      endpointVars: { command_name: "ping" },
      payload: { body: () => "{}" },
    });
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toBe("http://alpha-ready.invalid/commands/ping");
  });

  it("POSTs signed JSON and records ok health without reading the body", async () => {
    const fetchImpl = fakeFetchOk(204);
    const d = makeDispatcher({ fetchImpl });
    const outcome = await d.deliver({
      kind: "command",
      plugin: makePlugin(),
      label: "ping",
      endpointVars: { command_name: "ping" },
      payload: { body: () => JSON.stringify({ hi: 1 }) },
    });
    expect(outcome).toEqual({ status: "ok", httpStatus: 204 });
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(call[0]).toBe("http://alpha.invalid/commands/ping");
    expect(call[1].redirect).toBe("manual");
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(
      Object.keys(headers).some((h) => h.toLowerCase().includes("signature")),
    ).toBe(true);
    const health = getDispatchHealth("alpha");
    expect(health?.okCount).toBe(1);
    expect(health?.recent[0]).toMatchObject({
      ok: true,
      source: "command",
      status: 204,
    });
  });

  it("autocomplete reads the response body as JSON", async () => {
    const d = makeDispatcher({
      fetchImpl: fakeFetchOk(
        200,
        JSON.stringify({ choices: [{ name: "a", value: "a" }] }),
      ),
    });
    const outcome = await d.deliver({
      kind: "autocomplete",
      plugin: makePlugin(),
      label: "ping",
      endpointVars: { command_name: "ping" },
      payload: { body: () => "{}" },
    });
    expect(outcome.status).toBe("ok");
    expect((outcome as { body?: unknown }).body).toEqual({
      choices: [{ name: "a", value: "a" }],
    });
  });

  it("maps a non-2xx response to http_error with the failure classification", async () => {
    const d = makeDispatcher({ fetchImpl: fakeFetchOk(401, "bad sig") });
    const outcome = await d.deliver({
      kind: "component",
      plugin: makePlugin(),
      label: "kc:alpha:x",
      payload: { body: () => "{}" },
    });
    expect(outcome).toMatchObject({
      status: "failed",
      reason: "http_error",
      httpStatus: 401,
      detail: "bad sig",
      failureClass: "rejected_401",
    });
    expect(getDispatchHealth("alpha")?.recent[0]).toMatchObject({
      ok: false,
      source: "component",
      status: 401,
      failureClass: "rejected_401",
    });
  });

  it("maps a thrown fetch to network failure and records health", async () => {
    const boom = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const d = makeDispatcher({ fetchImpl: boom });
    const outcome = await d.deliver({
      kind: "modal",
      plugin: makePlugin(),
      label: "kc:alpha:m",
      payload: { body: () => "{}" },
    });
    expect(outcome).toMatchObject({
      status: "failed",
      reason: "network",
      detail: "ECONNREFUSED",
    });
    expect(getDispatchHealth("alpha")?.recent[0]).toMatchObject({
      ok: false,
      failureClass: "network",
    });
  });

  it("records unreachable on an unresolvable endpoint URL", async () => {
    const d = makeDispatcher({ fetchImpl: fakeFetchOk() });
    const outcome = await d.deliver({
      kind: "command",
      plugin: makePlugin({ url: "not a url" }),
      label: "ping",
      endpointVars: { command_name: "ping" },
      payload: { body: () => "{}" },
    });
    expect(outcome).toMatchObject({
      status: "failed",
      reason: "unresolvable_endpoint",
    });
    expect(getDispatchHealth("alpha")?.recent[0]).toMatchObject({
      ok: false,
      failureClass: "unreachable",
    });
  });

  it("records unreachable when the SSRF preflight refuses", async () => {
    preflightMock.mockResolvedValue({ ok: false, reason: "private address" });
    const fetchImpl = fakeFetchOk();
    const d = makeDispatcher({ fetchImpl });
    const outcome = await d.deliver({
      kind: "command",
      plugin: makePlugin(),
      label: "ping",
      endpointVars: { command_name: "ping" },
      payload: { body: () => "{}" },
    });
    expect(outcome).toMatchObject({
      status: "failed",
      reason: "preflight_denied",
      detail: "private address",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getDispatchHealth("alpha")?.recent[0]).toMatchObject({
      ok: false,
      failureClass: "unreachable",
    });
  });

  it("lifecycle skips silently (no health) when the plugin declares no lifecycle endpoint", async () => {
    const fetchImpl = fakeFetchOk();
    const d = makeDispatcher({ fetchImpl });
    const outcome = await d.deliver({
      kind: "lifecycle",
      plugin: makePlugin(),
      label: "plugin.guild.enabled",
      payload: { data: { guild_id: "g1", feature_key: "f" } },
    });
    expect(outcome).toEqual({ status: "skipped", reason: "no_endpoint" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getDispatchHealth("alpha")).toBeNull();
  });

  it("lifecycle posts {type,data} to the declared endpoint", async () => {
    const fetchImpl = fakeFetchOk(200);
    const d = makeDispatcher({ fetchImpl });
    const plugin = makePlugin({
      manifestJson: JSON.stringify({
        schema_version: "1",
        plugin: {
          id: "alpha",
          name: "alpha",
          version: "1.0.0",
          url: "http://alpha.invalid",
        },
        endpoints: { plugin_lifecycle: "/_kc/lifecycle" },
      }),
    });
    const outcome = await d.deliver({
      kind: "lifecycle",
      plugin,
      label: "plugin.guild.enabled",
      payload: { data: { guild_id: "g1", feature_key: "f" } },
    });
    expect(outcome).toEqual({ status: "ok", httpStatus: 200 });
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(call[0]).toBe("http://alpha.invalid/_kc/lifecycle");
    expect(JSON.parse(call[1].body as string)).toEqual({
      type: "plugin.guild.enabled",
      data: { guild_id: "g1", feature_key: "f" },
    });
  });
});

describe("deliver — event kind (pooled + bus transports)", () => {
  function fakePool(
    outcome: Awaited<ReturnType<PluginDispatchPool["post"]>>,
  ): PluginDispatchPool {
    return {
      post: vi.fn(async () => outcome),
    } as unknown as PluginDispatchPool;
  }

  it("posts through the pool with signature + traceparent headers", async () => {
    const pool = fakePool({ ok: true, status: 204, bodyText: "" });
    const d = makeDispatcher({ pool });
    const outcome = await d.deliver({
      kind: "event",
      plugin: makePlugin(),
      label: "guild.message_create",
      payload: { data: { hi: 1 } },
    });
    expect(outcome).toEqual({ status: "ok", httpStatus: 204 });
    const call = (pool.post as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, Record<string, string>, string];
    expect(call[0]).toBe("alpha");
    expect(call[1]).toBe("http://alpha.invalid/events");
    expect(call[2]["traceparent"]).toMatch(/^00-/);
    expect(JSON.parse(call[3])).toEqual({
      type: "guild.message_create",
      data: { hi: 1 },
    });
    expect(getDispatchHealth("alpha")?.recent[0]).toMatchObject({
      ok: true,
      source: "event",
      status: 204,
    });
  });

  it("does not record health for breaker_open / shed short-circuits", async () => {
    const d = makeDispatcher({
      pool: fakePool({
        ok: false,
        reason: "breaker_open",
        message: "circuit breaker open",
      }),
    });
    const outcome = await d.deliver({
      kind: "event",
      plugin: makePlugin(),
      label: "guild.message_create",
      payload: { data: {} },
    });
    expect(outcome).toMatchObject({
      status: "failed",
      reason: "breaker_open",
      detail: "circuit breaker open",
    });
    expect(getDispatchHealth("alpha")).toBeNull();
  });

  it("records pooled http failures into dispatch health", async () => {
    const d = makeDispatcher({
      pool: fakePool({
        ok: false,
        reason: "http_error",
        status: 500,
        message: "HTTP 500",
      }),
    });
    const outcome = await d.deliver({
      kind: "event",
      plugin: makePlugin(),
      label: "guild.message_create",
      payload: { data: {} },
    });
    expect(outcome).toMatchObject({
      status: "failed",
      reason: "http_error",
      httpStatus: 500,
    });
    expect(getDispatchHealth("alpha")?.recent[0]).toMatchObject({
      ok: false,
      source: "event",
      status: 500,
      failureClass: "http_error",
    });
  });

  it("routes to the bus before the signing-key and manifest checks", async () => {
    const sent: unknown[][] = [];
    const bus: PluginEventBus = {
      dispatchToPlugin: (...args: unknown[]) => {
        sent.push(args);
      },
    } as PluginEventBus;
    const pool = fakePool({ ok: true, status: 204, bodyText: "" });
    const d = makeDispatcher({ pool, getEventBus: () => bus });
    // No dispatch key AND an unparseable manifest — the bus must still deliver.
    const plugin = makePlugin({ dispatchHmacKey: null, manifestJson: "{nope" });
    const outcome = await d.deliver({
      kind: "event",
      plugin,
      label: "guild.message_create",
      payload: { data: { hi: 1 } },
    });
    expect(outcome).toEqual({ status: "ok" });
    expect(sent).toEqual([[1, "alpha", "guild.message_create", { hi: 1 }]]);
    expect(pool.post).not.toHaveBeenCalled();
  });

  it("skips silently on the HTTP path when the signing key is missing", async () => {
    const pool = fakePool({ ok: true, status: 204, bodyText: "" });
    const d = makeDispatcher({ pool });
    const outcome = await d.deliver({
      kind: "event",
      plugin: makePlugin({ dispatchHmacKey: null }),
      label: "e",
      payload: { data: {} },
    });
    expect(outcome).toEqual({ status: "skipped", reason: "no_dispatch_key" });
    expect(pool.post).not.toHaveBeenCalled();
    expect(getDispatchHealth("alpha")).toBeNull();
  });
});

describe("dispatch (gate + deliver)", () => {
  it("composes: an offline plugin never reaches the transport", async () => {
    const fetchImpl = fakeFetchOk();
    const d = makeDispatcher({ fetchImpl });
    const outcome = await d.dispatch({
      kind: "command",
      plugin: makePlugin({ enabled: false }),
      label: "ping",
      endpointVars: { command_name: "ping" },
      payload: { body: () => "{}" },
    });
    expect(outcome).toEqual({ status: "skipped", reason: "plugin_offline" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("builds the body only after the preflight passes", async () => {
    preflightMock.mockResolvedValue({ ok: false, reason: "nope" });
    const build = vi.fn(() => "{}");
    const d = makeDispatcher({ fetchImpl: fakeFetchOk() });
    await d.dispatch({
      kind: "command",
      plugin: makePlugin(),
      label: "ping",
      endpointVars: { command_name: "ping" },
      payload: { body: build },
    });
    expect(build).not.toHaveBeenCalled();
  });
});

describe("behavior_action kind (#203)", () => {
  it("has no reach check: the binding is the authorization", async () => {
    reachNo.hasGuildReach.mockClear();
    reachNo.isFeatureEnabledInGuild.mockClear();
    const d = makeDispatcher({ reach: reachNo });
    const g = await d.gate({ kind: "behavior_action", plugin: makePlugin(), guildId: "G1" });
    expect(g.ok).toBe(true);
    expect(reachNo.hasGuildReach).not.toHaveBeenCalled();
    expect(reachNo.isFeatureEnabledInGuild).not.toHaveBeenCalled();
  });

  it("is refused like the other interaction kinds: offline, no key, bad manifest", async () => {
    const d = makeDispatcher();
    expect(await d.gate({ kind: "behavior_action", plugin: makePlugin({ enabled: false }) })).toEqual({
      ok: false,
      reason: "plugin_offline",
    });
    expect(await d.gate({ kind: "behavior_action", plugin: makePlugin({ dispatchHmacKey: null }) })).toEqual({
      ok: false,
      reason: "no_dispatch_key",
    });
    expect(await d.gate({ kind: "behavior_action", plugin: makePlugin({ manifestJson: "{nope" }) })).toEqual({
      ok: false,
      reason: "manifest_invalid",
    });
  });

  it("POSTs signed JSON to /behavior-actions/{action_key}, never reads the body, records health", async () => {
    const fetchImpl = fakeFetchOk(204);
    const d = makeDispatcher({ fetchImpl });
    const outcome = await d.deliver({
      kind: "behavior_action",
      plugin: makePlugin(),
      label: "roll",
      endpointVars: { action_key: "roll" },
      payload: { body: () => JSON.stringify({ action_key: "roll" }) },
    });
    expect(outcome).toEqual({ status: "ok", httpStatus: 204 });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://alpha.invalid/behavior-actions/roll");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).some((h) => h.toLowerCase().includes("signature"))).toBe(true);
    expect(getDispatchHealth("alpha")?.recent[0]).toMatchObject({ ok: true, source: "behavior_action", status: 204 });
  });

  it("follows the manifest's endpoints.behavior_action", async () => {
    const fetchImpl = fakeFetchOk(204);
    const d = makeDispatcher({ fetchImpl });
    const manifest = JSON.parse(makePlugin().manifestJson) as Record<string, unknown>;
    manifest.endpoints = { behavior_action: "/x/actions/{action_key}" };
    await d.deliver({
      kind: "behavior_action",
      plugin: makePlugin({ manifestJson: JSON.stringify(manifest) }),
      label: "roll",
      endpointVars: { action_key: "roll" },
      payload: { body: () => "{}" },
    });
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("http://alpha.invalid/x/actions/roll");
  });

  it("records a failed dispatch under its own source", async () => {
    const d = makeDispatcher({ fetchImpl: fakeFetchOk(500, "boom") });
    const outcome = await d.deliver({
      kind: "behavior_action",
      plugin: makePlugin(),
      label: "roll",
      endpointVars: { action_key: "roll" },
      payload: { body: () => "{}" },
    });
    expect(outcome).toMatchObject({ status: "failed", reason: "http_error", httpStatus: 500 });
    expect(getDispatchHealth("alpha")?.recent[0]).toMatchObject({ ok: false, source: "behavior_action", status: 500 });
  });
});
