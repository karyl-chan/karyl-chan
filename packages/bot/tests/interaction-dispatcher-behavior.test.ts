/**
 * Slash dispatch of behaviors (ADR 0003).
 *
 *   - a Command is found by (commandName, registration target): its
 *     registration must be where Discord says the command is registered
 *     (`commandGuildId`), so a same-named command elsewhere is not claimed
 *   - the Command Leaf is picked by the invoked subcommand ('' = root leaf);
 *     a disabled leaf is not claimed
 *   - whoever can invoke the command may run it — no runtime audience /
 *     placement check; the action decides (login checks authorisation)
 *   - builtin action (the system login) → its handler; webhook → forwarder
 */
import { vi, describe, it, expect, beforeAll, beforeEach, type Mock } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
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
vi.mock("../src/modules/admin/admin-login.service.js", () => ({
  mintLoginLink: vi.fn(async () => ({
    ok: true,
    url: "https://admin.example/admin/auth?token=t",
    minutesUntilExpiry: 5,
    role: "owner",
  })),
}));

import { ApplicationCommandOptionType, MessageFlags, type Interaction } from "discord.js";
import { sequelize } from "../src/db.js";
import { BehaviorStat } from "../src/modules/behavior/models/behavior-stats.model.js";
import { InteractionDispatcher } from "../src/modules/command-system/interaction-dispatcher.service.js";
import { dispatchInteractionToPlugin } from "../src/modules/plugin-system/plugin-interaction-dispatch.service.js";
import { mintLoginLink } from "../src/modules/admin/admin-login.service.js";
import type { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import {
  clearBehaviors,
  seedCommand,
  seedLeaf,
} from "./behavior-fixtures.js";

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearBehaviors();
});

function makeForwarder(): { forward: Mock } {
  return { forward: vi.fn(async () => ({ ok: true, reply: { content: "hi" }, notes: [] })) };
}

function dispatcherWith(forwarder: { forward: Mock }): InteractionDispatcher {
  return new InteractionDispatcher(forwarder as unknown as WebhookForwarder);
}

function fakeSlash(opts: {
  commandName: string;
  userId?: string;
  subcommand?: string;
  guildId?: string | null;
  /** 指令註冊在哪個伺服器（全域指令為 null）—— Discord 的 commandGuildId */
  commandGuildId?: string | null;
  values?: Array<{ name: string; type: number; value: unknown }>;
}) {
  const reply = vi.fn(async () => {});
  const values = opts.values ?? [];
  const data = opts.subcommand
    ? [
        {
          name: opts.subcommand,
          type: ApplicationCommandOptionType.Subcommand,
          options: values,
        },
      ]
    : values;
  const interaction: Record<string, unknown> & { deferred: boolean; ephemeral: boolean | null } = {
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
    channelId: "C-any",
    locale: "en-US",
    user: {
      id: opts.userId ?? "U1",
      username: "tester",
      globalName: "Tester",
      discriminator: "0",
      avatar: null,
      displayAvatarURL: () => "https://cdn.example/avatar.png",
    },
    options: {
      data,
      getSubcommand: () => opts.subcommand ?? null,
      getSubcommandGroup: () => null,
    },
    deferred: false,
    replied: false,
    ephemeral: null as boolean | null,
    reply,
    // like discord.js: a deferral fixes the placeholder's visibility
    deferReply: vi.fn(async (o: { flags?: number }) => {
      interaction.deferred = true;
      interaction.ephemeral = ((o.flags ?? 0) & MessageFlags.Ephemeral) !== 0;
    }),
    editReply: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    deleteReply: vi.fn(async () => {}),
  };
  return { interaction: interaction as unknown as Interaction, reply, raw: interaction };
}

type Payload = {
  content: string;
  _meta: {
    behavior_id: number;
    command_name: string;
    options: Array<{ name: string; value: unknown }>;
    interaction_token?: string;
    sub_command_name: string | null;
    sub_command_group: string | null;
  };
};

const payloadOf = (forwarder: { forward: Mock }, call = 0) =>
  forwarder.forward.mock.calls[call][1] as Payload;

describe("root leaf", () => {
  it("forwards anyone's invocation to the leaf's webhook action", async () => {
    const commandId = await seedCommand({ name: "ping" });
    const leaf = await seedLeaf(commandId);
    const forwarder = makeForwarder();
    const { interaction } = fakeSlash({
      commandName: "ping",
      userId: "U9",
      values: [{ name: "q", type: 3, value: "hello" }],
    });

    const outcome = await dispatcherWith(forwarder).dispatch(interaction);

    expect(outcome).toEqual({ claimed: true, claimedBy: "behavior_custom" });
    expect(forwarder.forward.mock.calls[0][0]).toMatchObject({ behaviorId: leaf });
    const payload = payloadOf(forwarder);
    expect(payload.content).toBe("/ping");
    expect(payload._meta.behavior_id).toBe(leaf);
    expect(payload._meta.sub_command_name).toBeNull();
    expect(payload._meta.sub_command_group).toBeNull();
    expect(payload._meta.options).toEqual([{ name: "q", type: 3, value: "hello" }]);
    expect(payload._meta).not.toHaveProperty("interaction_token");
    expect((await BehaviorStat.findByPk(leaf))?.get("successCount")).toBe(1);
  });

  it("fills the private placeholder with the webhook's reply", async () => {
    const commandId = await seedCommand({ name: "ping" });
    await seedLeaf(commandId);
    const { interaction, raw } = fakeSlash({ commandName: "ping" });
    await dispatcherWith(makeForwarder()).dispatch(interaction);
    expect(raw.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(raw.editReply).toHaveBeenCalledWith({ content: "hi", allowedMentions: { parse: [] } });
    expect(raw.followUp).not.toHaveBeenCalled();
  });

  it("posts publicly when the webhook answers ephemeral:false", async () => {
    const commandId = await seedCommand({ name: "ping" });
    await seedLeaf(commandId);
    const forwarder = {
      forward: vi.fn(async () => ({ ok: true, reply: { content: "all", ephemeral: false }, notes: [] })),
    };
    const { interaction, raw } = fakeSlash({ commandName: "ping" });
    await dispatcherWith(forwarder).dispatch(interaction);
    expect(raw.followUp).toHaveBeenCalledWith({ content: "all", allowedMentions: { parse: [] } });
    expect(raw.deleteReply).toHaveBeenCalledTimes(1);
  });

  it("a failed webhook shows the invoker a generic message; the detail goes to stats only", async () => {
    const commandId = await seedCommand({ name: "ping" });
    const leaf = await seedLeaf(commandId);
    const forwarder = {
      forward: vi.fn(async () => ({
        ok: false,
        reply: {},
        notes: [],
        status: 500,
        error: "Traceback: db password=hunter2",
      })),
    };
    const { interaction, raw } = fakeSlash({ commandName: "ping" });
    await dispatcherWith(forwarder).dispatch(interaction);

    const shown = (raw.editReply as Mock).mock.calls[0][0] as { content: string };
    expect(shown.content).toBe("⚠ This couldn't be completed right now. Please try again later.");
    const stat = await BehaviorStat.findByPk(leaf);
    expect(stat?.get("failureCount")).toBe(1);
    expect(stat?.get("lastError")).toContain("hunter2");
  });

  it("a reply Discord refuses counts as a failure and still resolves the placeholder", async () => {
    const commandId = await seedCommand({ name: "ping" });
    const leaf = await seedLeaf(commandId);
    const { interaction, raw } = fakeSlash({ commandName: "ping" });
    (raw.editReply as Mock).mockRejectedValueOnce(new Error("Invalid Form Body"));
    await dispatcherWith(makeForwarder()).dispatch(interaction);

    expect(raw.editReply).toHaveBeenCalledTimes(2);
    expect(((raw.editReply as Mock).mock.calls[1][0] as { content: string }).content).toMatch(/couldn't be completed/);
    expect((await BehaviorStat.findByPk(leaf))?.get("lastError")).toMatch(/Invalid Form Body/);
  });

  it("a leaf stored 'public' defers in the open and fills it in place", async () => {
    const commandId = await seedCommand({ name: "ping" });
    await seedLeaf(commandId, { replyVisibility: "public" });
    const { interaction, raw } = fakeSlash({ commandName: "ping" });
    await dispatcherWith(makeForwarder()).dispatch(interaction);
    expect(raw.deferReply).toHaveBeenCalledWith({});
    expect(raw.editReply).toHaveBeenCalledWith({ content: "hi", allowedMentions: { parse: [] } });
    expect(raw.followUp).not.toHaveBeenCalled();
  });

  it("a failure under a public placeholder reaches only the invoker", async () => {
    const commandId = await seedCommand({ name: "ping" });
    await seedLeaf(commandId, { replyVisibility: "public" });
    const forwarder = {
      forward: vi.fn(async () => ({ ok: false, reply: {}, notes: [], error: "boom" })),
    };
    const { interaction, raw } = fakeSlash({ commandName: "ping" });
    await dispatcherWith(forwarder).dispatch(interaction);
    expect(raw.editReply).not.toHaveBeenCalled();
    const shown = (raw.followUp as Mock).mock.calls[0][0] as { content: string; flags: number };
    expect(shown.content).toMatch(/couldn't be completed/);
    expect(shown.flags & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral);
    expect(raw.deleteReply).toHaveBeenCalledTimes(1);
  });

  it("a disabled leaf is not claimed", async () => {
    const commandId = await seedCommand({ name: "ping" });
    await seedLeaf(commandId, { enabled: false });
    (dispatchInteractionToPlugin as Mock).mockResolvedValue(false);
    const forwarder = makeForwarder();
    const outcome = await dispatcherWith(forwarder).dispatch(
      fakeSlash({ commandName: "ping" }).interaction,
    );
    expect(outcome.claimed).toBe(false);
    expect(forwarder.forward).not.toHaveBeenCalled();
  });
});

describe("subcommands", () => {
  it("routes the invoked subcommand to its own leaf", async () => {
    const commandId = await seedCommand({ name: "nas" });
    await seedLeaf(commandId, { subcommand: "status", title: "status" });
    const wake = await seedLeaf(commandId, { subcommand: "wake", title: "wake" });
    const forwarder = makeForwarder();
    const { interaction } = fakeSlash({
      commandName: "nas",
      subcommand: "wake",
      values: [{ name: "host", type: 3, value: "box" }],
    });

    await dispatcherWith(forwarder).dispatch(interaction);

    expect(forwarder.forward).toHaveBeenCalledTimes(1);
    expect(forwarder.forward.mock.calls[0][0]).toMatchObject({ behaviorId: wake });
    const payload = payloadOf(forwarder);
    expect(payload.content).toBe("/nas wake");
    expect(payload._meta.options).toEqual([{ name: "host", type: 3, value: "box" }]);
    // the invoked path, structured like the plugin command payload (#140)
    expect(payload._meta.sub_command_name).toBe("wake");
    expect(payload._meta.sub_command_group).toBeNull();
  });
});

describe("registration target", () => {
  it("a guild command only answers the command registered in its guild", async () => {
    const commandId = await seedCommand({
      name: "foo",
      registration: "guild",
      guildId: "G1",
    });
    const leaf = await seedLeaf(commandId);
    (dispatchInteractionToPlugin as Mock).mockResolvedValue(true);
    const forwarder = makeForwarder();
    const d = dispatcherWith(forwarder);

    const other = fakeSlash({ commandName: "foo", guildId: "G2", commandGuildId: "G2" });
    expect(await d.dispatch(other.interaction)).toEqual({
      claimed: true,
      claimedBy: "plugin_command",
    });
    expect(forwarder.forward).not.toHaveBeenCalled();

    const own = fakeSlash({ commandName: "foo", guildId: "G1", commandGuildId: "G1" });
    expect(await d.dispatch(own.interaction)).toEqual({
      claimed: true,
      claimedBy: "behavior_custom",
    });
    expect(payloadOf(forwarder)._meta.behavior_id).toBe(leaf);
  });

  it("a global command does not claim a same-named guild command", async () => {
    const commandId = await seedCommand({ name: "foo" });
    await seedLeaf(commandId);
    (dispatchInteractionToPlugin as Mock).mockResolvedValue(true);
    const forwarder = makeForwarder();
    const outcome = await dispatcherWith(forwarder).dispatch(
      fakeSlash({ commandName: "foo", guildId: "G1", commandGuildId: "G1" }).interaction,
    );
    expect(outcome).toEqual({ claimed: true, claimedBy: "plugin_command" });
    expect(forwarder.forward).not.toHaveBeenCalled();
  });
});

describe("the system login on a command", () => {
  it("runs the built-in login action", async () => {
    const commandId = await seedCommand({
      name: "login",
      isSystem: true,
      contexts: "BotDM",
      integrationTypes: "guild_install,user_install",
    });
    await seedLeaf(commandId, { systemKey: "admin-login", actionSource: "builtin" });
    const forwarder = makeForwarder();
    const { interaction, reply } = fakeSlash({ commandName: "login", userId: "OWNER" });

    const outcome = await dispatcherWith(forwarder).dispatch(interaction);

    expect(outcome).toEqual({ claimed: true, claimedBy: "behavior_system" });
    expect(mintLoginLink).toHaveBeenCalledWith("OWNER", expect.objectContaining({ messageId: null }));
    expect(forwarder.forward).not.toHaveBeenCalled();
    // the same reply model as a webhook: an embed and a link button, and
    // only the invoker sees it
    const sent = (reply as Mock).mock.calls[0][0] as {
      embeds: unknown[];
      components: Array<{ components: Array<{ url: string }> }>;
      flags: number;
    };
    expect(sent.embeds).toHaveLength(1);
    expect(sent.components[0].components[0].url).toBe("https://admin.example/admin/auth?token=t");
    expect(sent.flags & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral);
  });

  it("tells an unauthorised invoker so, privately", async () => {
    const commandId = await seedCommand({
      name: "login",
      isSystem: true,
      contexts: "BotDM",
      integrationTypes: "guild_install,user_install",
    });
    await seedLeaf(commandId, { systemKey: "admin-login", actionSource: "builtin" });
    (mintLoginLink as Mock).mockResolvedValueOnce({ ok: false, reason: "not authorized" });
    const { interaction, reply } = fakeSlash({ commandName: "login" });

    await dispatcherWith(makeForwarder()).dispatch(interaction);

    const sent = (reply as Mock).mock.calls[0][0] as { content: string; components?: unknown; flags: number };
    expect(sent.content).toMatch(/授權/);
    expect(sent.components).toBeUndefined();
    expect(sent.flags & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral);
  });
});
