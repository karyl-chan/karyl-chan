/**
 * PATCH /api/guilds/:id/settings systemChannelFlags must MERGE against the
 * guild's current flags, not overwrite from zero. Discord treats
 * system_channel_flags as a full replacement, and the payload/frontend
 * types declare the flags object as Partial — so a body that omits a flag
 * must leave it untouched, otherwise toggling one flag silently clears the
 * others.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { GuildSystemChannelFlags } from "discord.js";
import type { Client } from "discord.js";
import { registerGuildSettingsRoutes } from "../src/modules/guild-management/guild-settings-routes.js";
import type { AdminCapability } from "../src/modules/admin/authorized-user.service.js";

const GUILD_ID = "900000000000000001";
const JN = GuildSystemChannelFlags.SuppressJoinNotifications; // 1
const PREM = GuildSystemChannelFlags.SuppressPremiumSubscriptions; // 2
const REMIND = GuildSystemChannelFlags.SuppressGuildReminderNotifications; // 4
const REPLIES = GuildSystemChannelFlags.SuppressJoinNotificationReplies; // 8

function bitfield(bits: number) {
  return { bitfield: bits, has: (flag: number) => (bits & flag) === flag };
}

/** A guild shape complete enough for serializeGuildSettings to run. */
function serializableGuild(bits: number): Record<string, unknown> {
  return {
    id: GUILD_ID,
    name: "G",
    description: null,
    iconURL: () => null,
    bannerURL: () => null,
    ownerId: "1",
    afkChannelId: null,
    afkTimeout: 60,
    systemChannelId: null,
    systemChannelFlags: bitfield(bits),
    verificationLevel: 0,
    explicitContentFilter: 0,
    defaultMessageNotifications: 0,
    mfaLevel: 0,
    rulesChannelId: null,
    publicUpdatesChannelId: null,
    premiumTier: 0,
    premiumSubscriptionCount: 0,
    premiumProgressBarEnabled: false,
    features: [],
  };
}

function buildBot(currentBits: number): {
  bot: Client;
  editSpy: ReturnType<typeof vi.fn>;
} {
  const editSpy = vi.fn(async (arg: { systemChannelFlags?: number }) =>
    serializableGuild(
      typeof arg.systemChannelFlags === "number"
        ? arg.systemChannelFlags
        : currentBits,
    ),
  );
  const guild = { ...serializableGuild(currentBits), edit: editSpy };
  const cache = new Map<string, unknown>([[GUILD_ID, guild]]);
  return { bot: { guilds: { cache } } as unknown as Client, editSpy };
}

async function buildServer(
  bot: Client,
  caps: AdminCapability[] = ["admin"],
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  fastify.addHook("onRequest", async (request) => {
    request.authUserId = "test-user";
    request.authCapabilities = new Set(caps);
  });
  await registerGuildSettingsRoutes(fastify, { bot });
  await fastify.ready();
  return fastify;
}

let server: FastifyInstance | null = null;
afterEach(async () => {
  if (server) await server.close();
  server = null;
});

async function patchFlags(
  bot: Client,
  flags: Record<string, boolean>,
): Promise<void> {
  server = await buildServer(bot);
  const r = await server.inject({
    method: "PATCH",
    url: `/api/guilds/${GUILD_ID}/settings`,
    payload: { systemChannelFlags: flags },
  });
  expect(r.statusCode).toBe(200);
}

describe("PATCH guild systemChannelFlags merge semantics", () => {
  it("preserves already-set flags when the body toggles only one", async () => {
    const { bot, editSpy } = buildBot(PREM | REMIND);
    await patchFlags(bot, { suppressJoinNotifications: true });
    // Old code overwrote from 0 → just JN, clearing PREM+REMIND.
    expect(editSpy.mock.calls[0][0].systemChannelFlags).toBe(
      PREM | REMIND | JN,
    );
  });

  it("clears a flag set explicitly to false, leaving the rest", async () => {
    const { bot, editSpy } = buildBot(PREM | REMIND);
    await patchFlags(bot, { suppressPremiumSubscriptions: false });
    expect(editSpy.mock.calls[0][0].systemChannelFlags).toBe(REMIND);
  });

  it("a full-state body yields exactly that state (back-compat)", async () => {
    const { bot, editSpy } = buildBot(JN | PREM | REMIND | REPLIES);
    await patchFlags(bot, {
      suppressJoinNotifications: true,
      suppressPremiumSubscriptions: false,
      suppressGuildReminderNotifications: true,
      suppressJoinNotificationReplies: false,
    });
    expect(editSpy.mock.calls[0][0].systemChannelFlags).toBe(JN | REMIND);
  });
});
