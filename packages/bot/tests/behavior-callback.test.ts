/**
 * Behavior callback tokens on command triggers (#113), observed from the
 * outside: what a webhook receiver (a real local HTTP server) gets, what
 * it can do with its token on /api/plugin/* (Fastify inject), what the
 * user sees (a fake interaction), and what the delivery log keeps.
 *
 *   - a command's webhook request carries `_meta.callback`, never the
 *     Discord interaction token
 *   - `{"defer": true}` keeps the "thinking…" placeholder and is an ok
 *     delivery marked deferred
 *   - the token reaches interactions.respond / followup / edit_followup /
 *     delete_followup for its own run only; any other /api/plugin/* path
 *     is 403; an unknown, expired or revoked token is 401
 *   - visibility follows the behavior's stored replyVisibility (a public
 *     command is not answered privately)
 *   - only https link buttons; a refused or failed call is a failed
 *     delivery of the behavior
 *   - respond always works on the message that holds the reply now, so a
 *     later respond edits (or replaces) what the user sees
 *   - a token ends 15 minutes after the interaction was created
 *   - a callback respond is never overwritten by the synchronous answer
 *   - a call that was waiting when its token was revoked is a 401
 *   - writes are throttled per run (per token), 60 a minute
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

import { MessageFlags, type ChatInputCommandInteraction, type Interaction } from "discord.js";
import type { FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { createWebServer } from "../src/modules/web-core/server.js";
import { InteractionDispatcher } from "../src/modules/command-system/interaction-dispatcher.service.js";
import { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { __resetBehaviorRateLimitsForTests } from "../src/modules/command-system/behavior-rate-limits.js";
import {
  CALLBACK_TOKEN_TTL_MS,
  behaviorCallbackTokens,
  serializeReply,
} from "../src/modules/command-system/behavior-callback-token.js";
import { findRecentDeliveries } from "../src/modules/behavior/behavior-deliveries.js";
import type { ReplyVisibility } from "../src/modules/behavior/models/behavior-definition.model.js";
import { encryptSecret } from "../src/utils/crypto.js";
import { clearBehaviors, seedCommand, seedLeaf } from "./behavior-fixtures.js";

const DISCORD_TOKEN = "discord-interaction-token-NEVER-SENT";

// ── the receiver ─────────────────────────────────────────────────────────────

let receiver: Server;
let receiverUrl: string;
/** What the receiver answers next, and the raw bodies it got. */
let answer: { status: number; body: string } = { status: 200, body: "" };
let received: string[] = [];
/** Runs before the receiver answers: a receiver calling back early. */
let beforeAnswer: ((body: string) => Promise<void>) | null = null;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push(body);
      if (beforeAnswer) await beforeAnswer(body);
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

// ── the bot side ─────────────────────────────────────────────────────────────

function fakeSlash(commandName = "slow", createdTimestamp?: number) {
  let followups = 0;
  const raw = {
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    id: "ix1",
    token: DISCORD_TOKEN,
    createdTimestamp,
    applicationId: "app1",
    commandName,
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
    // like discord.js: a deferral fixes the placeholder's visibility
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

type FakeSlash = ReturnType<typeof fakeSlash>;

/** A deferred command run of `behaviorId` and its callback token, without a webhook. */
async function deferredRun(
  behaviorId: number,
  visibility: ReplyVisibility | null = null,
  createdTimestamp?: number,
) {
  const raw = fakeSlash("slow", createdTimestamp);
  await raw.deferReply(visibility === "public" ? {} : { flags: MessageFlags.Ephemeral });
  const { token, principal } = behaviorCallbackTokens.issue({
    behaviorId,
    target: { kind: "interaction", interaction: raw as unknown as ChatInputCommandInteraction },
    visibility,
  });
  return { raw, token, principal };
}

async function seedSlowLeaf(overrides: Record<string, unknown> = {}): Promise<number> {
  return seedLeaf(await seedCommand({ name: "slow" }), overrides, {
    url: encryptSecret(receiverUrl),
  });
}

const rest = {
  get: vi.fn(),
  post: vi.fn(async () => ({ id: "plugin-followup" })),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};
const fakeBot = {
  user: { id: "bot-1" },
  application: { id: "app-1" },
  isReady: () => true,
  uptime: 0,
  guilds: { cache: new Map(), fetch: vi.fn() },
  channels: { fetch: vi.fn(), cache: { get: vi.fn() } },
  rest,
};

let server: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  __resetBehaviorRateLimitsForTests();
  behaviorCallbackTokens.clear();
  await clearBehaviors();
  answer = { status: 200, body: "" };
  received = [];
  beforeAnswer = null;
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

const tokenOf = (body: string) =>
  (JSON.parse(body) as { _meta: { callback: { token: string } } })._meta.callback.token;

const dispatch = (raw: FakeSlash) =>
  new InteractionDispatcher(new WebhookForwarder()).dispatch(raw as unknown as Interaction);

// ── the request ──────────────────────────────────────────────────────────────

describe("a command's webhook request", () => {
  it("carries the run's callback token, never the interaction token", async () => {
    await seedSlowLeaf();
    const before = Date.now();
    await dispatch(fakeSlash());

    expect(received).toHaveLength(1);
    expect(received[0]).not.toContain(DISCORD_TOKEN);
    const meta = (JSON.parse(received[0]!) as { _meta: Record<string, unknown> })._meta;
    const callback = meta.callback as { token: string; expires_at: string; api_base: string };
    expect(typeof callback.token).toBe("string");
    expect(callback.token.length).toBeGreaterThanOrEqual(40);
    const expires = Date.parse(callback.expires_at);
    expect(expires).toBeGreaterThanOrEqual(before + CALLBACK_TOKEN_TTL_MS);
    expect(expires).toBeLessThanOrEqual(Date.now() + CALLBACK_TOKEN_TTL_MS);
    expect(callback.api_base).toMatch(/^https?:\/\/[^/]+$/);
  });

  it("gives each run its own token", async () => {
    await seedSlowLeaf();
    await dispatch(fakeSlash());
    await dispatch(fakeSlash());
    const tokens = received.map(
      (b) => (JSON.parse(b) as { _meta: { callback: { token: string } } })._meta.callback.token,
    );
    expect(new Set(tokens).size).toBe(2);
  });
});

// ── defer, then answer ───────────────────────────────────────────────────────

describe('{"defer": true}, then the callback', () => {
  it("keeps the placeholder, logs a deferred delivery, and respond fills it in place", async () => {
    const id = await seedSlowLeaf({ replyVisibility: "public" });
    answer = { status: 200, body: JSON.stringify({ defer: true, content: "not shown" }) };
    const raw = fakeSlash();

    await dispatch(raw);

    // the public "thinking…" stays: no empty reply removes it, nothing is shown yet
    expect(raw.deferReply).toHaveBeenCalledWith({});
    expect(raw.editReply).not.toHaveBeenCalled();
    expect(raw.deleteReply).not.toHaveBeenCalled();
    expect(raw.followUp).not.toHaveBeenCalled();
    const [delivery] = await findRecentDeliveries(id);
    expect(delivery).toMatchObject({ via: "command", ok: true, deferred: true, errorCode: null });

    const { token } = (JSON.parse(received[0]!) as { _meta: { callback: { token: string } } })._meta.callback;
    const res = await call("interactions.respond", token, { content: "done" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // public stays public: the placeholder is filled, not replaced by a private follow-up
    expect(raw.editReply).toHaveBeenCalledWith({ content: "done", allowedMentions: { parse: [] } });
    expect(raw.followUp).not.toHaveBeenCalled();
    expect(rest.patch).not.toHaveBeenCalled();
    expect(await findRecentDeliveries(id)).toHaveLength(1);
  });

  it("a synchronous reply is not deferred, and the token still follows up", async () => {
    const id = await seedSlowLeaf();
    answer = { status: 200, body: JSON.stringify({ content: "working on it" }) };
    const raw = fakeSlash();
    await dispatch(raw);

    expect(raw.editReply).toHaveBeenCalledWith({ content: "working on it", allowedMentions: { parse: [] } });
    expect((await findRecentDeliveries(id))[0]).toMatchObject({ ok: true, deferred: false });
    const { token } = (JSON.parse(received[0]!) as { _meta: { callback: { token: string } } })._meta.callback;
    const res = await call("interactions.followup", token, { content: "done" });
    expect(res.statusCode).toBe(200);
    expect(raw.followUp).toHaveBeenCalledTimes(1);
  });

  it("a failed run revokes its token", async () => {
    await seedSlowLeaf();
    answer = { status: 500, body: "boom" };
    await dispatch(fakeSlash());
    const { token } = (JSON.parse(received[0]!) as { _meta: { callback: { token: string } } })._meta.callback;
    const res = await call("interactions.respond", token, { content: "too late" });
    expect(res.statusCode).toBe(401);
  });
});

// ── what the token may reach ─────────────────────────────────────────────────

describe("the callback principal", () => {
  it("is refused every other /api/plugin/* path with 403", async () => {
    const id = await seedSlowLeaf();
    const { token } = await deferredRun(id);
    for (const path of [
      "messages.send",
      "interactions.send_modal",
      "me",
      "storage.kv_get",
      "voice.status",
      "no-such-route",
    ]) {
      const res = await call(path, token, { channel_id: "C1", content: "x" });
      expect(res.statusCode, path).toBe(403);
    }
    expect(rest.post).not.toHaveBeenCalled();
  });

  it("an unknown token is 401", async () => {
    const res = await call("interactions.respond", "not-a-token", { content: "x" });
    expect(res.statusCode).toBe(401);
  });

  it("a token is 401 once 15 minutes have passed since the command was used", async () => {
    const id = await seedSlowLeaf();
    // the command was used 14 minutes before the token was issued
    const createdAt = Date.now() - 14 * 60 * 1000;
    const { raw, token } = await deferredRun(id, null, createdAt);
    const now = vi.spyOn(Date, "now");

    now.mockReturnValue(createdAt + CALLBACK_TOKEN_TTL_MS - 1000);
    expect((await call("interactions.respond", token, { content: "in time" })).statusCode).toBe(200);
    now.mockReturnValue(createdAt + CALLBACK_TOKEN_TTL_MS + 1000);
    expect((await call("interactions.respond", token, { content: "late" })).statusCode).toBe(401);
    expect(raw.editReply).toHaveBeenCalledTimes(1);
  });

  it("expires_at is the interaction's creation plus 15 minutes", async () => {
    await seedSlowLeaf();
    const createdAt = Date.now() - 60_000;
    await dispatch(fakeSlash("slow", createdAt));
    const meta = (JSON.parse(received[0]!) as { _meta: { callback: { expires_at: string } } })._meta;
    expect(Date.parse(meta.callback.expires_at)).toBe(createdAt + CALLBACK_TOKEN_TTL_MS);
  });

  it("ignores an interaction_token in the body: it answers its own run only", async () => {
    const id = await seedSlowLeaf();
    const { raw, token } = await deferredRun(id);
    const res = await call("interactions.respond", token, {
      interaction_token: "someone-elses-interaction",
      content: "mine",
    });
    expect(res.statusCode).toBe(200);
    expect(raw.editReply).toHaveBeenCalledTimes(1);
    expect(rest.patch).not.toHaveBeenCalled();
    expect(rest.post).not.toHaveBeenCalled();
  });
});

// ── visibility ───────────────────────────────────────────────────────────────

describe("who sees a callback reply", () => {
  it("a private command filled in place by default", async () => {
    const id = await seedSlowLeaf({ replyVisibility: "private" });
    const { raw, token } = await deferredRun(id, "private");
    await call("interactions.respond", token, { content: "only you" });
    expect(raw.editReply).toHaveBeenCalledWith({ content: "only you", allowedMentions: { parse: [] } });
  });

  it("ephemeral: false on a private placeholder posts publicly and removes the placeholder", async () => {
    const id = await seedSlowLeaf();
    const { raw, token } = await deferredRun(id);
    await call("interactions.respond", token, { content: "everyone", ephemeral: false });
    expect(raw.followUp).toHaveBeenCalledWith({ content: "everyone", allowedMentions: { parse: [] } });
    expect(raw.deleteReply).toHaveBeenCalledWith();
    expect(raw.editReply).not.toHaveBeenCalled();
  });

  it("a follow-up of a public command is public, of a private one private", async () => {
    const pub = await seedSlowLeaf({ replyVisibility: "public" });
    const publicRun = await deferredRun(pub, "public");
    await call("interactions.followup", publicRun.token, { content: "all" });
    expect(publicRun.raw.followUp).toHaveBeenCalledWith({ content: "all", allowedMentions: { parse: [] } });

    const privateRun = await deferredRun(pub, null);
    await call("interactions.followup", privateRun.token, { content: "me" });
    expect(privateRun.raw.followUp).toHaveBeenCalledWith({
      content: "me",
      allowedMentions: { parse: [] },
      flags: MessageFlags.Ephemeral,
    });
  });
});

// ── respond, again ───────────────────────────────────────────────────────────

describe("respond works on the reply as it is now", () => {
  it("after a respond went public on a private command, the next respond edits that message", async () => {
    const id = await seedSlowLeaf();
    const { raw, token } = await deferredRun(id);
    await call("interactions.respond", token, { content: "everyone", ephemeral: false });
    expect(raw.followUp).toHaveBeenCalledTimes(1);
    expect(raw.deleteReply).toHaveBeenCalledWith();

    const res = await call("interactions.respond", token, { content: "everyone, updated" });

    expect(res.statusCode).toBe(200);
    expect(raw.editReply).toHaveBeenCalledTimes(1);
    expect(raw.editReply).toHaveBeenCalledWith({
      content: "everyone, updated",
      allowedMentions: { parse: [] },
      message: "F1",
    });
    expect(raw.followUp).toHaveBeenCalledTimes(1);
  });

  it("switching back to private replaces the public message", async () => {
    const id = await seedSlowLeaf();
    const { raw, token } = await deferredRun(id);
    await call("interactions.respond", token, { content: "everyone", ephemeral: false });
    await call("interactions.respond", token, { content: "just you", ephemeral: true });
    expect(raw.followUp).toHaveBeenLastCalledWith({
      content: "just you",
      allowedMentions: { parse: [] },
      flags: MessageFlags.Ephemeral,
    });
    expect(raw.deleteReply).toHaveBeenLastCalledWith("F1");
  });

  it("after a synchronous answer that went public, respond edits that answer", async () => {
    const id = await seedSlowLeaf();
    answer = { status: 200, body: JSON.stringify({ content: "working", ephemeral: false }) };
    const raw = fakeSlash();
    await dispatch(raw);
    expect(raw.followUp).toHaveBeenCalledTimes(1);

    const res = await call("interactions.respond", tokenOf(received[0]!), { content: "done" });

    expect(res.statusCode).toBe(200);
    expect(raw.editReply).toHaveBeenCalledWith({ content: "done", allowedMentions: { parse: [] }, message: "F1" });
    expect(raw.followUp).toHaveBeenCalledTimes(1);
    expect(await findRecentDeliveries(id)).toHaveLength(1);
  });

  it("after an empty synchronous answer removed the placeholder, respond sends a new reply, then edits it", async () => {
    await seedSlowLeaf();
    answer = { status: 200, body: "" };
    const raw = fakeSlash();
    await dispatch(raw);
    expect(raw.deleteReply).toHaveBeenCalledWith();
    const token = tokenOf(received[0]!);

    await call("interactions.respond", token, { content: "here after all" });
    expect(raw.followUp).toHaveBeenCalledWith({
      content: "here after all",
      allowedMentions: { parse: [] },
      flags: MessageFlags.Ephemeral,
    });
    expect(raw.editReply).not.toHaveBeenCalled();

    await call("interactions.respond", token, { content: "and updated" });
    expect(raw.editReply).toHaveBeenCalledWith({ content: "and updated", allowedMentions: { parse: [] }, message: "F1" });
    expect(raw.followUp).toHaveBeenCalledTimes(1);
  });
});

// ── the receiver calls back before it answers ────────────────────────────────

describe("a callback respond before the synchronous answer", () => {
  it("is not overwritten by the synchronous answer", async () => {
    const id = await seedSlowLeaf();
    answer = { status: 200, body: JSON.stringify({ content: "sync answer" }) };
    beforeAnswer = async (body) => {
      const res = await call("interactions.respond", tokenOf(body), { content: "callback answer" });
      expect(res.statusCode).toBe(200);
    };
    const raw = fakeSlash();

    await dispatch(raw);

    expect(raw.editReply).toHaveBeenCalledTimes(1);
    expect(raw.editReply).toHaveBeenCalledWith({ content: "callback answer", allowedMentions: { parse: [] } });
    const [delivery] = await findRecentDeliveries(id);
    expect(delivery).toMatchObject({ ok: true, deferred: true });
  });

  it("keeps its answer when the synchronous request then fails: an ok delivery, no failure line, the token lives on", async () => {
    const id = await seedSlowLeaf();
    answer = { status: 500, body: "boom" };
    let token = "";
    beforeAnswer = async (body) => {
      token = tokenOf(body);
      await call("interactions.respond", token, { content: "callback answer" });
    };
    const raw = fakeSlash();

    await dispatch(raw);

    expect(raw.editReply).toHaveBeenCalledTimes(1);
    expect(raw.followUp).not.toHaveBeenCalled();
    // the user saw a reply: not a failure
    expect((await findRecentDeliveries(id))[0]).toMatchObject({
      ok: true,
      deferred: true,
      errorCode: null,
      error: null,
    });
    expect((await call("interactions.followup", token, { content: "more" })).statusCode).toBe(200);
  });
});

describe("a call waiting when its token is revoked", () => {
  it("is 401 and touches nothing, though it passed the auth hook", async () => {
    const id = await seedSlowLeaf();
    const { raw, token, principal } = await deferredRun(id);
    // the failed run's turn (revoke + failure line) holds the reply
    let release!: () => void;
    const held = serializeReply(principal, () => new Promise<void>((r) => (release = r)));

    const respond = call("interactions.respond", token, { content: "late" });
    const followup = call("interactions.followup", token, { content: "late too" });
    await new Promise((r) => setTimeout(r, 50));
    behaviorCallbackTokens.revoke(token);
    release();
    await held;

    expect((await respond).statusCode).toBe(401);
    expect((await followup).statusCode).toBe(401);
    expect(raw.editReply).not.toHaveBeenCalled();
    expect(raw.followUp).not.toHaveBeenCalled();
    expect(await findRecentDeliveries(id)).toEqual([]);
  });
});

// ── follow-ups ───────────────────────────────────────────────────────────────

describe("follow-ups", () => {
  it("followup returns its id; edit and delete reach only the token's own messages", async () => {
    const id = await seedSlowLeaf();
    const { raw, token } = await deferredRun(id);

    const sent = await call("interactions.followup", token, { content: "step 1" });
    expect(sent.json()).toEqual({ ok: true, id: "F1" });

    const edited = await call("interactions.edit_followup", token, { message_id: "F1", content: "step 2" });
    expect(edited.statusCode).toBe(200);
    expect(raw.editReply).toHaveBeenCalledWith({
      content: "step 2",
      allowedMentions: { parse: [] },
      message: "F1",
    });

    for (const messageId of ["@original", "F9"]) {
      expect((await call("interactions.edit_followup", token, { message_id: messageId, content: "x" })).statusCode).toBe(403);
      expect((await call("interactions.delete_followup", token, { message_id: messageId })).statusCode).toBe(403);
    }

    const deleted = await call("interactions.delete_followup", token, { message_id: "F1" });
    expect(deleted.statusCode).toBe(200);
    expect(raw.deleteReply).toHaveBeenCalledWith("F1");
    expect((await call("interactions.delete_followup", token, { message_id: "F1" })).statusCode).toBe(403);
  });

  it("another run's token cannot touch this run's follow-ups", async () => {
    const id = await seedSlowLeaf();
    const first = await deferredRun(id);
    const second = await deferredRun(id);
    await call("interactions.followup", first.token, { content: "mine" });
    const res = await call("interactions.delete_followup", second.token, { message_id: "F1" });
    expect(res.statusCode).toBe(403);
    expect(first.raw.deleteReply).not.toHaveBeenCalled();
    expect(second.raw.deleteReply).not.toHaveBeenCalled();
  });
});

// ── the body, and failures ───────────────────────────────────────────────────

describe("a refused or failed call", () => {
  it("only https link buttons: anything else is 400 and a callback_invalid delivery", async () => {
    const id = await seedSlowLeaf();
    const { raw, token } = await deferredRun(id);
    const bad = [
      [{ type: 1, components: [{ type: 2, style: 1, label: "go", custom_id: "kc:x:y" }] }],
      [{ type: 1, components: [{ type: 2, style: 5, label: "go", url: "http://plain.example" }] }],
    ];
    for (const components of bad) {
      const res = await call("interactions.respond", token, { content: "x", components });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toMatch(/link buttons/);
    }
    const ok = await call("interactions.respond", token, {
      components: [{ type: 1, components: [{ type: 2, style: 5, label: "go", url: "https://ok.example" }] }],
    });
    expect(ok.statusCode).toBe(200);
    expect(raw.editReply).toHaveBeenCalledTimes(1);
    const deliveries = await findRecentDeliveries(id);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({ via: "command", ok: false, errorCode: "callback_invalid" });
  });

  it("a reply with nothing to show is 400", async () => {
    const id = await seedSlowLeaf();
    const { token } = await deferredRun(id);
    const res = await call("interactions.respond", token, {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "content, embeds, components or attachments required" });
  });

  it("Discord refusing the reply is 400 and a callback_failed delivery", async () => {
    const id = await seedSlowLeaf();
    const { raw, token } = await deferredRun(id);
    raw.editReply.mockRejectedValueOnce(new Error("Unknown Webhook"));
    const res = await call("interactions.respond", token, { content: "x" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "respond failed: Unknown Webhook" });
    const [delivery] = await findRecentDeliveries(id);
    expect(delivery).toMatchObject({
      ok: false,
      errorCode: "callback_failed",
      error: "interactions.respond: Unknown Webhook",
    });
  });
});

// ── throttling ───────────────────────────────────────────────────────────────

describe("write throttling", () => {
  it("is per run: 60 a minute, then 429, while other runs of the same behavior go on", async () => {
    const busy = await seedSlowLeaf();
    const other = await seedLeaf(await seedCommand({ name: "other" }));
    const { token } = await deferredRun(busy);
    const { token: otherToken } = await deferredRun(other);
    for (let i = 0; i < 60; i++) {
      const res = await call("interactions.respond", token, { content: `#${i}` });
      expect(res.statusCode).toBe(200);
    }
    expect((await call("interactions.respond", token, { content: "one more" })).statusCode).toBe(429);
    // a second run of the same behavior has its own budget
    const { token: sameBehavior } = await deferredRun(busy);
    expect((await call("interactions.followup", sameBehavior, { content: "x" })).statusCode).toBe(200);
    expect((await call("interactions.respond", otherToken, { content: "fine" })).statusCode).toBe(200);
  });
});
