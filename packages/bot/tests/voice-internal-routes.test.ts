/**
 * Bot-side internal voice routes (PR-2.3d) — the reverse channel from the
 * standalone voice service to the bot.
 *
 * Covers: HMAC gating (reject unsigned / wrong-sig, accept valid), input
 * validation, that gateway-send emits over the owning shard + marks the guild
 * active, and that gateway-destroy clears it. Real gateway sends are faked
 * via a stub Client.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Client } from "discord.js";
import { signBody, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../src/utils/hmac.js";
import {
  registerVoiceInternalRoutes,
  activeRemoteGuilds,
  resetActiveRemoteGuildsForTest,
} from "../src/modules/voice/voice-internal-routes.js";

const SECRET = "shared-voice-secret";

function signed(path: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  return {
    "content-type": "application/json",
    [TIMESTAMP_HEADER]: ts,
    [SIGNATURE_HEADER]: signBody(SECRET, "POST", path, ts, body),
  };
}

interface ShardSendSpy {
  sent: unknown[];
}

function fakeBot(opts: { hasGuild: boolean; shard: ShardSendSpy }): Client {
  const guild = {
    shard: {
      send: (payload: unknown) => {
        opts.shard.sent.push(payload);
      },
    },
  };
  return {
    guilds: {
      cache: {
        get: (id: string) => (opts.hasGuild ? guild : undefined),
      },
    },
  } as unknown as Client;
}

async function buildApp(bot: Client | undefined): Promise<FastifyInstance> {
  const app = Fastify();
  await registerVoiceInternalRoutes(app, { bot, secrets: () => [SECRET] });
  await app.ready();
  return app;
}

describe("bot internal voice routes", () => {
  beforeEach(() => resetActiveRemoteGuildsForTest());

  it("rejects an unsigned gateway-send with 401", async () => {
    const app = await buildApp(fakeBot({ hasGuild: true, shard: { sent: [] } }));
    const res = await app.inject({
      method: "POST",
      url: "/internal/voice/gateway-send",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ guildId: "g1", payload: { op: 4 } }),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a wrong-signature gateway-send with 401", async () => {
    const app = await buildApp(fakeBot({ hasGuild: true, shard: { sent: [] } }));
    const body = JSON.stringify({ guildId: "g1", payload: { op: 4 } });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await app.inject({
      method: "POST",
      url: "/internal/voice/gateway-send",
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: ts,
        [SIGNATURE_HEADER]: "bad",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("emits the payload over the owning shard and marks the guild active", async () => {
    const shard: ShardSendSpy = { sent: [] };
    const app = await buildApp(fakeBot({ hasGuild: true, shard }));
    const path = "/internal/voice/gateway-send";
    const payload = { op: 4, d: { guild_id: "g1", channel_id: "c1" } };
    const body = JSON.stringify({ guildId: "g1", payload });
    const res = await app.inject({
      method: "POST",
      url: path,
      headers: signed(path, body),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: true });
    expect(shard.sent).toEqual([payload]);
    expect(activeRemoteGuilds.has("g1")).toBe(true);
    await app.close();
  });

  it("404s gateway-send for a guild the bot doesn't know", async () => {
    const app = await buildApp(fakeBot({ hasGuild: false, shard: { sent: [] } }));
    const path = "/internal/voice/gateway-send";
    const body = JSON.stringify({
      guildId: "ghost",
      payload: { op: 4, d: { guild_id: "ghost" } },
    });
    const res = await app.inject({
      method: "POST",
      url: path,
      headers: signed(path, body),
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect(activeRemoteGuilds.has("ghost")).toBe(false);
    await app.close();
  });

  it("400s and does not relay a non-OP4 payload", async () => {
    const shard: ShardSendSpy = { sent: [] };
    const app = await buildApp(fakeBot({ hasGuild: true, shard }));
    const path = "/internal/voice/gateway-send";
    // OP8 (request guild members) — must never be injectable onto the shard.
    const body = JSON.stringify({
      guildId: "g1",
      payload: { op: 8, d: { guild_id: "g1", query: "" } },
    });
    const res = await app.inject({
      method: "POST",
      url: path,
      headers: signed(path, body),
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(shard.sent).toEqual([]);
    expect(activeRemoteGuilds.has("g1")).toBe(false);
    await app.close();
  });

  it("400s an OP4 whose d.guild_id does not match guildId", async () => {
    const shard: ShardSendSpy = { sent: [] };
    const app = await buildApp(fakeBot({ hasGuild: true, shard }));
    const path = "/internal/voice/gateway-send";
    const body = JSON.stringify({
      guildId: "g1",
      payload: { op: 4, d: { guild_id: "other-guild" } },
    });
    const res = await app.inject({
      method: "POST",
      url: path,
      headers: signed(path, body),
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(shard.sent).toEqual([]);
    await app.close();
  });

  it("400s gateway-send missing guildId / payload", async () => {
    const app = await buildApp(fakeBot({ hasGuild: true, shard: { sent: [] } }));
    const path = "/internal/voice/gateway-send";
    const body = JSON.stringify({ guildId: "g1" });
    const res = await app.inject({
      method: "POST",
      url: path,
      headers: signed(path, body),
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("gateway-destroy clears the active guild", async () => {
    const app = await buildApp(fakeBot({ hasGuild: true, shard: { sent: [] } }));
    activeRemoteGuilds.add("g1");
    const path = "/internal/voice/gateway-destroy";
    const body = JSON.stringify({ guildId: "g1" });
    const res = await app.inject({
      method: "POST",
      url: path,
      headers: signed(path, body),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(activeRemoteGuilds.has("g1")).toBe(false);
    await app.close();
  });

  it("503s when no shared secret is configured", async () => {
    const app = Fastify();
    await registerVoiceInternalRoutes(app, {
      bot: fakeBot({ hasGuild: true, shard: { sent: [] } }),
      secrets: () => [],
    });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/internal/voice/gateway-send",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ guildId: "g1", payload: { op: 4 } }),
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
