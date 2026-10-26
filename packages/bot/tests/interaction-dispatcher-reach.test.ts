/**
 * Slash dispatch of behaviors.
 *
 * ADR 0003: who sees a command and where it can be used is Discord's (and
 * the guild admins') call — whoever can invoke it may run it. The
 * dispatcher no longer applies a runtime audience / placement check; the
 * action decides whether to serve the invoker (e.g. login checks
 * authorisation).
 */
import { vi, describe, it, expect, beforeAll, beforeEach, type Mock } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

vi.mock(
  "../src/modules/plugin-system/plugin-interaction-dispatch.service.js",
  () => ({ dispatchInteractionToPlugin: vi.fn() }),
);
vi.mock(
  "../src/modules/plugin-system/plugin-component-dispatch.service.js",
  () => ({ dispatchComponentToPlugin: vi.fn() }),
);
vi.mock("../src/modules/plugin-system/plugin-modal-dispatch.service.js", () => ({
  dispatchModalToPlugin: vi.fn(),
}));
vi.mock(
  "../src/modules/builtin-features/in-process-command-registry.service.js",
  () => ({ dispatchInProcessInteraction: vi.fn() }),
);
vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import type { Interaction } from "discord.js";
import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { InteractionDispatcher } from "../src/modules/command-system/interaction-dispatcher.service.js";
import { dispatchInteractionToPlugin } from "../src/modules/plugin-system/plugin-interaction-dispatch.service.js";
import type { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await Behavior.destroy({ where: {} });
});

function makeForwarder(): { forward: Mock } {
  return {
    forward: vi.fn(async () => ({ ok: true, ended: false, relayContent: "hi" })),
  };
}

function fakeSlash(opts: {
  commandName: string;
  userId: string;
  guildId?: string | null;
  channelId?: string | null;
  /** 指令註冊在哪個伺服器（全域指令為 null）—— Discord 的 commandGuildId */
  commandGuildId?: string | null;
}) {
  const reply = vi.fn(async () => {});
  const deferReply = vi.fn(async () => {});
  const editReply = vi.fn(async () => {});
  const deleteReply = vi.fn(async () => {});
  const interaction = {
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    id: "ix1",
    token: "tok",
    applicationId: "app1",
    commandName: opts.commandName,
    commandGuildId: opts.commandGuildId ?? null,
    guildId: opts.guildId ?? null,
    channelId: opts.channelId ?? "C-any",
    locale: "en-US",
    user: {
      id: opts.userId,
      username: "tester",
      globalName: "Tester",
      discriminator: "0",
      avatar: null,
      displayAvatarURL: () => "https://cdn.example/avatar.png",
      createDM: async () => ({ id: "DM1" }),
    },
    options: { data: [] },
    reply,
    deferReply,
    editReply,
    deleteReply,
  } as unknown as Interaction;
  return { interaction, reply, deferReply };
}

async function seedCustomSlash(
  overrides: Record<string, unknown>,
): Promise<number> {
  const row = await Behavior.create({
    title: "reach test",
    enabled: true,
    sortOrder: 0,
    stopOnMatch: false,
    forwardType: "one_time",
    source: "custom",
    triggerType: "slash_command",
    slashCommandName: "reachtest",
    messagePatternKind: null,
    messagePatternValue: null,
    scope: "global",
    integrationTypes: "guild_install,user_install",
    contexts: "BotDM,Guild,PrivateChannel",
    audienceKind: "all",
    audienceUserId: null,
    audienceGroupName: null,
    placementGuildId: null,
    placementChannelId: null,
    webhookUrl: "https://hooks.example/behavior",
    webhookSecret: null,
    webhookAuthMode: null,
    systemKey: null,
    scopeTabId: 1,
    ...overrides,
  } as Record<string, unknown>);
  return row.getDataValue("id") as number;
}

describe("InteractionDispatcher — Discord owns command visibility (ADR 0003)", () => {
  it("forwards for anyone who can invoke the command", async () => {
    await seedCustomSlash({});
    const forwarder = makeForwarder();
    const d = new InteractionDispatcher(forwarder as unknown as WebhookForwarder);
    const { interaction } = fakeSlash({ commandName: "reachtest", userId: "U9" });
    const outcome = await d.dispatch(interaction);
    expect(outcome).toEqual({ claimed: true, claimedBy: "behavior_custom" });
    expect(forwarder.forward).toHaveBeenCalledTimes(1);
  });

  it("does not refuse an invoker outside a legacy audience", async () => {
    await seedCustomSlash({ audienceKind: "user", audienceUserId: "U1" });
    const forwarder = makeForwarder();
    const d = new InteractionDispatcher(forwarder as unknown as WebhookForwarder);
    const { interaction, reply } = fakeSlash({
      commandName: "reachtest",
      userId: "U2",
    });
    const outcome = await d.dispatch(interaction);
    expect(outcome).toEqual({ claimed: true, claimedBy: "behavior_custom" });
    expect(forwarder.forward).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it("does not refuse an invocation outside a legacy placement channel", async () => {
    await seedCustomSlash({
      scope: "guild",
      integrationTypes: "guild_install",
      contexts: "Guild",
      placementGuildId: "G1",
      placementChannelId: "C1",
    });
    const forwarder = makeForwarder();
    const d = new InteractionDispatcher(forwarder as unknown as WebhookForwarder);
    const otherChannel = fakeSlash({
      commandName: "reachtest",
      userId: "U1",
      guildId: "G1",
      channelId: "C9",
      commandGuildId: "G1",
    });
    await d.dispatch(otherChannel.interaction);
    expect(forwarder.forward).toHaveBeenCalledTimes(1);
    expect(otherChannel.reply).not.toHaveBeenCalled();
  });
});

describe("InteractionDispatcher — matches behaviors by (commandName, commandGuildId)", () => {
  it("a specific-guild behavior only answers the command registered in its guild", async () => {
    // （兩個指定伺服器的 behavior 同名在命名空間上合法，但舊的
    //   behaviors_slash_uq 索引仍擋著，S3 換資料表時移除。）
    const id = await seedCustomSlash({
      scope: "guild",
      integrationTypes: "guild_install",
      contexts: "Guild",
      placementGuildId: "G1",
    });
    (dispatchInteractionToPlugin as Mock).mockResolvedValue(true);
    const forwarder = makeForwarder();
    const d = new InteractionDispatcher(forwarder as unknown as WebhookForwarder);

    // G2 的同名指令（例如 plugin 的）不歸這條 behavior
    const other = fakeSlash({
      commandName: "reachtest",
      userId: "U1",
      guildId: "G2",
      commandGuildId: "G2",
    });
    expect(await d.dispatch(other.interaction)).toEqual({
      claimed: true,
      claimedBy: "plugin_command",
    });
    expect(forwarder.forward).not.toHaveBeenCalled();

    const own = fakeSlash({
      commandName: "reachtest",
      userId: "U1",
      guildId: "G1",
      commandGuildId: "G1",
    });
    expect(await d.dispatch(own.interaction)).toEqual({
      claimed: true,
      claimedBy: "behavior_custom",
    });
    const payload = (forwarder.forward.mock.calls[0] as unknown[])[1] as {
      _meta: { behavior_id: number };
    };
    expect(payload._meta.behavior_id).toBe(id);
  });

  it("a global behavior does not claim a same-named guild command (e.g. a plugin's)", async () => {
    await seedCustomSlash({});
    (dispatchInteractionToPlugin as Mock).mockResolvedValue(true);
    const forwarder = makeForwarder();
    const d = new InteractionDispatcher(forwarder as unknown as WebhookForwarder);

    const { interaction } = fakeSlash({
      commandName: "reachtest",
      userId: "U1",
      guildId: "G1",
      commandGuildId: "G1",
    });
    const outcome = await d.dispatch(interaction);

    expect(outcome).toEqual({ claimed: true, claimedBy: "plugin_command" });
    expect(forwarder.forward).not.toHaveBeenCalled();
  });

  it("an all-guilds behavior answers its command in any guild", async () => {
    await seedCustomSlash({
      scope: "guild",
      integrationTypes: "guild_install",
      contexts: "Guild",
    });
    const forwarder = makeForwarder();
    const d = new InteractionDispatcher(forwarder as unknown as WebhookForwarder);

    const { interaction } = fakeSlash({
      commandName: "reachtest",
      userId: "U1",
      guildId: "G7",
      commandGuildId: "G7",
    });
    await d.dispatch(interaction);

    expect(forwarder.forward).toHaveBeenCalledTimes(1);
  });
});
