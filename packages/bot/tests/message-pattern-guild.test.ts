/**
 * BH-3 — guild-channel message patterns.
 *
 * The matcher accepts guild text messages: a pattern fires there only
 * when its contexts include Guild, placement (specific_guild/channel)
 * matches, and — for bot/webhook authors — ignoreBots allows it. The
 * bot's own messages never trigger anything. Guild forwards are
 * rate-limited per channel. DM-context patterns don't fire in guilds
 * and Guild-context patterns don't fire in DMs.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, type Mock } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import { ChannelType } from "discord.js";
import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import {
  BehaviorSession,
  findActiveSession,
} from "../src/modules/behavior/models/behavior-session.model.js";
import {
  MessagePatternMatcher,
  __resetGuildForwardWindowsForTests,
} from "../src/modules/command-system/message-pattern-matcher.service.js";
import type { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { encryptSecret } from "../src/utils/crypto.js";

const BOT_ID = "BOT-SELF";

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  __resetGuildForwardWindowsForTests();
  await Behavior.destroy({ where: {} });
  await BehaviorSession.destroy({ where: {} });
});

function makeForwarder(relay = ""): { forward: Mock } {
  return {
    forward: vi.fn(async () => ({ ok: true, ended: false, relayContent: relay })),
  };
}

function fakeGuildMsg(opts: {
  userId: string;
  content: string;
  guildId?: string;
  channelId?: string;
  bot?: boolean;
}) {
  const send = vi.fn(async () => {});
  return {
    message: {
      id: `MSG-${Math.floor(opts.content.length)}`,
      content: opts.content,
      guildId: opts.guildId ?? "G1",
      author: {
        id: opts.userId,
        bot: opts.bot ?? false,
        username: "guilder",
        displayAvatarURL: () => "https://cdn.example/a.png",
      },
      client: { user: { id: BOT_ID } },
      channel: {
        id: opts.channelId ?? "C1",
        type: ChannelType.GuildText,
        send,
      },
    } as never,
    send,
  };
}

function fakeDmMsg(userId: string, content: string) {
  const send = vi.fn(async () => {});
  return {
    message: {
      id: "MSG-DM",
      content,
      guildId: null,
      author: {
        id: userId,
        bot: false,
        username: "dmer",
        displayAvatarURL: () => "https://cdn.example/a.png",
      },
      client: { user: { id: BOT_ID } },
      channel: { id: `DM-${userId}`, type: ChannelType.DM, send },
    } as never,
    send,
  };
}

const BASE = {
  enabled: true,
  sortOrder: 0,
  stopOnMatch: false,
  ignoreBots: true,
  forwardType: "one_time",
  source: "custom",
  triggerType: "message_pattern",
  messagePatternKind: "startswith",
  messagePatternValue: "!go",
  scope: "guild",
  integrationTypes: "guild_install",
  contexts: "Guild",
  audienceKind: "all",
  webhookUrl: encryptSecret("https://example.test/hook"),
  scopeTabId: 1,
} as const;

async function seedGuildPattern(
  id: number,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await Behavior.create({
    id,
    title: `guild-${id}`,
    ...BASE,
    ...overrides,
  } as Record<string, unknown>);
}

function matcherWith(forwarder: { forward: Mock }): MessagePatternMatcher {
  return new MessagePatternMatcher(forwarder as unknown as WebhookForwarder);
}

describe("MessagePatternMatcher — guild channel patterns (BH-3)", () => {
  it("fires in the placed channel and relays the reply there", async () => {
    await seedGuildPattern(1, {
      placementGuildId: "G1",
      placementChannelId: "C1",
    });
    const forwarder = makeForwarder("roger");
    const m = matcherWith(forwarder);
    const { message, send } = fakeGuildMsg({ userId: "U1", content: "!go hi" });
    const outcome = await m.onMessage(message);
    expect(outcome.handled).toBe(true);
    expect(forwarder.forward).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not fire on placement mismatch (other channel / other guild)", async () => {
    await seedGuildPattern(1, {
      placementGuildId: "G1",
      placementChannelId: "C1",
    });
    const forwarder = makeForwarder();
    const m = matcherWith(forwarder);
    await m.onMessage(
      fakeGuildMsg({ userId: "U1", content: "!go", channelId: "C9" }).message,
    );
    await m.onMessage(
      fakeGuildMsg({ userId: "U1", content: "!go", guildId: "G9" }).message,
    );
    expect(forwarder.forward).not.toHaveBeenCalled();
  });

  it("contexts separate the two surfaces: Guild-only stays out of DMs and vice versa", async () => {
    await seedGuildPattern(1); // contexts: Guild
    await seedGuildPattern(2, {
      scope: "global",
      integrationTypes: "guild_install,user_install",
      contexts: "BotDM",
      messagePatternValue: "!go",
    });
    const forwarder = makeForwarder();
    const m = matcherWith(forwarder);

    await m.onMessage(fakeDmMsg("U1", "!go dm").message);
    expect(forwarder.forward).toHaveBeenCalledTimes(1);
    let row = (forwarder.forward.mock.calls[0] as unknown[])[0] as { id: number };
    expect(row.id).toBe(2); // only the BotDM behavior

    forwarder.forward.mockClear();
    await m.onMessage(fakeGuildMsg({ userId: "U1", content: "!go g" }).message);
    expect(forwarder.forward).toHaveBeenCalledTimes(1);
    row = (forwarder.forward.mock.calls[0] as unknown[])[0] as { id: number };
    expect(row.id).toBe(1); // only the Guild behavior
  });

  it("ignoreBots default skips bot authors; unchecked allows them; self never fires", async () => {
    await seedGuildPattern(1);
    const forwarder = makeForwarder();
    const m = matcherWith(forwarder);

    await m.onMessage(
      fakeGuildMsg({ userId: "OTHER-BOT", content: "!go", bot: true }).message,
    );
    expect(forwarder.forward).not.toHaveBeenCalled();

    await Behavior.update({ ignoreBots: false }, { where: { id: 1 } });
    await m.onMessage(
      fakeGuildMsg({ userId: "OTHER-BOT", content: "!go", bot: true }).message,
    );
    expect(forwarder.forward).toHaveBeenCalledTimes(1);

    // the bot's own message is dropped unconditionally even with ignoreBots=false
    await m.onMessage(
      fakeGuildMsg({ userId: BOT_ID, content: "!go", bot: true }).message,
    );
    expect(forwarder.forward).toHaveBeenCalledTimes(1);
  });

  it("rate-limits guild forwards per channel (5 per 10s window)", async () => {
    await seedGuildPattern(1);
    const forwarder = makeForwarder();
    const m = matcherWith(forwarder);
    for (let i = 0; i < 7; i++) {
      await m.onMessage(
        fakeGuildMsg({ userId: `U${i}`, content: "!go spam" }).message,
      );
    }
    expect(forwarder.forward).toHaveBeenCalledTimes(5);
    // a different channel has its own budget
    await m.onMessage(
      fakeGuildMsg({ userId: "U9", content: "!go", channelId: "C2" }).message,
    );
    expect(forwarder.forward).toHaveBeenCalledTimes(6);
  });

  it("continuous guild sessions are per (user, channel)", async () => {
    await seedGuildPattern(1, { forwardType: "continuous" });
    const forwarder = makeForwarder();
    const m = matcherWith(forwarder);

    await m.onMessage(fakeGuildMsg({ userId: "U1", content: "!go start" }).message);
    expect(await findActiveSession("U1", "C1")).not.toBeNull();

    // next message in the SAME channel rides the session (no pattern)
    await m.onMessage(fakeGuildMsg({ userId: "U1", content: "free text" }).message);
    expect(forwarder.forward).toHaveBeenCalledTimes(2);

    // the same user in ANOTHER channel does not ride it
    forwarder.forward.mockClear();
    await m.onMessage(
      fakeGuildMsg({ userId: "U1", content: "free text", channelId: "C2" }).message,
    );
    expect(forwarder.forward).not.toHaveBeenCalled();
  });
});
