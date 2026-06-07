/**
 * Bot → voice-service gateway-event relay filter (PR-2.3d).
 *
 * The crux of the inbound bridge is the relay rules: always relay
 * VOICE_SERVER_UPDATE, relay VOICE_STATE_UPDATE only for the bot's own user,
 * and only for guilds with an active remote connection. fetch is stubbed so we
 * assert exactly which events are forwarded.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Client } from "discord.js";
import { installVoiceGatewayRelay } from "../src/modules/voice/voice-gateway-relay.js";
import {
  activeRemoteGuilds,
  resetActiveRemoteGuildsForTest,
} from "../src/modules/voice/voice-internal-routes.js";

const realFetch = globalThis.fetch;

interface Relayed {
  guildId: string;
  type: string;
  data: unknown;
}

function stubFetch(): Relayed[] {
  const out: Relayed[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    out.push(JSON.parse(String(init.body)) as Relayed);
    return { status: 200, ok: true } as Response;
  }) as typeof fetch;
  return out;
}

function fakeBot(botUserId: string): { client: Client; emitRaw: (p: unknown) => void } {
  const ee = new EventEmitter();
  const client = {
    user: { id: botUserId },
    on: (ev: string, cb: (...a: unknown[]) => void) => ee.on(ev, cb),
  } as unknown as Client;
  return { client, emitRaw: (p: unknown) => ee.emit("raw", p) };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe("voice gateway relay filter", () => {
  beforeEach(() => {
    resetActiveRemoteGuildsForTest();
    process.env.VOICE_SERVICE_URL = "http://voice:4000";
    process.env.VOICE_HMAC_SECRET = "s";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.VOICE_SERVICE_URL;
    delete process.env.VOICE_HMAC_SECRET;
  });

  it("relays VOICE_SERVER_UPDATE for an active guild", async () => {
    const out = stubFetch();
    const { client, emitRaw } = fakeBot("bot-1");
    installVoiceGatewayRelay(client);
    activeRemoteGuilds.add("g1");
    const d = { guild_id: "g1", token: "t", endpoint: "x" };
    emitRaw({ t: "VOICE_SERVER_UPDATE", d });
    await flush();
    expect(out).toEqual([{ guildId: "g1", type: "VOICE_SERVER_UPDATE", data: d }]);
  });

  it("relays VOICE_STATE_UPDATE only for the bot's own user", async () => {
    const out = stubFetch();
    const { client, emitRaw } = fakeBot("bot-1");
    installVoiceGatewayRelay(client);
    activeRemoteGuilds.add("g1");
    // Another member moving channels — must NOT be relayed.
    emitRaw({ t: "VOICE_STATE_UPDATE", d: { guild_id: "g1", user_id: "other" } });
    await flush();
    expect(out).toEqual([]);
    // The bot's own state — relayed.
    const mine = { guild_id: "g1", user_id: "bot-1", session_id: "sess" };
    emitRaw({ t: "VOICE_STATE_UPDATE", d: mine });
    await flush();
    expect(out).toEqual([{ guildId: "g1", type: "VOICE_STATE_UPDATE", data: mine }]);
  });

  it("does not relay events for an inactive guild", async () => {
    const out = stubFetch();
    const { client, emitRaw } = fakeBot("bot-1");
    installVoiceGatewayRelay(client);
    // g2 has no active remote connection.
    emitRaw({ t: "VOICE_SERVER_UPDATE", d: { guild_id: "g2", token: "t" } });
    await flush();
    expect(out).toEqual([]);
  });

  it("ignores unrelated gateway events", async () => {
    const out = stubFetch();
    const { client, emitRaw } = fakeBot("bot-1");
    installVoiceGatewayRelay(client);
    activeRemoteGuilds.add("g1");
    emitRaw({ t: "MESSAGE_CREATE", d: { guild_id: "g1" } });
    await flush();
    expect(out).toEqual([]);
  });

  it("is a no-op when the split is not configured", async () => {
    delete process.env.VOICE_SERVICE_URL;
    const out = stubFetch();
    const { client, emitRaw } = fakeBot("bot-1");
    installVoiceGatewayRelay(client);
    activeRemoteGuilds.add("g1");
    emitRaw({ t: "VOICE_SERVER_UPDATE", d: { guild_id: "g1" } });
    await flush();
    expect(out).toEqual([]);
  });
});
