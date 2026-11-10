/**
 * #203 — a behavior whose action is a plugin action, run end to end:
 * the real InteractionDispatcher / MessageTriggerMatcher, the real Plugin
 * Dispatch (createPluginDispatcher, readiness injected) POSTing to a local
 * HTTP "plugin", and the plugin answering through the callback token on
 * /api/plugin/* (Fastify inject on createWebServer), as the SDK does.
 *
 *   - a command is deferred, then dispatched: the plugin gets a signed
 *     `behavior_action` at /behavior-actions/<key> carrying the trigger's
 *     `_meta`, `action_key` and `callback` — never the interaction token —
 *     in the contract's shape (CONTRACT_FIXTURES)
 *   - the plugin replies with the token and the user sees it; the
 *     delivery is ok and deferred
 *   - a message trigger dispatches too, shows typing, and its reply lands
 *   - a reply's attachments come from the plugin's own origin
 *   - no Feature or Guild Reach is asked
 *   - plugin offline / not installed / action dropped from the manifest:
 *     nothing is dispatched, the user gets the failure line, the delivery
 *     has its own code; a failed dispatch revokes the token
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, type Mock } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

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
import { CONTRACT_FIXTURES } from "@karyl-chan/plugin-wire";
import { sequelize } from "../src/db.js";
import { createWebServer } from "../src/modules/web-core/server.js";
import { InteractionDispatcher } from "../src/modules/command-system/interaction-dispatcher.service.js";
import { MessageTriggerMatcher } from "../src/modules/command-system/message-trigger-matcher.service.js";
import { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { __resetBehaviorRateLimitsForTests } from "../src/modules/command-system/behavior-rate-limits.js";
import { behaviorCallbackTokens } from "../src/modules/command-system/behavior-callback-token.js";
import type { PluginActionDeps } from "../src/modules/command-system/plugin-action.js";
import { createPluginDispatcher } from "../src/modules/plugin-system/plugin-dispatch.service.js";
import { Plugin, findPluginByKey } from "../src/modules/plugin-system/models/plugin.model.js";
import { findRecentDeliveries } from "../src/modules/behavior/behavior-deliveries.js";
import { verifyInboundSignature } from "../src/utils/hmac.js";
import { bindPluginAction, clearBehaviors, seedCommand, seedLeaf, seedMessageTrigger } from "./behavior-fixtures.js";

const DISCORD_TOKEN = "discord-interaction-token-NEVER-SENT";
const DISPATCH_KEY = "dispatch-key-for-tests";
const FILE_BYTES = Buffer.from("dice face six");

// ── the plugin ───────────────────────────────────────────────────────────────

interface Dispatched {
  path: string;
  headers: Headers;
  body: string;
}

let plugin: Server;
let pluginUrl: string;
let dispatched: Dispatched[] = [];
/** The status the plugin answers a dispatch with. */
let pluginStatus = 204;
/** Runs after the plugin answered, like an SDK handler. */
let afterAnswer: ((d: Dispatched) => Promise<void>) | null = null;
let handled: Promise<void> = Promise.resolve();

beforeAll(async () => {
  await sequelize.sync({ force: true });
  plugin = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/files/six.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(FILE_BYTES);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const d: Dispatched = {
        path: req.url ?? "",
        headers: new Headers(req.headers as Record<string, string>),
        body: Buffer.concat(chunks).toString("utf8"),
      };
      dispatched.push(d);
      res.writeHead(pluginStatus);
      res.end();
      if (afterAnswer) handled = afterAnswer(d);
    });
  });
  await new Promise<void>((r) => plugin.listen(0, "127.0.0.1", () => r()));
  pluginUrl = `http://127.0.0.1:${(plugin.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => plugin.close(() => r()));
});

async function seedPlugin(overrides: Record<string, unknown> = {}, actions = ["roll"]): Promise<void> {
  await Plugin.create({
    pluginKey: "dice",
    name: "Dice",
    version: "1.0.0",
    url: pluginUrl,
    manifestJson: JSON.stringify({
      schema_version: "1",
      plugin: { id: "dice", name: "Dice", version: "1.0.0", url: pluginUrl },
      behavior_actions: actions.map((key) => ({ key, name: key, description: key })),
      endpoints: { behavior_action: "/behavior-actions/{action_key}" },
    }),
    status: "active",
    enabled: true,
    dispatchHmacKey: DISPATCH_KEY,
    ...overrides,
  });
}

// ── the bot ──────────────────────────────────────────────────────────────────

const reach = { hasGuildReach: vi.fn(async () => false), isFeatureEnabledInGuild: vi.fn(async () => false) };
let ready = true;
const deps: PluginActionDeps = {
  dispatcher: createPluginDispatcher({
    reach,
    resolveReadyEndpoint: (_key, url) => (ready ? url : null),
  }),
  findPlugin: findPluginByKey,
  fileTimeoutMs: 5_000,
};

function fakeSlash() {
  const raw = {
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    id: "ix1",
    token: DISCORD_TOKEN,
    createdTimestamp: Date.now(),
    applicationId: "app1",
    commandName: "roll",
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
      data: [{ name: "sides", type: 4, value: 6 }] as unknown[],
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
    followUp: vi.fn(async (_o: unknown) => ({ id: "F1" })) as Mock,
    deleteReply: vi.fn(async () => {}) as Mock,
  };
  return raw;
}

function fakeDm() {
  const sent: unknown[] = [];
  const channel = {
    id: "D1",
    type: ChannelType.DM,
    send: vi.fn(async (body: unknown) => {
      sent.push(body);
      return { id: `S${sent.length}`, edit: vi.fn(), delete: vi.fn() };
    }),
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
    displayAvatarURL: () => "https://cdn.example/avatar.png",
    send: vi.fn(),
    createDM: vi.fn(async () => channel),
  };
  const message = {
    id: "M1",
    content: "!go 6",
    createdTimestamp: Date.now(),
    guild: null,
    guildId: null,
    channelId: "D1",
    channel,
    author,
  };
  return { message: message as unknown as Message, channel, sent };
}

const rest = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() };
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
  await Plugin.destroy({ where: {} });
  dispatched = [];
  pluginStatus = 204;
  afterAnswer = null;
  handled = Promise.resolve();
  ready = true;
  server = await createWebServer({ staticRoot: undefined, bot: fakeBot as never });
  await server.ready();
});

afterEach(async () => {
  await server.close();
});

/** The plugin's answer with the run's callback token, as the SDK's ctx.reply. */
function answerWith(path: string, payload: Record<string, unknown>) {
  afterAnswer = async (d) => {
    const { callback } = JSON.parse(d.body) as { callback: { token: string } };
    const res = await server.inject({
      method: "POST",
      url: `/api/plugin/${path}`,
      headers: { authorization: `Bearer ${callback.token}` },
      payload,
    });
    expect(res.statusCode).toBe(200);
  };
}

async function seedPluginLeaf(overrides: Record<string, unknown> = {}): Promise<number> {
  const id = await seedLeaf(await seedCommand({ name: "roll" }), { actionSource: "plugin", ...overrides }, null);
  await bindPluginAction(id, "dice", "roll");
  return id;
}

const dispatchCommand = (raw: ReturnType<typeof fakeSlash>) =>
  new InteractionDispatcher(new WebhookForwarder(), deps).dispatch(raw as unknown as Interaction);

// ── command trigger ──────────────────────────────────────────────────────────

describe("a command bound to a plugin action", () => {
  it("defers, dispatches a signed behavior_action, and the plugin's reply through the token lands", async () => {
    await seedPlugin();
    const id = await seedPluginLeaf({ replyVisibility: "public" });
    answerWith("interactions.respond", { content: "you rolled a 6" });
    const raw = fakeSlash();

    expect(await dispatchCommand(raw)).toMatchObject({ claimed: true, claimedBy: "behavior_custom" });
    await handled;

    expect(raw.deferReply).toHaveBeenCalledWith({});
    expect(dispatched).toHaveLength(1);
    const [d] = dispatched;
    expect(d!.path).toBe("/behavior-actions/roll");
    // signed with the plugin's dispatch key, over this path and body
    const check = verifyInboundSignature(DISPATCH_KEY, d!.headers, d!.body, Math.floor(Date.now() / 1000), "POST", "/behavior-actions/roll");
    expect(check.ok).toBe(true);
    expect(d!.body).not.toContain(DISCORD_TOKEN);

    const body = JSON.parse(d!.body) as Record<string, unknown>;
    const contract = CONTRACT_FIXTURES.dispatchEnvelope.payloads.behavior_action;
    for (const field of contract.requiredFields) expect(body).toHaveProperty(field);
    expect(Object.keys(body.user as object).sort()).toEqual([...contract.userFields].sort());
    expect(body).toMatchObject({
      action_key: "roll",
      behavior_id: id,
      interaction_id: "ix1",
      command_name: "roll",
      options: [{ name: "sides", type: 4, value: 6 }],
    });
    expect(body).not.toHaveProperty("_meta");

    // the reply came through the token and filled the public placeholder
    expect(raw.editReply).toHaveBeenCalledWith({ content: "you rolled a 6", allowedMentions: { parse: [] } });
    const [delivery] = await findRecentDeliveries(id);
    expect(delivery).toMatchObject({ via: "command", ok: true, deferred: true, errorCode: null, httpStatus: 204 });
    // the binding is the authorization: no reach was asked
    expect(reach.hasGuildReach).not.toHaveBeenCalled();
    expect(reach.isFeatureEnabledInGuild).not.toHaveBeenCalled();
  });

  it("sends a reply's attachments, downloaded from the plugin's own origin", async () => {
    await seedPlugin();
    await seedPluginLeaf();
    answerWith("interactions.respond", {
      content: "here",
      attachments: [{ name: "six.txt", path: "/files/six.txt" }],
    });
    const raw = fakeSlash();
    await dispatchCommand(raw);
    await handled;
    const [options] = raw.editReply.mock.calls.at(-1) as [{ files?: Array<{ name: string; attachment: Buffer }> }];
    expect(options.files).toHaveLength(1);
    expect(options.files![0]!.name).toBe("six.txt");
    expect(Buffer.from(options.files![0]!.attachment).equals(FILE_BYTES)).toBe(true);
  });

  it("an offline plugin gets nothing: the user sees the failure line, the delivery says plugin_unavailable", async () => {
    await seedPlugin({ enabled: false });
    const id = await seedPluginLeaf();
    const raw = fakeSlash();
    await dispatchCommand(raw);

    expect(dispatched).toHaveLength(0);
    expect(raw.editReply).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(raw.editReply.mock.calls[0])).not.toContain("roll");
    expect((await findRecentDeliveries(id))[0]).toMatchObject({ ok: false, errorCode: "plugin_unavailable" });
  });

  it("a plugin not ready, or not installed, is plugin_unavailable too", async () => {
    const id = await seedPluginLeaf();
    await dispatchCommand(fakeSlash());
    await seedPlugin();
    ready = false;
    await dispatchCommand(fakeSlash());
    expect(dispatched).toHaveLength(0);
    const deliveries = await findRecentDeliveries(id);
    expect(deliveries.map((d) => d.errorCode)).toEqual(["plugin_unavailable", "plugin_unavailable"]);
  });

  it("an action dropped from the manifest is action_undeclared, and nothing is dispatched", async () => {
    await seedPlugin({}, ["flip"]);
    const id = await seedPluginLeaf();
    const raw = fakeSlash();
    await dispatchCommand(raw);
    expect(dispatched).toHaveLength(0);
    expect(raw.editReply).toHaveBeenCalledTimes(1);
    expect((await findRecentDeliveries(id))[0]).toMatchObject({ ok: false, errorCode: "action_undeclared" });
  });

  it("a refused dispatch fails the run and revokes its token", async () => {
    await seedPlugin();
    const id = await seedPluginLeaf();
    pluginStatus = 503;
    const raw = fakeSlash();
    await dispatchCommand(raw);
    expect((await findRecentDeliveries(id))[0]).toMatchObject({ ok: false, errorCode: "http_error", httpStatus: 503 });
    expect(raw.editReply).toHaveBeenCalledTimes(1);
    const { callback } = JSON.parse(dispatched[0]!.body) as { callback: { token: string } };
    const late = await server.inject({
      method: "POST",
      url: "/api/plugin/interactions.respond",
      headers: { authorization: `Bearer ${callback.token}` },
      payload: { content: "too late" },
    });
    expect(late.statusCode).toBe(401);
  });
});

// ── message trigger ──────────────────────────────────────────────────────────

describe("a message trigger bound to a plugin action", () => {
  it("dispatches the message's _meta, and the plugin's reply lands in the DM", async () => {
    await seedPlugin();
    const id = await seedMessageTrigger({ actionSource: "plugin", patternValue: "!go" }, null);
    await bindPluginAction(id, "dice", "roll");
    answerWith("interactions.respond", { content: "rolled: 6" });
    const fake = fakeDm();

    const outcome = await new MessageTriggerMatcher(new WebhookForwarder(), deps).onMessage(fake.message);
    await handled;

    expect(outcome).toMatchObject({ handled: true, behaviorId: id });
    expect(dispatched).toHaveLength(1);
    const body = JSON.parse(dispatched[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ action_key: "roll", behavior_id: id, message_id: "M1", channel_id: "D1", guild_id: null, captures: [] });
    expect(body).toHaveProperty("callback.token");
    expect(fake.sent).toEqual([{ content: "rolled: 6", allowedMentions: { parse: [] } }]);
    expect((await findRecentDeliveries(id))[0]).toMatchObject({ via: "message", ok: true, deferred: true });
  });

  it("shows typing while the plugin has not answered yet", async () => {
    await seedPlugin();
    const id = await seedMessageTrigger({ actionSource: "plugin", patternValue: "!go" }, null);
    await bindPluginAction(id, "dice", "roll");
    const fake = fakeDm();
    await new MessageTriggerMatcher(new WebhookForwarder(), deps).onMessage(fake.message);
    expect(fake.channel.sendTyping).toHaveBeenCalledTimes(1);
    expect(fake.sent).toHaveLength(0);
  });

  it("tells the author when the plugin is offline", async () => {
    await seedPlugin({ status: "inactive" });
    const id = await seedMessageTrigger({ actionSource: "plugin", patternValue: "!go" }, null);
    await bindPluginAction(id, "dice", "roll");
    const fake = fakeDm();
    await new MessageTriggerMatcher(new WebhookForwarder(), deps).onMessage(fake.message);
    expect(dispatched).toHaveLength(0);
    expect(fake.sent).toHaveLength(1);
    expect((await findRecentDeliveries(id))[0]).toMatchObject({ via: "message", ok: false, errorCode: "plugin_unavailable" });
  });
});
