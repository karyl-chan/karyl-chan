/**
 * POST /api/discord/messages/forward resolves the destination channel with
 * a live bot.channels.fetch() BEFORE it can know whether to apply the
 * dm.message vs guild.<id>.message check. A coarse messaging gate must run
 * FIRST so an authenticated caller with no messaging capability can't drive
 * arbitrary channel fetches (rate-limit burn + channel-existence probing).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Client } from "discord.js";
import { registerDiscordRoutes } from "../src/modules/web-core/discord-routes.js";
import type { AdminCapability } from "../src/modules/admin/authorized-user.service.js";

const SRC_CHANNEL = "100000000000000001";
const SRC_MESSAGE = "100000000000000002";
const DST_CHANNEL = "100000000000000003";

function buildBot(fetchSpy: ReturnType<typeof vi.fn>): Client {
  return {
    // resolveTextChannel checks channels.cache.get(id) before fetch().
    channels: { cache: new Map(), fetch: fetchSpy },
    guilds: { cache: new Map() },
  } as unknown as Client;
}

async function buildServer(
  bot: Client,
  caps: AdminCapability[],
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  fastify.addHook("onRequest", async (request) => {
    request.authUserId = "u";
    request.authCapabilities = new Set(caps);
  });
  await registerDiscordRoutes(fastify, { bot });
  await fastify.ready();
  return fastify;
}

let server: FastifyInstance | null = null;
afterEach(async () => {
  if (server) await server.close();
  server = null;
});

const BODY = {
  sourceChannelId: SRC_CHANNEL,
  sourceMessageId: SRC_MESSAGE,
  targetChannelId: DST_CHANNEL,
};

describe("forward message — authz before channel fetch", () => {
  it("403s a caller with no messaging capability WITHOUT fetching the channel", async () => {
    const fetchSpy = vi.fn(async () => null);
    server = await buildServer(buildBot(fetchSpy), ["system.read"]);
    const r = await server.inject({
      method: "POST",
      url: "/api/discord/messages/forward",
      payload: BODY,
    });
    expect(r.statusCode).toBe(403);
    // The fix: the bot must NOT have been forced to resolve the channel.
    // On main, fetch ran first and the 403 only came from the post-fetch
    // precise check.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets a dm.message holder through to channel resolution", async () => {
    const fetchSpy = vi.fn(async () => null); // unresolvable → 404 after the gate
    server = await buildServer(buildBot(fetchSpy), ["dm.message"]);
    const r = await server.inject({
      method: "POST",
      url: "/api/discord/messages/forward",
      payload: BODY,
    });
    expect(r.statusCode).toBe(404);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
