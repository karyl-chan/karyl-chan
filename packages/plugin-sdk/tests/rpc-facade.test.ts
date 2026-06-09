/**
 * Typed RPC facade: unit test the wire-path + body translation for
 * each typed method. We don't need a live HTTP server —
 * the namespace factories take a `RpcCaller` directly, so a stub
 * captures (path, body) for assertion.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPluginRpc } from "../src/rpc/index.js";

interface Captured {
  path: string;
  body: unknown;
}

function makeStub(response: unknown = {}): {
  call: (path: string, body?: unknown) => Promise<unknown>;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  return {
    call: async (path, body) => {
      calls.push({ path, body });
      return response;
    },
    calls,
  };
}

describe("ctx.discord.messages", () => {
  it("send: maps camelCase args to wire snake_case", async () => {
    const stub = makeStub({ id: "123", channel_id: "456" });
    const rpc = createPluginRpc(stub.call);
    const res = await rpc.discord.messages.send({
      channelId: "456",
      content: "hi",
      allowedMentions: { users: ["7"] },
    });
    assert.deepEqual(stub.calls[0], {
      path: "/api/plugin/messages.send",
      body: {
        channel_id: "456",
        content: "hi",
        allowed_mentions: { users: ["7"] },
      },
    });
    assert.deepEqual(res, { id: "123", channel_id: "456" });
  });

  it("edit: includes message_id", async () => {
    const stub = makeStub({ id: "m", channel_id: "c" });
    const rpc = createPluginRpc(stub.call);
    await rpc.discord.messages.edit({
      channelId: "c",
      messageId: "m",
      content: "new",
    });
    assert.equal(stub.calls[0].path, "/api/plugin/messages.edit");
    assert.deepEqual(stub.calls[0].body, {
      channel_id: "c",
      message_id: "m",
      content: "new",
    });
  });

  it("delete: minimal body", async () => {
    const stub = makeStub();
    const rpc = createPluginRpc(stub.call);
    await rpc.discord.messages.delete({ channelId: "c", messageId: "m" });
    assert.equal(stub.calls[0].path, "/api/plugin/messages.delete");
    assert.deepEqual(stub.calls[0].body, { channel_id: "c", message_id: "m" });
  });

  it("addReaction: forwards emoji verbatim", async () => {
    const stub = makeStub();
    const rpc = createPluginRpc(stub.call);
    await rpc.discord.messages.addReaction({
      channelId: "c",
      messageId: "m",
      emoji: "👌",
    });
    assert.equal(stub.calls[0].path, "/api/plugin/messages.add_reaction");
    assert.deepEqual(stub.calls[0].body, {
      channel_id: "c",
      message_id: "m",
      emoji: "👌",
    });
  });

  it("omits undefined optional fields from wire body", async () => {
    const stub = makeStub({ id: "i", channel_id: "c" });
    const rpc = createPluginRpc(stub.call);
    await rpc.discord.messages.send({ channelId: "c", content: "x" });
    const body = stub.calls[0].body as Record<string, unknown>;
    assert.equal("embeds" in body, false);
    assert.equal("components" in body, false);
    assert.equal("attachments" in body, false);
    assert.equal("allowed_mentions" in body, false);
  });
});

describe("ctx.discord.interactions", () => {
  it("respond: maps interactionToken + ephemeral", async () => {
    const stub = makeStub();
    const rpc = createPluginRpc(stub.call);
    await rpc.discord.interactions.respond({
      interactionToken: "tok",
      content: "ok",
      ephemeral: true,
    });
    assert.equal(stub.calls[0].path, "/api/plugin/interactions.respond");
    assert.deepEqual(stub.calls[0].body, {
      interaction_token: "tok",
      content: "ok",
      ephemeral: true,
    });
  });

  it("followup: returns a MessageHandle", async () => {
    const stub = makeStub({ id: "M", channel_id: "C" });
    const rpc = createPluginRpc(stub.call);
    const handle = await rpc.discord.interactions.followup({
      interactionToken: "tok",
      content: "hi",
    });
    assert.deepEqual(handle, { id: "M", channel_id: "C" });
  });
});

describe("ctx.voice", () => {
  it("join: forwards guildId / userId; only specified fields land on wire", async () => {
    const stub = makeStub({});
    const rpc = createPluginRpc(stub.call);
    await rpc.voice.join({ guildId: "g", userId: "u" });
    assert.equal(stub.calls[0].path, "/api/plugin/voice.join");
    const body = stub.calls[0].body as Record<string, unknown>;
    assert.deepEqual(body, { guild_id: "g", user_id: "u" });
  });

  it("play: forwards guildId + url", async () => {
    const stub = makeStub({});
    const rpc = createPluginRpc(stub.call);
    await rpc.voice.play({ guildId: "g", url: "https://x/a.mp3" });
    assert.equal(stub.calls[0].path, "/api/plugin/voice.play");
    assert.deepEqual(stub.calls[0].body, {
      guild_id: "g",
      url: "https://x/a.mp3",
    });
  });

  it("pause: omits `paused` when undefined (toggle)", async () => {
    const stub = makeStub({ paused: true });
    const rpc = createPluginRpc(stub.call);
    await rpc.voice.pause({ guildId: "g" });
    const body = stub.calls[0].body as Record<string, unknown>;
    assert.deepEqual(body, { guild_id: "g" });
    assert.equal("paused" in body, false);
  });

  it("status: minimal body shape", async () => {
    const stub = makeStub({
      connected: true,
      channelId: "vc",
      playing: true,
      paused: false,
      playingUrl: "https://x/a.mp3",
      connectionStatus: "Ready",
      playerStatus: "Playing",
    });
    const rpc = createPluginRpc(stub.call);
    const status = await rpc.voice.status("g");
    assert.equal(stub.calls[0].path, "/api/plugin/voice.status");
    assert.deepEqual(stub.calls[0].body, { guild_id: "g" });
    assert.equal(status.playing, true);
    assert.equal(status.playingUrl, "https://x/a.mp3");
  });

  it("leave / stop: just guild id on the wire", async () => {
    const stub = makeStub({});
    const rpc = createPluginRpc(stub.call);
    await rpc.voice.leave("g");
    await rpc.voice.stop("g");
    assert.equal(stub.calls[0].path, "/api/plugin/voice.leave");
    assert.deepEqual(stub.calls[0].body, { guild_id: "g" });
    assert.equal(stub.calls[1].path, "/api/plugin/voice.stop");
    assert.deepEqual(stub.calls[1].body, { guild_id: "g" });
  });
});

describe("ctx.discord.members", () => {
  it("get: sends a one-element user_ids batch and unwraps members[0]", async () => {
    const member = { userId: "u1", displayName: "Alice", avatarUrl: null };
    const stub = makeStub({ members: [member] });
    const rpc = createPluginRpc(stub.call);
    const res = await rpc.discord.members.get({ guildId: "g1", userId: "u1" });
    // The bot reads `user_ids` (array); the old facade sent `user_id`
    // (singular) → every call 400'd "user_ids must be an array".
    assert.deepEqual(stub.calls[0], {
      path: "/api/plugin/members.get",
      body: { guild_id: "g1", user_ids: ["u1"] },
    });
    // The bot returns { members: [...] }; the facade must unwrap, not cast
    // the wrapper object as a single MemberSummary.
    assert.deepEqual(res, member);
  });

  it("get: returns null when the user isn't in the guild", async () => {
    const stub = makeStub({ members: [] });
    const rpc = createPluginRpc(stub.call);
    const res = await rpc.discord.members.get({ guildId: "g1", userId: "u1" });
    assert.equal(res, null);
  });
});
