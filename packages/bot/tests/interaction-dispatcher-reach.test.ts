/**
 * BH-0.1 — slash dispatch reach enforcement (audience + placement).
 *
 * The behavior layer used to claim a slash command on (name, enabled) alone:
 * a behavior on a specific_user / specific_group / specific_channel tab could
 * be invoked by anyone who could see the command. Discord-side registration
 * only controls visibility down to guild granularity, so the dispatcher must
 * enforce audience/placement itself — exactly like the DM pattern path does
 * via collectApplicableBehaviorsForUser.
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
import { addAudienceMember } from "../src/modules/behavior/models/behavior-audience-member.model.js";
import { InteractionDispatcher } from "../src/modules/command-system/interaction-dispatcher.service.js";
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

describe("InteractionDispatcher — behavior reach enforcement", () => {
  it("audience=all forwards for anyone (regression)", async () => {
    await seedCustomSlash({});
    const forwarder = makeForwarder();
    const d = new InteractionDispatcher(forwarder as unknown as WebhookForwarder);
    const { interaction } = fakeSlash({ commandName: "reachtest", userId: "U9" });
    const outcome = await d.dispatch(interaction);
    expect(outcome).toEqual({ claimed: true, claimedBy: "behavior_custom" });
    expect(forwarder.forward).toHaveBeenCalledTimes(1);
  });

  it("audience=user denies a different invoker without forwarding", async () => {
    await seedCustomSlash({ audienceKind: "user", audienceUserId: "U1" });
    const forwarder = makeForwarder();
    const d = new InteractionDispatcher(forwarder as unknown as WebhookForwarder);
    const { interaction, reply } = fakeSlash({
      commandName: "reachtest",
      userId: "U2",
    });
    const outcome = await d.dispatch(interaction);
    expect(outcome.claimed).toBe(true);
    expect(forwarder.forward).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    const arg = (reply.mock.calls[0] as unknown[])[0] as {
      content: string;
      ephemeral: boolean;
    };
    expect(arg.ephemeral).toBe(true);
    expect(arg.content).toContain("access");
  });

  it("audience=user forwards for the target user", async () => {
    await seedCustomSlash({ audienceKind: "user", audienceUserId: "U1" });
    const forwarder = makeForwarder();
    const d = new InteractionDispatcher(forwarder as unknown as WebhookForwarder);
    const { interaction } = fakeSlash({ commandName: "reachtest", userId: "U1" });
    await d.dispatch(interaction);
    expect(forwarder.forward).toHaveBeenCalledTimes(1);
  });

  it("audience=group forwards members and denies non-members", async () => {
    const id = await seedCustomSlash({
      audienceKind: "group",
      audienceGroupName: "vip",
    });
    await addAudienceMember(id, "M1");

    const forwarder = makeForwarder();
    const d = new InteractionDispatcher(forwarder as unknown as WebhookForwarder);

    const member = fakeSlash({ commandName: "reachtest", userId: "M1" });
    await d.dispatch(member.interaction);
    expect(forwarder.forward).toHaveBeenCalledTimes(1);

    const outsider = fakeSlash({ commandName: "reachtest", userId: "M2" });
    const outcome = await d.dispatch(outsider.interaction);
    expect(outcome.claimed).toBe(true);
    expect(forwarder.forward).toHaveBeenCalledTimes(1); // unchanged
    expect(outsider.reply).toHaveBeenCalledTimes(1);
  });

  it("placement guild/channel mismatch denies with a wrong-place message", async () => {
    await seedCustomSlash({
      scope: "guild",
      integrationTypes: "guild_install",
      contexts: "Guild",
      placementGuildId: "G1",
      placementChannelId: "C1",
    });
    const forwarder = makeForwarder();
    const d = new InteractionDispatcher(forwarder as unknown as WebhookForwarder);

    const wrongGuild = fakeSlash({
      commandName: "reachtest",
      userId: "U1",
      guildId: "G2",
      channelId: "C1",
    });
    await d.dispatch(wrongGuild.interaction);
    expect(forwarder.forward).not.toHaveBeenCalled();
    const arg1 = (wrongGuild.reply.mock.calls[0] as unknown[])[0] as {
      content: string;
    };
    expect(arg1.content).toContain("available");

    const wrongChannel = fakeSlash({
      commandName: "reachtest",
      userId: "U1",
      guildId: "G1",
      channelId: "C9",
    });
    await d.dispatch(wrongChannel.interaction);
    expect(forwarder.forward).not.toHaveBeenCalled();

    const right = fakeSlash({
      commandName: "reachtest",
      userId: "U1",
      guildId: "G1",
      channelId: "C1",
    });
    await d.dispatch(right.interaction);
    expect(forwarder.forward).toHaveBeenCalledTimes(1);
  });
});
