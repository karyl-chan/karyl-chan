/**
 * A reply's direct messages (#157), end to end from the outside: a real
 * local HTTP receiver answers the webhook POST (and serves files); the bot
 * side is runWebhookAction and /api/plugin/* (Fastify inject) for the
 * callback token; Discord — the client's users, guilds and members — is
 * faked.
 *
 *   - with a DM allowlist: its users and its groups' members, nobody else
 *   - without one: members of the triggering guild; for a DM trigger, of
 *     any guild the bot is in, asked guild by guild until one has them
 *   - 10 a minute per behavior; past it `rate_limited`
 *   - a DM Discord refuses, or whose attachments can't be had, is that
 *     DM's outcome only: the reply and the delivery are untouched
 *   - every DM leaves a behavior_dm_log row; behavior_deliveries keeps no
 *     user id
 *   - DMs go only once the reply was shown: not for a deferred answer
 *   - callback respond / followup send them too and answer the outcomes;
 *     edit_followup refuses them
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

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
import { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { runWebhookAction } from "../src/modules/command-system/webhook-action.js";
import { behaviorCallbackTokens } from "../src/modules/command-system/behavior-callback-token.js";
import {
  BEHAVIOR_DMS_PER_MINUTE,
  __resetBehaviorDmRateLimitForTests,
} from "../src/modules/command-system/behavior-direct-messages.js";
import { findRecentDeliveries } from "../src/modules/behavior/behavior-deliveries.js";
import { findRecentDmLog } from "../src/modules/behavior/behavior-dm-log.js";
import { BehaviorDelivery } from "../src/modules/behavior/models/behavior-delivery.model.js";
import { BehaviorWebhookAction } from "../src/modules/behavior/models/behavior-webhook-action.model.js";
import { replaceDmAllowlist } from "../src/modules/behavior/models/behavior-dm-allowlist.model.js";
import { replaceGroupMembers } from "../src/modules/behavior/models/behavior-group-member.model.js";
import { encryptSecret } from "../src/utils/crypto.js";
import { clearBehaviors, seedMessageTrigger } from "./behavior-fixtures.js";

const TRIGGERER = "100000000000000001";
const MEMBER = "200000000000000002";
const ELSEWHERE = "300000000000000003";
const STRANGER = "400000000000000004";
const CLOSED = "500000000000000005";

// ── the receiver ─────────────────────────────────────────────────────────────

let receiver: Server;
let receiverUrl: string;
let answer = "";
let posts: string[] = [];

beforeAll(async () => {
  await sequelize.sync({ force: true });
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST") {
        posts.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(answer);
      } else if (req.url === "/files/a.png") {
        res.writeHead(200);
        res.end("PNG");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
});

afterAll(async () => {
  await new Promise<void>((r) => receiver.close(() => r()));
});

// ── Discord, faked ───────────────────────────────────────────────────────────

/** A guild whose members are `members`; `fetch` answers like discord.js (throws on a non-member). */
function fakeGuild(id: string, members: string[]) {
  return {
    id,
    members: {
      fetch: vi.fn(async (userId: string) => {
        if (!members.includes(userId)) throw new Error("Unknown Member");
        return { id: userId };
      }),
    },
  };
}

function fakeClient() {
  const guilds = [fakeGuild("G1", [TRIGGERER, MEMBER, CLOSED]), fakeGuild("G2", []), fakeGuild("G3", [ELSEWHERE])];
  const cache = new Map(guilds.map((g) => [g.id, g]));
  return {
    guildList: guilds,
    guilds: { cache, fetch: vi.fn(async (id: string) => cache.get(id) ?? Promise.reject(new Error("Unknown Guild"))) },
    users: {
      send: vi.fn(async (userId: string, _body: unknown) => {
        if (userId === CLOSED) throw new Error("Cannot send messages to this user");
        return { id: `dm-${userId}` };
      }),
    },
  };
}

type FakeClient = ReturnType<typeof fakeClient>;

function fakeMessage(place: "guild" | "dm", client: FakeClient) {
  const channel = {
    id: "C1",
    type: place === "guild" ? ChannelType.GuildText : ChannelType.DM,
    client,
    send: vi.fn(async (body: unknown) => ({ id: "M2", body, channel })),
    sendTyping: vi.fn(async () => {}),
    messages: { edit: vi.fn(), delete: vi.fn() },
  };
  const message = {
    id: "M1",
    content: "!go",
    createdTimestamp: Date.now(),
    guild: place === "guild" ? { preferredLocale: "en-US" } : null,
    guildId: place === "guild" ? "G1" : null,
    channelId: "C1",
    channel,
    author: { id: TRIGGERER, send: vi.fn(async () => ({ id: "D1" })) },
  };
  return { message: message as unknown as Message, channel };
}

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
  __resetBehaviorDmRateLimitForTests();
  behaviorCallbackTokens.clear();
  await clearBehaviors();
  await BehaviorDelivery.destroy({ where: {} });
  answer = "";
  posts = [];
  server = await createWebServer({ staticRoot: undefined, bot: fakeBot as never });
  await server.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
});

const seed = () => seedMessageTrigger({}, { url: encryptSecret(receiverUrl) });

async function fire(behaviorId: number, fake: ReturnType<typeof fakeMessage>) {
  const webhook = (await BehaviorWebhookAction.findByPk(behaviorId))!.get({ plain: true });
  await runWebhookAction({
    forwarder: new WebhookForwarder(),
    behaviorId,
    webhook: webhook as never,
    payload: { content: "!go", _meta: { behavior_id: behaviorId } },
    target: { kind: "message", message: fake.message },
    visibility: null,
  });
}

const dmTo = (...userIds: string[]) => userIds.map((user_id) => ({ user_id, content: `for ${user_id}` }));

/** The DM log of `behaviorId`, oldest first, as [recipient, outcome]. */
async function logOf(behaviorId: number) {
  return (await findRecentDmLog(behaviorId)).reverse().map((e) => [e.recipientUserId, e.outcome]);
}

const sentTo = (client: FakeClient) => client.users.send.mock.calls.map(([id]) => id);

// ── who may be DMed ──────────────────────────────────────────────────────────

describe("without a DM allowlist", () => {
  it("a guild trigger DMs members of that guild only, and the reply is untouched", async () => {
    const id = await seed();
    answer = JSON.stringify({ content: "done", direct_messages: dmTo(MEMBER, ELSEWHERE) });
    const client = fakeClient();
    const fake = fakeMessage("guild", client);
    await fire(id, fake);

    expect(fake.channel.send).toHaveBeenCalledWith({ content: "done", allowedMentions: { parse: [] } });
    expect(client.users.send).toHaveBeenCalledTimes(1);
    expect(client.users.send).toHaveBeenCalledWith(MEMBER, {
      content: `for ${MEMBER}`,
      allowedMentions: { parse: [] },
    });
    expect(await logOf(id)).toEqual([
      [MEMBER, "sent"],
      [ELSEWHERE, "not_allowed"],
    ]);
    const entry = (await findRecentDmLog(id))[0]!;
    expect(entry.triggererUserId).toBe(TRIGGERER);
    expect((await findRecentDeliveries(id))[0]).toMatchObject({ ok: true, errorCode: null });
  });

  it("a DM trigger DMs a member of any guild, asking guild by guild until one has them", async () => {
    const id = await seed();
    answer = JSON.stringify({ direct_messages: dmTo(MEMBER, ELSEWHERE, STRANGER) });
    const client = fakeClient();
    await fire(id, fakeMessage("dm", client));

    expect(sentTo(client)).toEqual([MEMBER, ELSEWHERE]);
    expect(await logOf(id)).toEqual([
      [MEMBER, "sent"],
      [ELSEWHERE, "sent"],
      [STRANGER, "not_allowed"],
    ]);
    const [g1, g2, g3] = client.guildList;
    // MEMBER: found in G1, so G2 and G3 were not asked about them
    expect(g1!.members.fetch.mock.calls.map(([u]) => u)).toEqual([MEMBER, ELSEWHERE, STRANGER]);
    expect(g2!.members.fetch.mock.calls.map(([u]) => u)).toEqual([ELSEWHERE, STRANGER]);
    expect(g3!.members.fetch.mock.calls.map(([u]) => u)).toEqual([ELSEWHERE, STRANGER]);
  });
});

describe("with a DM allowlist", () => {
  it("only its users and its groups' members, guild membership aside", async () => {
    const id = await seed();
    await sequelize.transaction(async (transaction) => {
      await replaceDmAllowlist(id, { userIds: [STRANGER], groupNames: ["ops"] }, transaction);
      await replaceGroupMembers("ops", [ELSEWHERE], transaction);
    });
    answer = JSON.stringify({ direct_messages: dmTo(STRANGER, ELSEWHERE, MEMBER) });
    const client = fakeClient();
    await fire(id, fakeMessage("guild", client));

    expect(sentTo(client)).toEqual([STRANGER, ELSEWHERE]);
    expect(await logOf(id)).toEqual([
      [STRANGER, "sent"],
      [ELSEWHERE, "sent"],
      [MEMBER, "not_allowed"],
    ]);
  });
});

// ── outcomes that stay the DM's own ──────────────────────────────────────────

describe("each DM's outcome is its own", () => {
  it("past 10 a minute per behavior, a DM is rate_limited", async () => {
    expect(BEHAVIOR_DMS_PER_MINUTE).toBe(10);
    const id = await seed();
    const client = fakeClient();
    for (let i = 0; i < 2; i += 1) {
      answer = JSON.stringify({ direct_messages: dmTo(MEMBER, MEMBER, MEMBER, MEMBER, MEMBER) });
      await fire(id, fakeMessage("guild", client));
    }
    answer = JSON.stringify({ content: "still shown", direct_messages: dmTo(MEMBER) });
    const fake = fakeMessage("guild", client);
    await fire(id, fake);

    expect(client.users.send).toHaveBeenCalledTimes(10);
    expect((await logOf(id)).at(-1)).toEqual([MEMBER, "rate_limited"]);
    expect(fake.channel.send).toHaveBeenCalledWith({ content: "still shown", allowedMentions: { parse: [] } });
    // another behavior has its own 10
    const other = await seed();
    answer = JSON.stringify({ direct_messages: dmTo(MEMBER) });
    await fire(other, fakeMessage("guild", client));
    expect(await logOf(other)).toEqual([[MEMBER, "sent"]]);
  });

  it("a DM Discord refuses is failed; one whose file can't be had is attachment_failed", async () => {
    const id = await seed();
    answer = JSON.stringify({
      content: "done",
      direct_messages: [
        { user_id: CLOSED, content: "x" },
        { user_id: MEMBER, attachments: [{ name: "gone.png", path: "/files/gone.png" }] },
        { user_id: MEMBER, content: "chart", attachments: [{ name: "a.png", path: "/files/a.png" }] },
      ],
    });
    const client = fakeClient();
    const fake = fakeMessage("guild", client);
    await fire(id, fake);

    expect(await logOf(id)).toEqual([
      [CLOSED, "failed"],
      [MEMBER, "attachment_failed"],
      [MEMBER, "sent"],
    ]);
    expect(client.users.send).toHaveBeenLastCalledWith(MEMBER, {
      content: "chart",
      files: [{ attachment: Buffer.from("PNG"), name: "a.png" }],
      allowedMentions: { parse: [] },
    });
    expect(fake.channel.send).toHaveBeenCalledTimes(1);
    expect((await findRecentDeliveries(id))[0]).toMatchObject({ ok: true, errorCode: null, error: null });
  });

  it("the delivery log keeps no user id", async () => {
    const id = await seed();
    answer = JSON.stringify({ direct_messages: dmTo(MEMBER, STRANGER) });
    await fire(id, fakeMessage("guild", fakeClient()));
    const rows = await BehaviorDelivery.findAll({ where: { behaviorId: id }, raw: true });
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows);
    for (const user of [TRIGGERER, MEMBER, STRANGER]) expect(text).not.toContain(user);
  });

  it("a deferred answer sends no DM", async () => {
    const id = await seed();
    answer = JSON.stringify({ defer: true, direct_messages: dmTo(MEMBER) });
    const client = fakeClient();
    await fire(id, fakeMessage("guild", client));
    expect(client.users.send).not.toHaveBeenCalled();
    expect(await logOf(id)).toEqual([]);
  });
});

// ── the callback token ───────────────────────────────────────────────────────

function call(path: string, token: string, payload: Record<string, unknown>) {
  return server.inject({
    method: "POST",
    url: `/api/plugin/${path}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

const tokenOf = (body: string) =>
  (JSON.parse(body) as { _meta: { callback: { token: string } } })._meta.callback.token;

describe("callback calls with direct_messages", () => {
  it("respond sends them after the reply and answers their outcomes", async () => {
    const id = await seed();
    answer = JSON.stringify({ defer: true });
    const client = fakeClient();
    const fake = fakeMessage("guild", client);
    await fire(id, fake);

    const res = await call("interactions.respond", tokenOf(posts[0]!), {
      content: "done",
      direct_messages: dmTo(MEMBER, STRANGER),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      direct_messages: [
        { user_id: MEMBER, outcome: "sent" },
        { user_id: STRANGER, outcome: "not_allowed" },
      ],
    });
    expect(fake.channel.send).toHaveBeenCalledWith({ content: "done", allowedMentions: { parse: [] } });
    expect(await logOf(id)).toEqual([
      [MEMBER, "sent"],
      [STRANGER, "not_allowed"],
    ]);
  });

  it("followup of only DMs leaves the reply alone and has no id", async () => {
    const id = await seed();
    answer = JSON.stringify({ content: "first" });
    const client = fakeClient();
    const fake = fakeMessage("guild", client);
    await fire(id, fake);

    const res = await call("interactions.followup", tokenOf(posts[0]!), { direct_messages: dmTo(MEMBER) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, direct_messages: [{ user_id: MEMBER, outcome: "sent" }] });
    expect(fake.channel.send).toHaveBeenCalledTimes(1);
  });

  it("edit_followup refuses them", async () => {
    const client = fakeClient();
    const fake = fakeMessage("guild", client);
    const { token, principal } = behaviorCallbackTokens.issue({
      behaviorId: await seed(),
      target: { kind: "message", message: fake.message },
      visibility: null,
    });
    principal.createdMessages.set("F1", { kind: "message", channel: fake.channel as never, messageId: "F1", ephemeral: false });
    const res = await call("interactions.edit_followup", token, {
      message_id: "F1",
      content: "x",
      direct_messages: dmTo(MEMBER),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "direct_messages: only with interactions.respond or interactions.followup" });
    expect(client.users.send).not.toHaveBeenCalled();
  });

  it("a command's interaction has the client too", async () => {
    const id = await seed();
    const client = fakeClient();
    const interaction = {
      client,
      user: { id: TRIGGERER },
      guildId: "G1",
      createdTimestamp: Date.now(),
      deferred: true,
      replied: false,
      ephemeral: true,
      editReply: vi.fn(async () => ({ id: "original" })),
      followUp: vi.fn(),
      deleteReply: vi.fn(),
    };
    await interaction.editReply();
    const { token } = behaviorCallbackTokens.issue({
      behaviorId: id,
      target: { kind: "interaction", interaction: interaction as never },
      visibility: null,
    });
    const res = await call("interactions.respond", token, { content: "ok", direct_messages: dmTo(MEMBER) });
    expect(res.json()).toEqual({ ok: true, direct_messages: [{ user_id: MEMBER, outcome: "sent" }] });
    expect(interaction.editReply).toHaveBeenLastCalledWith({ content: "ok", allowedMentions: { parse: [] } });
  });
});
