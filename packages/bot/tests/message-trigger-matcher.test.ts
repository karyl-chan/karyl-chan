/**
 * MessageTriggerMatcher on Message Triggers (ADR 0003).
 *
 *   - bot DM triggers fire in DMs with the bot; audience (all / user /
 *     group) filters only there
 *   - guild triggers fire in guild channels: all guilds, one guild, or one
 *     channel; ignoreBots skips bot authors; the bot's own messages never
 *     fire anything
 *   - triggers are walked in sortOrder; stopOnMatch stops the walk; the
 *     system login answers with its built-in action and always stops
 *   - triggers come from an in-memory snapshot that a write invalidates
 */
import { vi, describe, it, expect, beforeAll, beforeEach, type Mock } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

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

import { ChannelType } from "discord.js";
import { sequelize } from "../src/db.js";
import { BehaviorDefinition } from "../src/modules/behavior/models/behavior-definition.model.js";
import { addGroupMember } from "../src/modules/behavior/models/behavior-group-member.model.js";
import { BehaviorStat } from "../src/modules/behavior/models/behavior-stats.model.js";
import { mintLoginLink } from "../src/modules/admin/admin-login.service.js";
import {
  MessageTriggerMatcher,
  __resetGuildForwardWindowsForTests,
} from "../src/modules/command-system/message-trigger-matcher.service.js";
import type { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import {
  clearBehaviors,
  seedMessageTrigger,
  seedSystemLogin,
} from "./behavior-fixtures.js";

const BOT_ID = "BOT-SELF";

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  __resetGuildForwardWindowsForTests();
  await clearBehaviors();
});

function makeForwarder(relay = ""): { forward: Mock } {
  return { forward: vi.fn(async () => ({ ok: true, reply: relay ? { content: relay } : {}, notes: [] })) };
}

function matcherWith(forwarder: { forward: Mock }): MessageTriggerMatcher {
  return new MessageTriggerMatcher(forwarder as unknown as WebhookForwarder);
}

/** ids of the behaviors the forwarder was called for, in order */
function forwardedIds(forwarder: { forward: Mock }): number[] {
  return forwarder.forward.mock.calls.map(
    (c) => (c[0] as { behaviorId: number }).behaviorId,
  );
}

function guildMsg(opts: {
  userId?: string;
  content: string;
  guildId?: string;
  channelId?: string;
  bot?: boolean;
}) {
  const send = vi.fn(async () => {});
  const message = {
    id: "MSG-G",
    content: opts.content,
    guildId: opts.guildId ?? "G1",
    author: {
      id: opts.userId ?? "U1",
      bot: opts.bot ?? false,
      username: "guilder",
      globalName: null,
      discriminator: "0",
      avatar: null,
      displayAvatarURL: () => "https://cdn.example/a.png",
    },
    client: { user: { id: BOT_ID } },
    channel: { id: opts.channelId ?? "C1", type: ChannelType.GuildText, send },
  } as never;
  return { message, send };
}

function dmMsg(userId: string, content: string) {
  const send = vi.fn(async () => {});
  const message = {
    id: "MSG-1",
    content,
    guildId: null,
    author: {
      id: userId,
      bot: false,
      username: "tester",
      globalName: "Tester G",
      discriminator: "0",
      avatar: null,
      displayAvatarURL: () => "https://cdn.example/a.png",
    },
    attachments: new Map([
      ["a1", { url: "https://cdn.example/f.png", name: "f.png", contentType: "image/png", size: 10 }],
    ]),
    client: { user: { id: BOT_ID } },
    channel: { id: `DM-${userId}`, type: ChannelType.DM, send },
  } as never;
  return { message, send };
}

describe("bot DM triggers", () => {
  it("fire in DMs, forward the message and relay the reply", async () => {
    const id = await seedMessageTrigger();
    const forwarder = makeForwarder("pong");
    const { message, send } = dmMsg("U1", "!go hello");
    const outcome = await matcherWith(forwarder).onMessage(message);

    expect(outcome).toEqual({ handled: true, behaviorId: id });
    expect(forwardedIds(forwarder)).toEqual([id]);
    const payload = forwarder.forward.mock.calls[0][1] as {
      content: string;
      username: string;
      _meta: Record<string, unknown> & { user: { id: string; global_name: string } };
    };
    expect(payload.content).toBe("!go hello");
    expect(payload.username).toBe("tester");
    expect(payload._meta.user.id).toBe("U1");
    expect(payload._meta.user.global_name).toBe("Tester G");
    expect(payload._meta.message_id).toBe("MSG-1");
    expect(payload._meta.channel_id).toBe("DM-U1");
    expect(payload._meta.behavior_id).toBe(id);
    expect(payload._meta.attachments).toEqual([
      { url: "https://cdn.example/f.png", filename: "f.png", content_type: "image/png", size: 10 },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await BehaviorStat.findByPk(id))?.get("successCount")).toBe(1);
  });

  it("do not fire in guild channels", async () => {
    await seedMessageTrigger();
    const forwarder = makeForwarder();
    await matcherWith(forwarder).onMessage(guildMsg({ content: "!go" }).message);
    expect(forwarder.forward).not.toHaveBeenCalled();
  });

  it("filter by audience user and group", async () => {
    const forUser = await seedMessageTrigger({ audienceKind: "user", audienceUserId: "U1" });
    const forGroup = await seedMessageTrigger({
      sortOrder: 1,
      audienceKind: "group",
      audienceGroupName: "vip",
    });
    await addGroupMember("vip", "U2");
    const forwarder = makeForwarder();
    const m = matcherWith(forwarder);

    await m.onMessage(dmMsg("U1", "!go").message);
    await m.onMessage(dmMsg("U2", "!go").message);
    await m.onMessage(dmMsg("U3", "!go").message);
    expect(forwardedIds(forwarder)).toEqual([forUser, forGroup]);
  });

  it("disabled triggers do not fire", async () => {
    await seedMessageTrigger({ enabled: false });
    const forwarder = makeForwarder();
    const outcome = await matcherWith(forwarder).onMessage(dmMsg("U1", "!go").message);
    expect(outcome).toEqual({ handled: false });
    expect(forwarder.forward).not.toHaveBeenCalled();
  });

  it("ignore messages from bots", async () => {
    await seedMessageTrigger();
    const forwarder = makeForwarder();
    const { message } = dmMsg("U1", "!go");
    (message as { author: { bot: boolean } }).author.bot = true;
    await matcherWith(forwarder).onMessage(message);
    expect(forwarder.forward).not.toHaveBeenCalled();
  });
});

describe("guild triggers", () => {
  it("fire in every guild when no guild is set, and relay in the channel", async () => {
    const id = await seedMessageTrigger({ surface: "guild" });
    const forwarder = makeForwarder("roger");
    const m = matcherWith(forwarder);
    const first = guildMsg({ content: "!go", guildId: "G1" });
    await m.onMessage(first.message);
    await m.onMessage(guildMsg({ content: "!go", guildId: "G2" }).message);
    expect(forwardedIds(forwarder)).toEqual([id, id]);
    expect(first.send).toHaveBeenCalledTimes(1);
  });

  it("do not fire in DMs", async () => {
    await seedMessageTrigger({ surface: "guild" });
    const forwarder = makeForwarder();
    await matcherWith(forwarder).onMessage(dmMsg("U1", "!go").message);
    expect(forwarder.forward).not.toHaveBeenCalled();
  });

  it("filter by guild and channel", async () => {
    const inGuild = await seedMessageTrigger({ surface: "guild", guildId: "G1" });
    const inChannel = await seedMessageTrigger({
      sortOrder: 1,
      surface: "guild",
      guildId: "G1",
      channelId: "C1",
    });
    const forwarder = makeForwarder();
    const m = matcherWith(forwarder);

    await m.onMessage(guildMsg({ content: "!go", guildId: "G1", channelId: "C1" }).message);
    expect(forwardedIds(forwarder)).toEqual([inGuild, inChannel]);
    forwarder.forward.mockClear();
    await m.onMessage(guildMsg({ content: "!go", guildId: "G1", channelId: "C9" }).message);
    expect(forwardedIds(forwarder)).toEqual([inGuild]);
    forwarder.forward.mockClear();
    await m.onMessage(guildMsg({ content: "!go", guildId: "G9", channelId: "C1" }).message);
    expect(forwarder.forward).not.toHaveBeenCalled();
  });

  it("ignoreBots skips bot authors; off lets them through; the bot itself never fires", async () => {
    const skipsBots = await seedMessageTrigger({ surface: "guild" });
    const forwarder = makeForwarder();
    const m = matcherWith(forwarder);

    await m.onMessage(guildMsg({ userId: "OTHER-BOT", content: "!go", bot: true }).message);
    expect(forwarder.forward).not.toHaveBeenCalled();

    const row = await BehaviorDefinition.findByPk(skipsBots);
    await row!.update({ ignoreBots: false });
    await m.onMessage(guildMsg({ userId: "OTHER-BOT", content: "!go", bot: true }).message);
    expect(forwarder.forward).toHaveBeenCalledTimes(1);

    await m.onMessage(guildMsg({ userId: BOT_ID, content: "!go", bot: true }).message);
    expect(forwarder.forward).toHaveBeenCalledTimes(1);
  });

  it("rate-limits forwards per channel (5 per 10s window)", async () => {
    await seedMessageTrigger({ surface: "guild" });
    const forwarder = makeForwarder();
    const m = matcherWith(forwarder);
    for (let i = 0; i < 7; i++) {
      await m.onMessage(guildMsg({ userId: `U${i}`, content: "!go spam" }).message);
    }
    expect(forwarder.forward).toHaveBeenCalledTimes(5);
    await m.onMessage(guildMsg({ userId: "U9", content: "!go", channelId: "C2" }).message);
    expect(forwarder.forward).toHaveBeenCalledTimes(6);
  });
});

describe("matching order", () => {
  it("every match fires unless one stops the walk", async () => {
    const first = await seedMessageTrigger({ sortOrder: 0 });
    const second = await seedMessageTrigger({ sortOrder: 1 });
    const forwarder = makeForwarder();
    const m = matcherWith(forwarder);
    await m.onMessage(dmMsg("U1", "!go").message);
    expect(forwardedIds(forwarder)).toEqual([first, second]);

    await (await BehaviorDefinition.findByPk(first))!.update({ stopOnMatch: true });
    forwarder.forward.mockClear();
    await m.onMessage(dmMsg("U1", "!go").message);
    expect(forwardedIds(forwarder)).toEqual([first]);
  });

  it("a non-matching trigger does not stop later ones", async () => {
    await seedMessageTrigger({ sortOrder: 0, patternValue: "!other", stopOnMatch: true });
    const second = await seedMessageTrigger({ sortOrder: 1 });
    const forwarder = makeForwarder();
    await matcherWith(forwarder).onMessage(dmMsg("U1", "!go").message);
    expect(forwardedIds(forwarder)).toEqual([second]);
  });
});

describe("the system login", () => {
  it("answers `!login` in a bot DM with the built-in action and stops", async () => {
    const login = await seedSystemLogin();
    await seedMessageTrigger({ sortOrder: 0, patternValue: "!login" });
    const forwarder = makeForwarder();
    const { message, send } = dmMsg("U1", "!login");
    const outcome = await matcherWith(forwarder).onMessage(message);

    expect(outcome).toEqual({ handled: true, behaviorId: login });
    expect(mintLoginLink).toHaveBeenCalledWith("U1", expect.objectContaining({ messageId: "MSG-1" }));
    expect(forwarder.forward).not.toHaveBeenCalled();
    // the login reply goes back in the DM: an embed and a link button
    const sent = (send as Mock).mock.calls[0][0] as {
      embeds: unknown[];
      components: Array<{ components: Array<{ url: string }> }>;
    };
    expect(sent.embeds).toHaveLength(1);
    expect(sent.components[0].components[0].url).toBe("https://admin.example/admin/auth?token=t");
  });

  it("stays silent in the DM for someone who is not authorised", async () => {
    await seedSystemLogin();
    (mintLoginLink as Mock).mockResolvedValueOnce({ ok: false, reason: "not authorized" });
    const { message, send } = dmMsg("U1", "!login");
    expect((await matcherWith(makeForwarder()).onMessage(message)).handled).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the trigger snapshot", () => {
  it("picks up a trigger written after the first message", async () => {
    const forwarder = makeForwarder();
    const m = matcherWith(forwarder);
    await m.onMessage(dmMsg("U1", "!go").message);
    expect(forwarder.forward).not.toHaveBeenCalled();

    const id = await seedMessageTrigger();
    await m.onMessage(dmMsg("U1", "!go").message);
    expect(forwardedIds(forwarder)).toEqual([id]);
  });

  it("reads the database once across messages", async () => {
    await seedMessageTrigger();
    const m = matcherWith(makeForwarder());
    await m.onMessage(dmMsg("U1", "!nothing").message);
    const spy = vi.spyOn(BehaviorDefinition, "findAll");
    await m.onMessage(dmMsg("U1", "!nothing").message);
    await m.onMessage(dmMsg("U2", "!nothing").message);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
