/**
 * The interaction replies open the sealed `interaction_token` before they
 * reach Discord (#215), observed over HTTP.
 *
 *  - a plugin's own token works and Discord sees the token inside it;
 *  - another plugin's, a tampered, an expired or a malformed token is a
 *    403 on every `interactions.*` route that takes one, nothing reaches
 *    Discord, and the refusal is a bot event naming the caller and the
 *    reason — rate-limited per plugin;
 *  - the respond route's defer routing still keys on the Discord token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/plugin-system/models/plugin.model.js", () => ({
  findPluginById: vi.fn(),
  findPluginByKey: vi.fn(),
}));

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
  setBotEventLogMetric: vi.fn(),
}));

vi.mock("../src/modules/bot-events/bot-event-dedup.js", () => ({
  shouldRecord: vi.fn(() => true),
}));

import type { FastifyInstance } from "fastify";
import { createWebServer } from "../src/modules/web-core/server.js";
import { pluginAuthStore } from "../src/modules/plugin-system/plugin-auth.service.js";
import { findPluginById } from "../src/modules/plugin-system/models/plugin.model.js";
import { botEventLog } from "../src/modules/bot-events/bot-event-log.js";
import { shouldRecord } from "../src/modules/bot-events/bot-event-dedup.js";
import {
  INTERACTION_TOKEN_TTL_MS,
  sealInteractionToken,
} from "../src/modules/plugin-system/plugin-interaction-token.js";
import {
  _resetPluginDeferStateForTests,
  readPluginDeferState,
  recordPluginDeferReply,
  recordPluginDeferUpdate,
} from "../src/modules/plugin-system/plugin-defer-state.js";

/** Bearer token → plugin id; every plugin holds every interactions scope. */
const PLUGINS: Record<string, number> = { "token-a": 1, "token-b": 2 };
const DISCORD_TOKEN = "discord-interaction-token-for-plugin-a";
const MINE = () => sealInteractionToken(DISCORD_TOKEN, 1);

const SCOPES = [
  "interactions.respond",
  "interactions.followup",
  "interactions.delete_followup",
  "interactions.edit_followup",
  "interactions.send_modal",
];

/** One well-formed call per route, given its token. */
const CALLS: Array<[string, (token: string) => Record<string, unknown>]> = [
  ["interactions.respond", (t) => ({ interaction_token: t, content: "x" })],
  ["interactions.followup", (t) => ({ interaction_token: t, content: "x" })],
  ["interactions.delete_followup", (t) => ({ interaction_token: t, message_id: "m-1" })],
  ["interactions.edit_followup", (t) => ({ interaction_token: t, message_id: "m-1", content: "x" })],
  [
    "interactions.send_modal",
    (t) => ({
      interaction_id: "111111111111111111",
      interaction_token: t,
      modal: { custom_id: "kc:plugin-1:m", title: "t", components: [] },
    }),
  ],
];

function fakeRest() {
  return {
    post: vi.fn().mockResolvedValue({ id: "followup-1" }),
    patch: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

let server: FastifyInstance;
let rest: ReturnType<typeof fakeRest>;

beforeEach(async () => {
  vi.clearAllMocks();
  _resetPluginDeferStateForTests();
  vi.spyOn(pluginAuthStore, "verify").mockImplementation((token: string) =>
    PLUGINS[token] === undefined
      ? null
      : {
          pluginId: PLUGINS[token]!,
          pluginKey: `plugin-${PLUGINS[token]}`,
          scopes: new Set(SCOPES),
          expiresAt: Date.now() + 60_000,
        },
  );
  vi.mocked(findPluginById).mockImplementation(
    async (id: number) =>
      ({
        id,
        pluginKey: `plugin-${id}`,
        url: "http://plugin.invalid/",
        enabled: true,
        status: "active",
        manifestJson: "{}",
      }) as never,
  );
  rest = fakeRest();
  server = await createWebServer({
    staticRoot: undefined,
    bot: {
      user: { id: "bot-1" },
      application: { id: "app-1" },
      isReady: () => true,
      uptime: 0,
      guilds: { cache: new Map() },
      channels: { fetch: vi.fn(), cache: { get: vi.fn() } },
      rest,
    } as never,
  });
  await server.ready();
});

afterEach(async () => {
  await server.close();
});

function rpc(method: string, payload: Record<string, unknown>, bearer = "token-a") {
  return server.inject({
    method: "POST",
    url: `/api/plugin/${method}`,
    headers: { authorization: `Bearer ${bearer}` },
    payload: payload as never,
  });
}

/** Every Discord route the fake REST client was asked for. */
function discordRoutes(): string[] {
  return [...rest.post.mock.calls, ...rest.patch.mock.calls, ...rest.delete.mock.calls].map(
    ([route]) => String(route),
  );
}

describe("interactions.* open the sealed interaction_token (#215)", () => {
  it.each(CALLS)("%s works with the plugin's own token, reaching Discord with the token inside", async (method, body) => {
    const sealed = MINE();
    const res = await rpc(method, body(sealed));

    expect(res.statusCode).toBe(200);
    const routes = discordRoutes();
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route).toContain(DISCORD_TOKEN);
      expect(route).not.toContain(sealed);
    }
    expect(botEventLog.record).not.toHaveBeenCalled();
  });

  it.each(CALLS)("%s refuses another plugin's token with a 403 and a bot event", async (method, body) => {
    // plugin B calls with the token dispatched to plugin A
    const res = await rpc(method, body(MINE()), "token-b");

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "interaction_token refused: wrong_plugin" });
    expect(discordRoutes()).toEqual([]);
    expect(botEventLog.record).toHaveBeenCalledTimes(1);
    const [level, category, message, meta] = vi.mocked(botEventLog.record).mock.calls[0]!;
    expect([level, category]).toEqual(["warn", "auth"]);
    expect(message).toContain("plugin-2");
    expect(message).toContain(method);
    expect(meta).toEqual({ pluginId: 2, method, reason: "wrong_plugin" });
  });

  const tampered = () => {
    const parts = MINE().split(".");
    const ct = parts[4]!;
    parts[4] = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    return parts.join(".");
  };
  const expired = () =>
    sealInteractionToken(DISCORD_TOKEN, 1, Date.now() - INTERACTION_TOKEN_TTL_MS - 1000);

  const BAD: Array<[string, () => string, string]> = [
    ["tampered", tampered, "unsealable"],
    ["expired", expired, "expired"],
    ["a raw Discord token", () => DISCORD_TOKEN, "malformed"],
    ["garbage", () => "not-a-token", "malformed"],
  ];

  for (const [method, body] of CALLS) {
    it.each(BAD)(`${method} refuses a %s token with a 403`, async (_label, token, reason) => {
      const res = await rpc(method, body(token()));

      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: `interaction_token refused: ${reason}` });
      expect(discordRoutes()).toEqual([]);
      expect(vi.mocked(botEventLog.record).mock.calls[0]?.[3]).toEqual({
        pluginId: 1,
        method,
        reason,
      });
    });
  }

  it("rate-limits the refusal events per plugin", async () => {
    const { shouldRecord: real } = await vi.importActual<
      typeof import("../src/modules/bot-events/bot-event-dedup.js")
    >("../src/modules/bot-events/bot-event-dedup.js");
    vi.mocked(shouldRecord).mockImplementation(real);

    for (let i = 0; i < 3; i++) {
      expect((await rpc("interactions.followup", { interaction_token: "x", content: "x" })).statusCode).toBe(403);
    }
    expect((await rpc("interactions.followup", { interaction_token: "x", content: "x" }, "token-b")).statusCode).toBe(403);

    // three refusals from plugin 1 → one event; plugin 2 gets its own
    expect(vi.mocked(botEventLog.record).mock.calls.map((c) => (c[3] as { pluginId: number }).pluginId)).toEqual([1, 2]);
    expect(shouldRecord).toHaveBeenCalledWith("plugin-interaction-token-refused:1");
  });

  it("still refuses a missing interaction_token with the old 400", async () => {
    const res = await rpc("interactions.respond", { content: "x" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "interaction_token required" });
  });
});

describe("interactions.respond keeps its defer routing on the Discord token (#215)", () => {
  it("PATCHes @original when the ephemerality matches the defer, then clears the state", async () => {
    recordPluginDeferReply(DISCORD_TOKEN, true);

    const res = await rpc("interactions.respond", { interaction_token: MINE(), content: "x", ephemeral: true });

    expect(res.statusCode).toBe(200);
    expect(rest.patch).toHaveBeenCalledTimes(1);
    expect(String(rest.patch.mock.calls[0]![0])).toBe(`/webhooks/app-1/${DISCORD_TOKEN}/messages/%40original`);
    expect(rest.post).not.toHaveBeenCalled();
    expect(readPluginDeferState(DISCORD_TOKEN)).toBeNull();
  });

  it("posts a follow-up and DELETEs @original when the plugin flips the ephemerality", async () => {
    recordPluginDeferReply(DISCORD_TOKEN, true);

    const res = await rpc("interactions.respond", { interaction_token: MINE(), content: "x", ephemeral: false });

    expect(res.statusCode).toBe(200);
    expect(String(rest.post.mock.calls[0]![0])).toBe(`/webhooks/app-1/${DISCORD_TOKEN}`);
    expect(String(rest.delete.mock.calls[0]![0])).toBe(`/webhooks/app-1/${DISCORD_TOKEN}/messages/%40original`);
    expect(rest.patch).not.toHaveBeenCalled();
    expect(readPluginDeferState(DISCORD_TOKEN)).toBeNull();
  });

  it("PATCHes the clicked message for a component's deferUpdate, whatever the ephemerality", async () => {
    recordPluginDeferUpdate(DISCORD_TOKEN);

    const res = await rpc("interactions.respond", { interaction_token: MINE(), content: "x", ephemeral: false });

    expect(res.statusCode).toBe(200);
    expect(rest.patch).toHaveBeenCalledTimes(1);
    expect(rest.delete).not.toHaveBeenCalled();
  });
});
