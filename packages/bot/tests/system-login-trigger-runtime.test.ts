/**
 * #139 — after the system login's trigger switch, the runtime follows it
 * at once (the catalog snapshot is invalidated by the write):
 *
 *   - on a command: `/login` is dispatched to the built-in login handler
 *     (issueLoginLinkForInteraction, which replies ephemerally) and a DM
 *     `!login` no longer fires
 *   - back on a message: `!login` fires again and `/login` is not claimed
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));
vi.mock("../src/modules/admin/admin-login.service.js", () => ({
  issueLoginLinkAndReply: vi.fn(async () => true),
  issueLoginLinkForInteraction: vi.fn(async () => true),
}));
vi.mock("../src/modules/plugin-system/plugin-interaction-dispatch.service.js", () => ({
  dispatchInteractionToPlugin: vi.fn(async () => false),
}));
vi.mock("../src/modules/builtin-features/in-process-command-registry.service.js", () => ({
  dispatchInProcessInteraction: vi.fn(async () => false),
  listInProcessCommandNames: vi.fn(() => []),
}));

import { ChannelType, type Client, type Interaction } from "discord.js";
import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import {
  issueLoginLinkAndReply,
  issueLoginLinkForInteraction,
} from "../src/modules/admin/admin-login.service.js";
import { CommandReconciler } from "../src/modules/command-system/reconcile.service.js";
import { CommandNamespace } from "../src/modules/command-system/command-namespace.js";
import { InteractionDispatcher } from "../src/modules/command-system/interaction-dispatcher.service.js";
import { MessageTriggerMatcher } from "../src/modules/command-system/message-trigger-matcher.service.js";
import type { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { getBehaviorCatalog } from "../src/modules/behavior/behavior-catalog.js";
import { clearBehaviors, seedSystemLogin } from "./behavior-fixtures.js";

class FakeCollection extends Map<string, { id: string; name: string }> {
  find(fn: (v: { id: string; name: string }) => boolean) {
    for (const v of this.values()) if (fn(v)) return v;
    return undefined;
  }
}
const store = new Map<string, { id: string; name: string }>();
const commands = {
  fetch: async () => new FakeCollection(store),
  create: async (data: { name: string }) => {
    const cmd = { id: `c${store.size + 1}`, name: data.name };
    store.set(cmd.id, cmd);
    return cmd;
  },
  edit: async () => undefined,
  delete: async (id: string) => {
    store.delete(id);
  },
};
const reconciler = new CommandReconciler(
  () => ({ application: { commands }, guilds: { cache: new Map() } }) as unknown as Client,
);

const forwarder = { forward: vi.fn() } as unknown as WebhookForwarder;
const matcher = new MessageTriggerMatcher(forwarder);
const dispatcher = new InteractionDispatcher(forwarder);
let server: FastifyInstance;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = "owner";
    request.authCapabilities = new Set(["admin"]) as never;
  });
  await registerBehaviorRoutes(server, { reconciler, namespace: new CommandNamespace() });
  await server.ready();
});

beforeEach(async () => {
  vi.clearAllMocks();
  store.clear();
  await clearBehaviors();
  await seedSystemLogin();
  // warm the snapshot, so the tests prove the switch invalidates it
  await getBehaviorCatalog();
});

function dm(content: string) {
  return {
    id: "M1",
    content,
    guildId: null,
    author: {
      id: "OWNER",
      bot: false,
      username: "owner",
      globalName: null,
      discriminator: "0",
      avatar: null,
      displayAvatarURL: () => "",
    },
    client: { user: { id: "BOT" } },
    channel: { id: "DM-OWNER", type: ChannelType.DM, send: vi.fn() },
  } as never;
}

function slash(commandName: string) {
  return {
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    commandName,
    commandGuildId: null,
    guildId: null,
    channelId: "DM-OWNER",
    user: { id: "OWNER" },
    options: { data: [], getSubcommand: () => null, getSubcommandGroup: () => null },
    reply: vi.fn(async () => {}),
  } as unknown as Interaction;
}

function switchTo(payload: Record<string, unknown>) {
  return server.inject({ method: "PUT", url: "/api/behaviors/system/login/trigger", payload });
}

const toCommand = {
  kind: "command",
  name: "login",
  description: "Get an admin login link",
  contexts: ["BotDM"],
  integrationTypes: ["guild_install"],
};

describe("the login follows its trigger", () => {
  it("on the default message trigger: !login fires, /login is not claimed", async () => {
    expect((await matcher.onMessage(dm("!login"))).handled).toBe(true);
    expect(issueLoginLinkAndReply).toHaveBeenCalledTimes(1);
    expect((await dispatcher.dispatch(slash("login"))).claimed).toBe(false);
  });

  it("switched to /login: the command runs the built-in login, !login stops firing", async () => {
    expect((await switchTo(toCommand)).statusCode).toBe(200);

    expect(await dispatcher.dispatch(slash("login"))).toEqual({
      claimed: true,
      claimedBy: "behavior_system",
    });
    expect(issueLoginLinkForInteraction).toHaveBeenCalledTimes(1);

    expect((await matcher.onMessage(dm("!login"))).handled).toBe(false);
    expect(issueLoginLinkAndReply).not.toHaveBeenCalled();
  });

  it("switched back to a message: !login fires again, /login is not claimed", async () => {
    await switchTo(toCommand);
    expect((await switchTo({ kind: "message", patternKind: "startswith", patternValue: "!login", sample: "!login" })).statusCode).toBe(200);

    expect((await matcher.onMessage(dm("!login"))).handled).toBe(true);
    expect(issueLoginLinkAndReply).toHaveBeenCalledTimes(1);
    expect((await dispatcher.dispatch(slash("login"))).claimed).toBe(false);
    expect(issueLoginLinkForInteraction).not.toHaveBeenCalled();
  });

  it("a refused switch leaves !login answering", async () => {
    const create = vi.spyOn(commands, "create").mockRejectedValueOnce(new Error("Missing Access"));
    expect((await switchTo(toCommand)).statusCode).toBe(502);
    create.mockRestore();
    expect((await matcher.onMessage(dm("!login"))).handled).toBe(true);
    expect((await dispatcher.dispatch(slash("login"))).claimed).toBe(false);
  });

  it("a changed pattern fires on the new text only", async () => {
    await switchTo({ kind: "message", patternKind: "startswith", patternValue: "!admin", sample: "!admin" });
    expect((await matcher.onMessage(dm("!login"))).handled).toBe(false);
    expect((await matcher.onMessage(dm("!admin"))).handled).toBe(true);
  });
});
