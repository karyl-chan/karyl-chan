/**
 * Voice service HTTP API tests (PR-2.3c).
 *
 * Real VoiceConnection / ffmpeg can't run without Discord, so these cover the
 * parts that ARE testable without it: HMAC gating (reject unsigned / bad-sig /
 * stale, accept valid), input validation, the gateway-event → bridge routing,
 * and that the bridge's sendPayload transport reaches the (faked) bot client.
 * join/play aren't exercised here (they'd spawn a real connection); the
 * manager's join cap is covered indirectly by its sentinel type.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@karyl-chan/plugin-sdk";
import { buildServer } from "../src/server.js";
import { GatewayBridge } from "../src/gateway-bridge.js";
import type { BotClient } from "../src/bot-client.js";

const SECRET = "test-secret";

function signedHeaders(path: string, body: string) {
  const ts = Math.floor(Date.now() / 1000).toString();
  return {
    "content-type": "application/json",
    [TIMESTAMP_HEADER]: ts,
    [SIGNATURE_HEADER]: sign(SECRET, "POST", path, ts, body),
  };
}

function makeBotClient(): { client: BotClient; calls: { path: string; body: unknown }[] } {
  const calls: { path: string; body: unknown }[] = [];
  return {
    calls,
    client: {
      async post(path, body) {
        calls.push({ path, body });
        return 200;
      },
    },
  };
}

describe("voice server HMAC gate", () => {
  it("rejects an unsigned /internal/voice/ request with 401", async () => {
    const { server } = buildServer({ hmacSecret: SECRET, botInternalUrl: "http://bot" });
    const res = await server.inject({
      method: "POST",
      url: "/internal/voice/status",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ guildId: "g1" }),
    });
    assert.equal(res.statusCode, 401);
  });

  it("rejects a wrong-signature request with 401", async () => {
    const { server } = buildServer({ hmacSecret: SECRET, botInternalUrl: "http://bot" });
    const body = JSON.stringify({ guildId: "g1" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await server.inject({
      method: "POST",
      url: "/internal/voice/status",
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: ts,
        [SIGNATURE_HEADER]: "deadbeef",
      },
      payload: body,
    });
    assert.equal(res.statusCode, 401);
  });

  it("rejects a stale timestamp with 401", async () => {
    const { server } = buildServer({ hmacSecret: SECRET, botInternalUrl: "http://bot" });
    const path = "/internal/voice/status";
    const body = JSON.stringify({ guildId: "g1" });
    const ts = (Math.floor(Date.now() / 1000) - 100_000).toString();
    const res = await server.inject({
      method: "POST",
      url: path,
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: ts,
        [SIGNATURE_HEADER]: sign(SECRET, "POST", path, ts, body),
      },
      payload: body,
    });
    assert.equal(res.statusCode, 401);
  });

  it("accepts a valid signature on /status and returns a not-connected status", async () => {
    const { server } = buildServer({ hmacSecret: SECRET, botInternalUrl: "http://bot" });
    const path = "/internal/voice/status";
    const body = JSON.stringify({ guildId: "g-never-joined" });
    const res = await server.inject({
      method: "POST",
      url: path,
      headers: signedHeaders(path, body),
      payload: body,
    });
    assert.equal(res.statusCode, 200);
    const json = res.json();
    assert.equal(json.connected, false);
    assert.equal(json.channelId, null);
  });

  it("400s a valid-signature request missing guildId", async () => {
    const { server } = buildServer({ hmacSecret: SECRET, botInternalUrl: "http://bot" });
    const path = "/internal/voice/status";
    const body = JSON.stringify({});
    const res = await server.inject({
      method: "POST",
      url: path,
      headers: signedHeaders(path, body),
      payload: body,
    });
    assert.equal(res.statusCode, 400);
  });
});

describe("voice server /health", () => {
  it("is unauthenticated and returns ok", async () => {
    const { server } = buildServer({ hmacSecret: SECRET, botInternalUrl: "http://bot" });
    const res = await server.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok" });
  });
});

describe("voice server gateway-event routing", () => {
  it("routes a signed VOICE_SERVER_UPDATE to a live adapter on the bridge", async () => {
    const bridge = new GatewayBridge({ sendPayload: () => true, onDestroy: () => {} });
    const { server } = buildServer({
      hmacSecret: SECRET,
      botInternalUrl: "http://bot",
      bridge,
    });
    // Register a live adapter for the guild and capture inbound events.
    const received: unknown[] = [];
    bridge.adapterCreatorFor("g1")({
      destroy() {},
      onVoiceStateUpdate() {},
      onVoiceServerUpdate(data: unknown) {
        received.push(data);
      },
    } as never);

    const path = "/internal/voice/gateway-event";
    const data = { guild_id: "g1", token: "t", endpoint: "x.discord.gg" };
    const body = JSON.stringify({ guildId: "g1", type: "VOICE_SERVER_UPDATE", data });
    const res = await server.inject({
      method: "POST",
      url: path,
      headers: signedHeaders(path, body),
      payload: body,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { routed: true });
    assert.deepEqual(received, [data]);
  });

  it("returns routed:false for an unknown guild (benign race)", async () => {
    const { server } = buildServer({ hmacSecret: SECRET, botInternalUrl: "http://bot" });
    const path = "/internal/voice/gateway-event";
    const body = JSON.stringify({
      guildId: "ghost",
      type: "VOICE_STATE_UPDATE",
      data: {},
    });
    const res = await server.inject({
      method: "POST",
      url: path,
      headers: signedHeaders(path, body),
      payload: body,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { routed: false });
  });

  it("400s an unknown event type", async () => {
    const { server } = buildServer({ hmacSecret: SECRET, botInternalUrl: "http://bot" });
    const path = "/internal/voice/gateway-event";
    const body = JSON.stringify({ guildId: "g1", type: "MESSAGE_CREATE", data: {} });
    const res = await server.inject({
      method: "POST",
      url: path,
      headers: signedHeaders(path, body),
      payload: body,
    });
    assert.equal(res.statusCode, 400);
  });
});

describe("voice server bridge transport (default wiring)", () => {
  it("sendPayload tunnels to the injected bot client at /internal/voice/gateway-send", async () => {
    const { client, calls } = makeBotClient();
    const { bridge } = buildServer({
      hmacSecret: SECRET,
      botInternalUrl: "http://bot",
      botClient: client,
    });
    const impl = bridge.adapterCreatorFor("g1")({
      destroy() {},
      onVoiceStateUpdate() {},
      onVoiceServerUpdate() {},
    } as never);
    const payload = { op: 4, d: { guild_id: "g1" } };
    assert.equal(impl.sendPayload(payload), true);
    // Allow the fire-and-forget POST microtask to settle.
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [
      { path: "/internal/voice/gateway-send", body: { guildId: "g1", payload } },
    ]);
  });

  it("onDestroy notifies the bot at /internal/voice/gateway-destroy", async () => {
    const { client, calls } = makeBotClient();
    const { bridge } = buildServer({
      hmacSecret: SECRET,
      botInternalUrl: "http://bot",
      botClient: client,
    });
    const impl = bridge.adapterCreatorFor("g1")({
      destroy() {},
      onVoiceStateUpdate() {},
      onVoiceServerUpdate() {},
    } as never);
    impl.destroy();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [
      { path: "/internal/voice/gateway-destroy", body: { guildId: "g1" } },
    ]);
  });
});
