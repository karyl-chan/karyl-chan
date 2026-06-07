/**
 * Gateway bridge routing tests (PR-2.3b).
 *
 * These verify the bridge contract that makes the voice split correct — with
 * fakes, no Discord, no network:
 *  - sendPayload from @discordjs/voice routes to the injected transport,
 *    tagged with the right guildId, and returns the transport's boolean.
 *  - an inbound VOICE_STATE_UPDATE / VOICE_SERVER_UPDATE reaches the right
 *    guild's onVoiceStateUpdate / onVoiceServerUpdate.
 *  - destroy() cleans up the map AND notifies the bot (onDestroy), and a
 *    swallowed onDestroy error doesn't escape.
 *  - an event for an unknown / already-destroyed guild is a safe no-op.
 *  - events are isolated per guild.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { GatewayBridge, type GatewayBridgeTransport } from "../src/gateway-bridge.js";

interface SendCall {
  guildId: string;
  payload: unknown;
}

function makeTransport(sendReturn = true): {
  transport: GatewayBridgeTransport;
  sends: SendCall[];
  destroys: string[];
  destroyError?: Error;
  throwOnDestroy: (err: Error) => void;
} {
  const sends: SendCall[] = [];
  const destroys: string[] = [];
  let toThrow: Error | undefined;
  const transport: GatewayBridgeTransport = {
    sendPayload(guildId, payload) {
      sends.push({ guildId, payload });
      return sendReturn;
    },
    onDestroy(guildId) {
      destroys.push(guildId);
      if (toThrow) throw toThrow;
    },
  };
  return {
    transport,
    sends,
    destroys,
    throwOnDestroy: (err: Error) => {
      toThrow = err;
    },
  };
}

/** Minimal fake of @discordjs/voice's library methods + a call recorder. */
function makeLibRecorder() {
  const calls: { method: string; data: unknown }[] = [];
  const lib = {
    destroy() {
      calls.push({ method: "destroy", data: undefined });
    },
    onVoiceServerUpdate(data: unknown) {
      calls.push({ method: "onVoiceServerUpdate", data });
    },
    onVoiceStateUpdate(data: unknown) {
      calls.push({ method: "onVoiceStateUpdate", data });
    },
  };
  return { lib, calls };
}

describe("GatewayBridge", () => {
  it("sendPayload routes to the transport with the guildId and returns its boolean", () => {
    const { transport, sends } = makeTransport(true);
    const bridge = new GatewayBridge(transport);
    const { lib } = makeLibRecorder();

    const impl = bridge.adapterCreatorFor("guild-1")(lib as never);
    const payload = { op: 4, d: { guild_id: "guild-1", channel_id: "c1" } };
    const ok = impl.sendPayload(payload);

    assert.equal(ok, true);
    assert.deepEqual(sends, [{ guildId: "guild-1", payload }]);
  });

  it("propagates a transport sendPayload=false (so @discordjs/voice disconnects)", () => {
    const { transport } = makeTransport(false);
    const bridge = new GatewayBridge(transport);
    const { lib } = makeLibRecorder();
    const impl = bridge.adapterCreatorFor("g")(lib as never);
    assert.equal(impl.sendPayload({ op: 4 }), false);
  });

  it("routes an inbound VOICE_STATE_UPDATE to the guild's onVoiceStateUpdate", () => {
    const { transport } = makeTransport();
    const bridge = new GatewayBridge(transport);
    const { lib, calls } = makeLibRecorder();
    bridge.adapterCreatorFor("guild-1")(lib as never);

    const data = { guild_id: "guild-1", user_id: "bot", session_id: "sess" };
    const routed = bridge.dispatchGatewayEvent("guild-1", "VOICE_STATE_UPDATE", data);

    assert.equal(routed, true);
    assert.deepEqual(calls, [{ method: "onVoiceStateUpdate", data }]);
  });

  it("routes an inbound VOICE_SERVER_UPDATE to the guild's onVoiceServerUpdate", () => {
    const { transport } = makeTransport();
    const bridge = new GatewayBridge(transport);
    const { lib, calls } = makeLibRecorder();
    bridge.adapterCreatorFor("guild-1")(lib as never);

    const data = { guild_id: "guild-1", token: "tok", endpoint: "x.discord.gg" };
    const routed = bridge.dispatchGatewayEvent("guild-1", "VOICE_SERVER_UPDATE", data);

    assert.equal(routed, true);
    assert.deepEqual(calls, [{ method: "onVoiceServerUpdate", data }]);
  });

  it("isolates events per guild", () => {
    const { transport } = makeTransport();
    const bridge = new GatewayBridge(transport);
    const a = makeLibRecorder();
    const b = makeLibRecorder();
    bridge.adapterCreatorFor("A")(a.lib as never);
    bridge.adapterCreatorFor("B")(b.lib as never);

    bridge.dispatchGatewayEvent("A", "VOICE_SERVER_UPDATE", { for: "A" });

    assert.deepEqual(a.calls, [{ method: "onVoiceServerUpdate", data: { for: "A" } }]);
    assert.deepEqual(b.calls, []);
  });

  it("destroy() cleans up the map and notifies the bot via onDestroy", () => {
    const { transport, destroys } = makeTransport();
    const bridge = new GatewayBridge(transport);
    const { lib } = makeLibRecorder();
    const impl = bridge.adapterCreatorFor("guild-1")(lib as never);

    assert.equal(bridge.has("guild-1"), true);
    impl.destroy();

    assert.equal(bridge.has("guild-1"), false);
    assert.deepEqual(destroys, ["guild-1"]);
    // After destroy, an inbound event for that guild is a no-op.
    assert.equal(
      bridge.dispatchGatewayEvent("guild-1", "VOICE_STATE_UPDATE", {}),
      false,
    );
  });

  it("destroy() swallows an onDestroy transport error", () => {
    const { transport, throwOnDestroy } = makeTransport();
    throwOnDestroy(new Error("bot unreachable"));
    const bridge = new GatewayBridge(transport);
    const { lib } = makeLibRecorder();
    const impl = bridge.adapterCreatorFor("guild-1")(lib as never);

    // Must not throw even though onDestroy throws — and must still clean up.
    assert.doesNotThrow(() => impl.destroy());
    assert.equal(bridge.has("guild-1"), false);
  });

  it("dispatchGatewayEvent for an unknown guild is a safe no-op", () => {
    const { transport } = makeTransport();
    const bridge = new GatewayBridge(transport);
    assert.equal(
      bridge.dispatchGatewayEvent("never-joined", "VOICE_SERVER_UPDATE", {}),
      false,
    );
  });

  it("destroyGuild() drives the library destroy() which triggers cleanup + onDestroy", () => {
    const { transport, destroys } = makeTransport();
    const bridge = new GatewayBridge(transport);
    const { lib, calls } = makeLibRecorder();
    // Wire the implementer destroy() to the library destroy() the way
    // @discordjs/voice does: the connection's destroy calls lib.destroy()
    // which the real lib forwards to the adapter's implementer destroy.
    const impl = bridge.adapterCreatorFor("guild-1")({
      ...lib,
      destroy: () => {
        calls.push({ method: "destroy", data: undefined });
        impl.destroy();
      },
    } as never);

    bridge.destroyGuild("guild-1");

    assert.deepEqual(calls, [{ method: "destroy", data: undefined }]);
    assert.equal(bridge.has("guild-1"), false);
    assert.deepEqual(destroys, ["guild-1"]);
  });

  it("destroyGuild() for an unknown guild is a no-op", () => {
    const { transport, destroys } = makeTransport();
    const bridge = new GatewayBridge(transport);
    assert.doesNotThrow(() => bridge.destroyGuild("nope"));
    assert.deepEqual(destroys, []);
  });

  it("guildIds() reflects live adapters", () => {
    const { transport } = makeTransport();
    const bridge = new GatewayBridge(transport);
    const a = makeLibRecorder();
    bridge.adapterCreatorFor("A")(a.lib as never);
    bridge.adapterCreatorFor("B")(makeLibRecorder().lib as never);
    assert.deepEqual(new Set(bridge.guildIds()), new Set(["A", "B"]));
  });
});
