/**
 * Webhook reply attachments (#156), end to end from the outside: a real
 * local HTTP receiver answers the webhook POST and serves the files; the
 * bot side is the InteractionDispatcher (command triggers),
 * runWebhookAction (message triggers) and /api/plugin/* (Fastify inject)
 * for the callback token; Discord is faked.
 *
 *   - a command's reply carries the files, filling its placeholder or
 *     following up; an attachments-only reply is not an empty one
 *   - a message trigger's reply carries them, in the channel or — private
 *     in a guild — in the author's DM
 *   - callback respond / followup carry them, fetched from the run's
 *     webhook origin
 *   - a file that can't be had (missing, too many, a redirect, an unsafe
 *     path) fails the run: the failure line, an `attachment_failed`
 *     delivery, and never the reply without its files
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
vi.mock("../src/modules/plugin-system/plugin-interaction-dispatch.service.js", () => ({
  dispatchInteractionToPlugin: vi.fn(),
}));
vi.mock("../src/modules/plugin-system/plugin-component-dispatch.service.js", () => ({
  dispatchComponentToPlugin: vi.fn(),
}));
vi.mock("../src/modules/plugin-system/plugin-modal-dispatch.service.js", () => ({
  dispatchModalToPlugin: vi.fn(),
}));
vi.mock("../src/modules/builtin-features/in-process-command-registry.service.js", () => ({
  dispatchInProcessInteraction: vi.fn(),
}));
vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
  setBotEventLogMetric: vi.fn(),
}));

import { ChannelType, MessageFlags, type Interaction, type Message } from "discord.js";
import type { FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { createWebServer } from "../src/modules/web-core/server.js";
import { InteractionDispatcher } from "../src/modules/command-system/interaction-dispatcher.service.js";
import { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { runWebhookAction } from "../src/modules/command-system/webhook-action.js";
import { __resetBehaviorRateLimitsForTests } from "../src/modules/command-system/behavior-rate-limits.js";
import { behaviorCallbackTokens } from "../src/modules/command-system/behavior-callback-token.js";
import { findRecentDeliveries } from "../src/modules/behavior/behavior-deliveries.js";
import { BehaviorWebhookAction } from "../src/modules/behavior/models/behavior-webhook-action.model.js";
import type { ReplyVisibility } from "../src/modules/behavior/models/behavior-definition.model.js";
import { encryptSecret } from "../src/utils/crypto.js";
import { clearBehaviors, seedCommand, seedLeaf, seedMessageTrigger } from "./behavior-fixtures.js";

const FAILURE_LINE = "⚠ This couldn't be completed right now. Please try again later.";

// ── the receiver: the webhook, and the files it serves ───────────────────────

let receiver: Server;
let receiverUrl: string;
let answer = "";
let posts: string[] = [];
let gets: string[] = [];

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
        return;
      }
      gets.push(req.url ?? "");
      if (req.url === "/files/chart.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end("PNG-BYTES");
      } else if (req.url === "/files/moved.png") {
        res.writeHead(302, { location: "http://169.254.169.254/" });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
  // the files come from the origin, not from under the webhook's path
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks/weather`;
});

afterAll(async () => {
  await new Promise<void>((r) => receiver.close(() => r()));
});

const CHART = [{ name: "chart.png", path: "/files/chart.png" }];
/** What discord.js is handed for CHART. */
const CHART_FILES = [{ attachment: Buffer.from("PNG-BYTES"), name: "chart.png" }];

// ── Discord, faked ───────────────────────────────────────────────────────────

function fakeSlash() {
  let followups = 0;
  const raw = {
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    id: "ix1",
    token: "discord-interaction-token",
    createdTimestamp: Date.now(),
    applicationId: "app1",
    commandName: "chart",
    commandGuildId: null,
    guildId: "G1",
    channelId: "C1",
    locale: "en-US",
    user: {
      id: "U1",
      username: "tester",
      globalName: "Tester",
      discriminator: "0",
      avatar: null,
      displayAvatarURL: () => "https://cdn.example/avatar.png",
    },
    options: {
      data: [] as unknown[],
      resolved: null,
      getSubcommand: () => null,
      getSubcommandGroup: () => null,
    },
    deferred: false,
    replied: false,
    ephemeral: null as boolean | null,
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async (o: { flags?: number }) => {
      raw.deferred = true;
      raw.ephemeral = ((o.flags ?? 0) & MessageFlags.Ephemeral) !== 0;
    }),
    editReply: vi.fn(async (_o: unknown) => ({ id: "original" })) as Mock,
    followUp: vi.fn(async (_o: unknown) => ({ id: `F${++followups}` })) as Mock,
    deleteReply: vi.fn(async (_id?: string) => {}) as Mock,
  };
  return raw;
}

function fakeMessage(place: "guild" | "dm") {
  let n = 0;
  const sent = (prefix: string) => vi.fn(async (body: unknown) => ({ id: `${prefix}${++n}`, body, channel }));
  const channel = {
    id: "C1",
    type: place === "guild" ? ChannelType.GuildText : ChannelType.DM,
    send: sent("C"),
    sendTyping: vi.fn(async () => {}),
    messages: { edit: vi.fn(), delete: vi.fn() },
  };
  const author = {
    id: "U1",
    username: "tester",
    globalName: "Tester",
    discriminator: "0",
    avatar: null,
    bot: false,
    send: sent("D"),
  };
  const message = {
    id: "M1",
    content: "!chart",
    createdTimestamp: Date.now(),
    guild: place === "guild" ? { preferredLocale: "en-US" } : null,
    guildId: place === "guild" ? "G1" : null,
    channelId: "C1",
    channel,
    author,
  };
  return { message: message as unknown as Message, channel, author };
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
  __resetBehaviorRateLimitsForTests();
  behaviorCallbackTokens.clear();
  await clearBehaviors();
  answer = "";
  posts = [];
  gets = [];
  server = await createWebServer({ staticRoot: undefined, bot: fakeBot as never });
  await server.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
});

async function seedChartLeaf(overrides: Record<string, unknown> = {}): Promise<number> {
  return seedLeaf(await seedCommand({ name: "chart" }), overrides, { url: encryptSecret(receiverUrl) });
}

const dispatch = (raw: ReturnType<typeof fakeSlash>) =>
  new InteractionDispatcher(new WebhookForwarder()).dispatch(raw as unknown as Interaction);

/** Run a message trigger's webhook action on `fake`, as the matcher does. */
async function fire(behaviorId: number, fake: ReturnType<typeof fakeMessage>, visibility: ReplyVisibility | null = null) {
  const webhook = (await BehaviorWebhookAction.findByPk(behaviorId))!.get({ plain: true });
  await runWebhookAction({
    forwarder: new WebhookForwarder(),
    behaviorId,
    webhook: webhook as never,
    payload: { content: "!chart", _meta: { behavior_id: behaviorId } },
    target: { kind: "message", message: fake.message },
    visibility,
  });
}

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

// ── command triggers ─────────────────────────────────────────────────────────

describe("a command's reply with attachments", () => {
  it("fills the placeholder with the files, fetched from the webhook's origin", async () => {
    const id = await seedChartLeaf();
    answer = JSON.stringify({ content: "today", attachments: CHART });
    const raw = fakeSlash();
    await dispatch(raw);

    expect(gets).toEqual(["/files/chart.png"]);
    expect(raw.editReply).toHaveBeenCalledWith({
      content: "today",
      files: CHART_FILES,
      attachments: [],
      allowedMentions: { parse: [] },
    });
    expect((await findRecentDeliveries(id))[0]).toMatchObject({ ok: true, errorCode: null });
  });

  it("an attachments-only reply is shown, not taken for an empty one", async () => {
    await seedChartLeaf();
    answer = JSON.stringify({ attachments: CHART });
    const raw = fakeSlash();
    await dispatch(raw);

    expect(raw.deleteReply).not.toHaveBeenCalled();
    expect(raw.editReply).toHaveBeenCalledWith({
      files: CHART_FILES,
      attachments: [],
      allowedMentions: { parse: [] },
    });
  });

  it("follows up publicly with the files when the reply says ephemeral:false", async () => {
    await seedChartLeaf();
    answer = JSON.stringify({ content: "for all", ephemeral: false, attachments: CHART });
    const raw = fakeSlash();
    await dispatch(raw);

    expect(raw.followUp).toHaveBeenCalledWith({
      content: "for all",
      files: CHART_FILES,
      allowedMentions: { parse: [] },
    });
  });

  it("a missing file fails the run: the failure line, never the reply without it", async () => {
    const id = await seedChartLeaf();
    answer = JSON.stringify({ content: "today", attachments: [...CHART, { name: "gone.png", path: "/files/gone.png" }] });
    const raw = fakeSlash();
    await dispatch(raw);

    expect(raw.editReply).toHaveBeenCalledTimes(1);
    expect(raw.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: FAILURE_LINE }));
    const [delivery] = await findRecentDeliveries(id);
    expect(delivery).toMatchObject({ ok: false, errorCode: "attachment_failed", httpStatus: 200 });
    expect(delivery!.error).toBe('attachments: attachment 2 ("gone.png"): HTTP 404');
    // the token is revoked with the failed run
    const res = await call("interactions.respond", tokenOf(posts[0]!), { content: "late" });
    expect(res.statusCode).toBe(401);
  });

  it("more than 5 files fail the run without fetching any", async () => {
    const id = await seedChartLeaf();
    answer = JSON.stringify({ attachments: Array.from({ length: 6 }, () => CHART[0]) });
    const raw = fakeSlash();
    await dispatch(raw);

    expect(gets).toEqual([]);
    expect(raw.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: FAILURE_LINE }));
    expect((await findRecentDeliveries(id))[0]).toMatchObject({
      ok: false,
      errorCode: "attachment_failed",
      error: "attachments: at most 5 attachments, got 6",
    });
  });

  it("a path to another host, or a redirect, fails the run", async () => {
    const id = await seedChartLeaf();
    for (const path of ["//evil.example/files/chart.png", "https://evil.example/x.png", "/files/moved.png"]) {
      answer = JSON.stringify({ attachments: [{ name: "x.png", path }] });
      await dispatch(fakeSlash());
    }
    expect(gets).toEqual(["/files/moved.png"]);
    const deliveries = await findRecentDeliveries(id);
    expect(deliveries.map((d) => d.errorCode)).toEqual(["attachment_failed", "attachment_failed", "attachment_failed"]);
    expect(deliveries.map((d) => d.error)).toContain(
      'attachments: attachment 1 ("x.png"): a redirect (HTTP 302); redirects are not followed',
    );
  });

  it("a malformed attachments list is an invalid reply", async () => {
    const id = await seedChartLeaf();
    answer = JSON.stringify({ content: "x", attachments: ["/files/chart.png"] });
    const raw = fakeSlash();
    await dispatch(raw);

    expect(raw.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: FAILURE_LINE }));
    expect((await findRecentDeliveries(id))[0]).toMatchObject({ ok: false, errorCode: "invalid_reply" });
  });
});

// ── message triggers ─────────────────────────────────────────────────────────

describe("a message trigger's reply with attachments", () => {
  it("sends the files in the channel", async () => {
    const id = await seedMessageTrigger({}, { url: encryptSecret(receiverUrl) });
    answer = JSON.stringify({ content: "today", attachments: CHART });
    const fake = fakeMessage("guild");
    await fire(id, fake);

    expect(fake.channel.send).toHaveBeenCalledWith({
      content: "today",
      files: CHART_FILES,
      allowedMentions: { parse: [] },
    });
    expect((await findRecentDeliveries(id))[0]).toMatchObject({ via: "message", ok: true });
  });

  it("DMs a private guild reply's files to the author, never the channel", async () => {
    const id = await seedMessageTrigger({}, { url: encryptSecret(receiverUrl) });
    answer = JSON.stringify({ attachments: CHART });
    const fake = fakeMessage("guild");
    await fire(id, fake, "private");

    expect(fake.author.send).toHaveBeenCalledWith({ files: CHART_FILES, allowedMentions: { parse: [] } });
    expect(fake.channel.send).not.toHaveBeenCalled();
  });

  it("a file that can't be had: the author is told in a DM, the channel hears nothing", async () => {
    const id = await seedMessageTrigger({}, { url: encryptSecret(receiverUrl) });
    answer = JSON.stringify({ content: "today", attachments: [{ name: "gone.png", path: "/files/gone.png" }] });
    const fake = fakeMessage("guild");
    await fire(id, fake);

    expect(fake.channel.send).not.toHaveBeenCalled();
    expect(fake.author.send).toHaveBeenCalledWith({ content: FAILURE_LINE, allowedMentions: { parse: [] } });
    expect((await findRecentDeliveries(id))[0]).toMatchObject({
      via: "message",
      ok: false,
      errorCode: "attachment_failed",
    });
  });
});

// ── the callback token ───────────────────────────────────────────────────────

describe("callback calls with attachments", () => {
  it("respond fills a deferred command's placeholder with the files", async () => {
    await seedChartLeaf();
    answer = JSON.stringify({ defer: true });
    const raw = fakeSlash();
    await dispatch(raw);
    expect(gets).toEqual([]);

    const res = await call("interactions.respond", tokenOf(posts[0]!), { attachments: CHART });
    expect(res.statusCode).toBe(200);
    expect(gets).toEqual(["/files/chart.png"]);
    expect(raw.editReply).toHaveBeenCalledWith({
      files: CHART_FILES,
      attachments: [],
      allowedMentions: { parse: [] },
    });
  });

  it("followup on a message trigger sends the files like its reply", async () => {
    const id = await seedMessageTrigger({}, { url: encryptSecret(receiverUrl) });
    answer = JSON.stringify({ defer: true });
    const fake = fakeMessage("dm");
    await fire(id, fake);

    const res = await call("interactions.followup", tokenOf(posts[0]!), { content: "more", attachments: CHART });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, id: "C1" });
    expect(fake.channel.send).toHaveBeenCalledWith({
      content: "more",
      files: CHART_FILES,
      allowedMentions: { parse: [] },
    });
  });

  it("a file that can't be had is a 400 and an attachment_failed delivery; nothing is shown", async () => {
    const id = await seedChartLeaf();
    answer = JSON.stringify({ defer: true });
    const raw = fakeSlash();
    await dispatch(raw);

    const res = await call("interactions.respond", tokenOf(posts[0]!), {
      content: "done",
      attachments: [{ name: "gone.png", path: "/files/gone.png" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'respond failed: attachments: attachment 1 ("gone.png"): HTTP 404' });
    expect(raw.editReply).not.toHaveBeenCalled();
    const [failure] = await findRecentDeliveries(id);
    expect(failure).toMatchObject({ ok: false, errorCode: "attachment_failed" });
  });

  it("a token whose run has no file source refuses attachments", async () => {
    const id = await seedChartLeaf();
    const raw = fakeSlash();
    await raw.deferReply({ flags: MessageFlags.Ephemeral });
    const { token } = behaviorCallbackTokens.issue({
      behaviorId: id,
      target: { kind: "interaction", interaction: raw as never },
      visibility: null,
    });

    const res = await call("interactions.respond", token, { attachments: CHART });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "respond failed: attachments: not available for this reply" });
    expect(raw.editReply).not.toHaveBeenCalled();
  });
});
