/**
 * Behavior callback tokens on message triggers (#200), observed from the
 * outside: what a webhook receiver (a real local HTTP server) gets from
 * runWebhookAction, what it can do with its token on /api/plugin/*
 * (Fastify inject), what Discord sees (a fake channel, author and
 * message), and what the delivery log keeps.
 *
 *   - a message trigger's request carries `_meta.callback`
 *   - `{"defer": true}` shows typing where the reply will go, shows
 *     nothing else, and is an ok delivery marked deferred
 *   - respond: the first one sends the reply (channel, or the author's DM
 *     for a private guild reply — never the channel), later ones edit it;
 *     moving between channel and DM sends anew and deletes the old one
 *   - followup sends a new message; edit/delete reach only messages this
 *     token sent with followup (403 for anything else)
 *   - a failed run's token is 401; a waiting call on a revoked token too
 *   - refused / failed calls are deliveries via "message"
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, type Mock } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/utils/host-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/host-policy.js")>()),
  // vouch for the local receiver, which the real policy refuses
  resolveWebhookTarget: vi.fn(async (u: string | URL) => ({
    url: new URL(u),
    addresses: [{ address: "127.0.0.1", family: 4 }],
  })),
}));
vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
  setBotEventLogMetric: vi.fn(),
}));

import { ChannelType, type Message } from "discord.js";
import type { FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { createWebServer } from "../src/modules/web-core/server.js";
import { runWebhookAction } from "../src/modules/command-system/webhook-action.js";
import { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import {
  CALLBACK_TOKEN_TTL_MS,
  behaviorCallbackTokens,
  serializeReply,
} from "../src/modules/command-system/behavior-callback-token.js";
import { findRecentDeliveries } from "../src/modules/behavior/behavior-deliveries.js";
import { BehaviorWebhookAction } from "../src/modules/behavior/models/behavior-webhook-action.model.js";
import type { ReplyVisibility } from "../src/modules/behavior/models/behavior-definition.model.js";
import { encryptSecret } from "../src/utils/crypto.js";
import { clearBehaviors, seedMessageTrigger } from "./behavior-fixtures.js";

// ── the receiver ─────────────────────────────────────────────────────────────

let receiver: Server;
let receiverUrl: string;
let answer: { status: number; body: string } = { status: 200, body: "" };
let received: string[] = [];

beforeAll(async () => {
  await sequelize.sync({ force: true });
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(answer.body);
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
});

afterAll(async () => {
  await new Promise<void>((r) => receiver.close(() => r()));
});

// ── Discord, faked ───────────────────────────────────────────────────────────

interface SentMessage {
  id: string;
  body: unknown;
  edit: Mock;
  delete: Mock;
}

/** A triggering message in a guild channel or in a DM with the bot. */
function fakeMessage(place: "guild" | "dm", createdTimestamp = Date.now()) {
  const sent: SentMessage[] = [];
  const make = (prefix: string) => async (body: unknown) => {
    const m: SentMessage = {
      id: `${prefix}${sent.length + 1}`,
      body,
      edit: vi.fn(async () => m),
      delete: vi.fn(async () => {}),
    };
    sent.push(m);
    return m;
  };
  const dmChannel = { sendTyping: vi.fn(async () => {}) };
  const channel = {
    id: "C1",
    type: place === "guild" ? ChannelType.GuildText : ChannelType.DM,
    send: vi.fn(make("C")),
    sendTyping: vi.fn(async () => {}),
  };
  const author = {
    id: "U1",
    username: "tester",
    globalName: "Tester",
    discriminator: "0",
    avatar: null,
    bot: false,
    displayAvatarURL: () => "https://cdn.example/avatar.png",
    send: vi.fn(make("D")),
    createDM: vi.fn(async () => dmChannel),
  };
  const message = {
    id: "M1",
    content: "!go",
    createdTimestamp,
    guild: place === "guild" ? { preferredLocale: "en-US" } : null,
    guildId: place === "guild" ? "G1" : null,
    channelId: "C1",
    channel,
    author,
  };
  return { message: message as unknown as Message, channel, author, dmChannel, sent };
}

type FakeMessage = ReturnType<typeof fakeMessage>;

async function seedTrigger(overrides: Record<string, unknown> = {}): Promise<number> {
  return seedMessageTrigger(overrides, { url: encryptSecret(receiverUrl) });
}

/** Run the behavior's webhook action on `fake`, as the matcher does. */
async function fire(behaviorId: number, fake: FakeMessage, visibility: ReplyVisibility | null = null) {
  const webhook = (await BehaviorWebhookAction.findByPk(behaviorId))!.get({ plain: true });
  await runWebhookAction({
    forwarder: new WebhookForwarder(),
    behaviorId,
    webhook: webhook as never,
    payload: { content: "!go", _meta: { behavior_id: behaviorId } },
    target: { kind: "message", message: fake.message },
    visibility,
  });
}

/** A message-trigger run's callback token, without a webhook. */
function issuedFor(behaviorId: number, fake: FakeMessage, visibility: ReplyVisibility | null = null) {
  return behaviorCallbackTokens.issue({
    behaviorId,
    target: { kind: "message", message: fake.message },
    visibility,
  });
}

const tokenOf = (body: string) =>
  (JSON.parse(body) as { _meta: { callback: { token: string } } })._meta.callback.token;

const fakeBot = {
  user: { id: "bot-1" },
  application: { id: "app-1" },
  isReady: () => true,
  uptime: 0,
  guilds: { cache: new Map(), fetch: vi.fn() },
  channels: { fetch: vi.fn(), cache: { get: vi.fn() } },
  rest: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
};

let server: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  behaviorCallbackTokens.clear();
  await clearBehaviors();
  answer = { status: 200, body: "" };
  received = [];
  server = await createWebServer({ staticRoot: undefined, bot: fakeBot as never });
  await server.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
});

function call(path: string, token: string, payload: Record<string, unknown> = {}) {
  return server.inject({
    method: "POST",
    url: `/api/plugin/${path}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

const NO_PINGS = { allowedMentions: { parse: [] } };

// ── the request, and defer ───────────────────────────────────────────────────

describe("a message trigger's webhook request", () => {
  it("carries the run's callback token, ending 15 minutes after the message", async () => {
    const id = await seedTrigger();
    const createdAt = Date.now() - 60_000;
    await fire(id, fakeMessage("dm", createdAt));
    const meta = (JSON.parse(received[0]!) as { _meta: Record<string, unknown> })._meta;
    const callback = meta.callback as { token: string; expires_at: string; api_base: string };
    expect(callback.token.length).toBeGreaterThanOrEqual(40);
    expect(Date.parse(callback.expires_at)).toBe(createdAt + CALLBACK_TOKEN_TTL_MS);
    expect(callback.api_base).toMatch(/^https?:\/\/[^/]+$/);
  });
});

describe('{"defer": true} on a message trigger', () => {
  it("shows typing in the channel, nothing else — content beside it included — and is deferred", async () => {
    const id = await seedTrigger();
    answer = { status: 200, body: JSON.stringify({ defer: true, content: "not shown" }) };
    const fake = fakeMessage("guild");

    await fire(id, fake);

    expect(fake.channel.sendTyping).toHaveBeenCalledTimes(1);
    expect(fake.channel.send).not.toHaveBeenCalled();
    expect(fake.author.send).not.toHaveBeenCalled();
    expect((await findRecentDeliveries(id))[0]).toMatchObject({ via: "message", ok: true, deferred: true });
  });

  it("types in the author's DM when a guild reply will be private", async () => {
    const id = await seedTrigger();
    answer = { status: 200, body: JSON.stringify({ defer: true }) };
    const fake = fakeMessage("guild");
    await fire(id, fake, "private");
    expect(fake.dmChannel.sendTyping).toHaveBeenCalledTimes(1);
    expect(fake.channel.sendTyping).not.toHaveBeenCalled();
  });

  it("a typing failure does not fail the delivery", async () => {
    const id = await seedTrigger();
    answer = { status: 200, body: JSON.stringify({ defer: true }) };
    const fake = fakeMessage("dm");
    fake.channel.sendTyping.mockRejectedValueOnce(new Error("Missing Access"));
    await fire(id, fake);
    expect((await findRecentDeliveries(id))[0]).toMatchObject({ ok: true, deferred: true });
  });

  it("then respond sends the reply, and the next respond edits it", async () => {
    const id = await seedTrigger();
    answer = { status: 200, body: JSON.stringify({ defer: true }) };
    const fake = fakeMessage("dm");
    await fire(id, fake);
    const token = tokenOf(received[0]!);

    expect((await call("interactions.respond", token, { content: "thinking done" })).statusCode).toBe(200);
    expect(fake.channel.send).toHaveBeenCalledWith({ content: "thinking done", ...NO_PINGS });

    expect((await call("interactions.respond", token, { content: "final" })).statusCode).toBe(200);
    expect(fake.channel.send).toHaveBeenCalledTimes(1);
    expect(fake.sent[0]!.edit).toHaveBeenCalledWith({ content: "final", ...NO_PINGS });
    expect(await findRecentDeliveries(id)).toHaveLength(1);
  });
});

// ── respond ──────────────────────────────────────────────────────────────────

describe("respond on a message trigger", () => {
  it("after a synchronous answer, edits the message that answer sent", async () => {
    const id = await seedTrigger();
    answer = { status: 200, body: JSON.stringify({ content: "working…" }) };
    const fake = fakeMessage("guild");
    await fire(id, fake);
    expect(fake.channel.send).toHaveBeenCalledTimes(1);

    await call("interactions.respond", tokenOf(received[0]!), { content: "done" });

    expect(fake.channel.send).toHaveBeenCalledTimes(1);
    expect(fake.sent[0]!.edit).toHaveBeenCalledWith({ content: "done", ...NO_PINGS });
  });

  it("in a guild: the channel by default; ephemeral moves it to the author's DM, deleting the channel one", async () => {
    const id = await seedTrigger();
    const fake = fakeMessage("guild");
    const { token } = issuedFor(id, fake);

    await call("interactions.respond", token, { content: "everyone" });
    expect(fake.channel.send).toHaveBeenCalledWith({ content: "everyone", ...NO_PINGS });

    await call("interactions.respond", token, { content: "just you", ephemeral: true });
    expect(fake.author.send).toHaveBeenCalledWith({ content: "just you", ...NO_PINGS });
    expect(fake.sent[0]!.delete).toHaveBeenCalledTimes(1);

    // no say on who sees it: it stays in the DM
    await call("interactions.respond", token, { content: "just you, updated" });
    expect(fake.sent[1]!.edit).toHaveBeenCalledWith({ content: "just you, updated", ...NO_PINGS });
    expect(fake.channel.send).toHaveBeenCalledTimes(1);
  });

  it("a guild trigger stored private answers in the author's DM, never the channel — also when the DM fails", async () => {
    const id = await seedTrigger();
    const fake = fakeMessage("guild");
    const { token } = issuedFor(id, fake, "private");

    await call("interactions.respond", token, { content: "only you" });
    expect(fake.author.send).toHaveBeenCalledWith({ content: "only you", ...NO_PINGS });

    const second = fakeMessage("guild");
    second.author.send.mockRejectedValueOnce(new Error("Cannot send messages to this user"));
    const { token: other } = issuedFor(id, second, "private");
    const res = await call("interactions.respond", other, { content: "only you" });
    expect(res.statusCode).toBe(400);
    expect(second.channel.send).not.toHaveBeenCalled();
    expect((await findRecentDeliveries(id))[0]).toMatchObject({
      via: "message",
      ok: false,
      errorCode: "callback_failed",
    });
  });

  it("in a DM with the bot, ephemeral changes nothing: it stays in the DM and is edited", async () => {
    const id = await seedTrigger();
    const fake = fakeMessage("dm");
    const { token } = issuedFor(id, fake);
    await call("interactions.respond", token, { content: "a" });
    await call("interactions.respond", token, { content: "b", ephemeral: true });
    expect(fake.channel.send).toHaveBeenCalledTimes(1);
    expect(fake.author.send).not.toHaveBeenCalled();
    expect(fake.sent[0]!.edit).toHaveBeenCalledWith({ content: "b", ...NO_PINGS });
  });
});

// ── follow-ups ───────────────────────────────────────────────────────────────

describe("follow-ups on a message trigger", () => {
  it("followup sends a new message; edit and delete reach it by id", async () => {
    const id = await seedTrigger();
    const fake = fakeMessage("guild");
    const { token } = issuedFor(id, fake);

    const res = await call("interactions.followup", token, { content: "step 1" });
    expect(res.json()).toEqual({ ok: true, id: "C1" });
    expect(fake.channel.send).toHaveBeenCalledWith({ content: "step 1", ...NO_PINGS });

    expect((await call("interactions.edit_followup", token, { message_id: "C1", content: "step 2" })).statusCode).toBe(200);
    expect(fake.sent[0]!.edit).toHaveBeenCalledWith({ content: "step 2", ...NO_PINGS });

    expect((await call("interactions.delete_followup", token, { message_id: "C1" })).statusCode).toBe(200);
    expect(fake.sent[0]!.delete).toHaveBeenCalledTimes(1);
    expect((await call("interactions.delete_followup", token, { message_id: "C1" })).statusCode).toBe(403);
  });

  it("a private follow-up in a guild goes to the author's DM", async () => {
    const id = await seedTrigger();
    const fake = fakeMessage("guild");
    const { token } = issuedFor(id, fake);
    await call("interactions.followup", token, { content: "psst", ephemeral: true });
    expect(fake.author.send).toHaveBeenCalledWith({ content: "psst", ...NO_PINGS });
    expect(fake.channel.send).not.toHaveBeenCalled();
  });

  it("edit and delete refuse anything this token did not send with followup", async () => {
    const id = await seedTrigger();
    const fake = fakeMessage("guild");
    const { token } = issuedFor(id, fake);
    await call("interactions.respond", token, { content: "the reply" }); // C1
    const other = fakeMessage("guild");
    const { token: otherToken } = issuedFor(id, other);
    await call("interactions.followup", otherToken, { content: "theirs" }); // C1 of the other run

    // the reply itself, the user's own message, an unknown id, another run's follow-up
    for (const messageId of ["C1", "M1", "C9", "@original"]) {
      const edit = await call("interactions.edit_followup", token, { message_id: messageId, content: "x" });
      const del = await call("interactions.delete_followup", token, { message_id: messageId });
      expect(edit.statusCode, messageId).toBe(403);
      expect(del.statusCode, messageId).toBe(403);
    }
    expect(fake.sent[0]!.edit).not.toHaveBeenCalled();
    expect(fake.sent[0]!.delete).not.toHaveBeenCalled();
    expect(other.sent[0]!.edit).not.toHaveBeenCalled();
    expect(other.sent[0]!.delete).not.toHaveBeenCalled();
    expect((await findRecentDeliveries(id))[0]).toMatchObject({ via: "message", errorCode: "callback_invalid" });
  });
});

// ── what the token may reach, and when ───────────────────────────────────────

describe("a message trigger's callback principal", () => {
  it("is refused every other /api/plugin/* path with 403", async () => {
    const id = await seedTrigger();
    const { token } = issuedFor(id, fakeMessage("guild"));
    for (const path of ["messages.send", "interactions.send_modal", "me", "no-such-route"]) {
      expect((await call(path, token, { channel_id: "C1", content: "x" })).statusCode, path).toBe(403);
    }
  });

  it("a failed run tells the author privately and its token is 401", async () => {
    const id = await seedTrigger();
    answer = { status: 500, body: "boom" };
    const fake = fakeMessage("guild");
    await fire(id, fake);
    expect(fake.author.send).toHaveBeenCalledTimes(1);
    expect(fake.channel.send).not.toHaveBeenCalled();
    expect((await call("interactions.respond", tokenOf(received[0]!), { content: "late" })).statusCode).toBe(401);
  });

  it("a call waiting when the token is revoked is 401 and sends nothing", async () => {
    const id = await seedTrigger();
    const fake = fakeMessage("guild");
    const { token, principal } = issuedFor(id, fake);
    let release!: () => void;
    const held = serializeReply(principal, () => new Promise<void>((r) => (release = r)));
    const respond = call("interactions.respond", token, { content: "late" });
    await new Promise((r) => setTimeout(r, 50));
    behaviorCallbackTokens.revoke(token);
    release();
    await held;
    expect((await respond).statusCode).toBe(401);
    expect(fake.channel.send).not.toHaveBeenCalled();
  });

  it("a token is 401 once 15 minutes have passed since the message", async () => {
    const id = await seedTrigger();
    const createdAt = Date.now() - 10 * 60 * 1000;
    const fake = fakeMessage("dm", createdAt);
    const { token } = issuedFor(id, fake);
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(createdAt + CALLBACK_TOKEN_TTL_MS + 1000);
    expect((await call("interactions.respond", token, { content: "late" })).statusCode).toBe(401);
    expect(fake.channel.send).not.toHaveBeenCalled();
  });
});
