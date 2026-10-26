/**
 * S2 (#133)：behavior 層與 plugin 層都以註冊目標比對 interaction。
 *
 * commandGuildId 有值（伺服器指令）→ 只有目標涵蓋該伺服器的候選
 * （guild:<id> 或 all_guilds）能認領；為 null（全域指令）→ 只有 global
 * 候選能認領。同名但註冊在別處的指令不能搶走不屬於它的呼叫。
 *
 * 場景：behavior guild:G /foo、plugin P1 的軌三全域 /foo、plugin P2 的
 * 軌三 scope=guild（all_guilds）/foo。plugin 層走真正的
 * dispatchInteractionToPlugin：P1 停用（回「離線」）、P2 啟用但沒有就緒
 * 端點（回「初始化中」），由回覆內容分辨是哪一列認領。
 */
import { vi, describe, it, expect, beforeAll, beforeEach, type Mock } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock(
  "../src/modules/plugin-system/plugin-component-dispatch.service.js",
  () => ({ dispatchComponentToPlugin: vi.fn() }),
);
vi.mock("../src/modules/plugin-system/plugin-modal-dispatch.service.js", () => ({
  dispatchModalToPlugin: vi.fn(),
}));
vi.mock(
  "../src/modules/builtin-features/in-process-command-registry.service.js",
  () => ({ dispatchInProcessInteraction: vi.fn(async () => false) }),
);
vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import type { Interaction } from "discord.js";
import { sequelize } from "../src/db.js";
import { clearBehaviors, seedCommand, seedLeaf } from "./behavior-fixtures.js";
import { Plugin } from "../src/modules/plugin-system/models/plugin.model.js";
import {
  PluginCommand,
  findPluginCommandForInvocation,
} from "../src/modules/plugin-system/models/plugin-command.model.js";
import { botEventLog } from "../src/modules/bot-events/bot-event-log.js";
import { InteractionDispatcher } from "../src/modules/command-system/interaction-dispatcher.service.js";
import type { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";

const OFFLINE = "離線"; // P1（全域 /foo）認領時的回覆
const NOT_READY = "初始化"; // P2（all_guilds /foo）認領時的回覆

function fakeSlash(commandGuildId: string | null) {
  const reply = vi.fn(async () => {});
  const interaction = {
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    id: "ix1",
    token: "tok",
    applicationId: "app1",
    commandName: "foo",
    commandGuildId,
    guildId: commandGuildId ?? "G-any",
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
      data: [],
      getSubcommand: () => null,
      getSubcommandGroup: () => null,
    },
    reply,
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    deleteReply: vi.fn(async () => {}),
  } as unknown as Interaction;
  return { interaction, reply };
}

function replyText(reply: Mock): string {
  const arg = (reply.mock.calls[0] as unknown[] | undefined)?.[0] as
    | { content?: string }
    | undefined;
  return arg?.content ?? "";
}

async function seedPlugin(
  key: string,
  enabled: boolean,
  cmdScope: "global" | "guild",
): Promise<void> {
  const plugin = await Plugin.create({
    pluginKey: key,
    name: key,
    version: "1.0.0",
    url: `http://${key}.invalid`,
    enabled,
    status: "active",
    manifestJson: JSON.stringify({ schema_version: "1" }),
  } as Record<string, unknown>);
  await PluginCommand.create({
    pluginId: plugin.getDataValue("id"),
    guildId: null,
    name: "foo",
    featureKey: null,
    manifestJson: JSON.stringify({
      name: "foo",
      description: "foo",
      scope: cmdScope,
      integration_types: ["guild_install"],
      contexts: ["Guild"],
    }),
  } as Record<string, unknown>);
}

async function seedGuildBehavior(guildId: string): Promise<void> {
  const commandId = await seedCommand({
    name: "foo",
    description: "foo",
    registration: "guild",
    guildId,
  });
  await seedLeaf(commandId, { title: "foo" });
}

function makeDispatcher() {
  const forwarder = {
    forward: vi.fn(async () => ({ ok: true, reply: { content: "hi" }, notes: [] })),
  };
  return {
    forwarder,
    d: new InteractionDispatcher(forwarder as unknown as WebhookForwarder),
  };
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearBehaviors();
  await PluginCommand.destroy({ where: {} });
  await Plugin.destroy({ where: {} });
  await seedGuildBehavior("G");
  await seedPlugin("p1-global", false, "global");
  await seedPlugin("p2-all-guilds", true, "guild");
});

describe("dispatch matches the registration target in both layers", () => {
  it("the guild:G behavior's /foo reaches the behavior, not a same-named plugin command", async () => {
    const { d, forwarder } = makeDispatcher();
    const { interaction } = fakeSlash("G");

    const outcome = await d.dispatch(interaction);

    expect(outcome).toEqual({ claimed: true, claimedBy: "behavior_custom" });
    expect(forwarder.forward).toHaveBeenCalledTimes(1);
  });

  it("a global /foo reaches only the global plugin row (not the guild-scope one, not the behavior)", async () => {
    const { d, forwarder } = makeDispatcher();
    const { interaction, reply } = fakeSlash(null);

    const outcome = await d.dispatch(interaction);

    expect(outcome).toEqual({ claimed: true, claimedBy: "plugin_command" });
    expect(forwarder.forward).not.toHaveBeenCalled();
    expect(replyText(reply)).toContain(OFFLINE);
  });

  it("another guild's /foo reaches only the all_guilds plugin row (not the global one)", async () => {
    const { d, forwarder } = makeDispatcher();
    const { interaction, reply } = fakeSlash("H");

    const outcome = await d.dispatch(interaction);

    expect(outcome).toEqual({ claimed: true, claimedBy: "plugin_command" });
    expect(forwarder.forward).not.toHaveBeenCalled();
    expect(replyText(reply)).toContain(NOT_READY);
  });

  it("with no all_guilds candidate, a guild /foo is not claimed by the global plugin row", async () => {
    await PluginCommand.destroy({ where: {} });
    await Plugin.destroy({ where: { pluginKey: "p2-all-guilds" } });
    await seedPlugin("p1b-global", false, "global");
    const { d } = makeDispatcher();
    const { interaction, reply } = fakeSlash("H");

    const outcome = await d.dispatch(interaction);

    expect(outcome.claimed).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });
});

describe("findPluginCommandForInvocation — ambiguous guild match", () => {
  it("prefers the guild's feature row over an all_guilds row and warns about the clash", async () => {
    await PluginCommand.create({
      pluginId: 99,
      guildId: "H",
      name: "foo",
      featureKey: "feat",
      manifestJson: JSON.stringify({ name: "foo" }),
    } as Record<string, unknown>);

    const row = await findPluginCommandForInvocation("foo", "H");

    expect(row?.featureKey).toBe("feat");
    expect(botEventLog.record).toHaveBeenCalledWith(
      "warn",
      "bot",
      expect.stringContaining("foo"),
      expect.anything(),
    );
  });

  it("does not warn when exactly one row matches", async () => {
    const row = await findPluginCommandForInvocation("foo", null);

    expect(row?.guildId).toBeNull();
    expect(botEventLog.record).not.toHaveBeenCalled();
  });
});
