/**
 * A picture-only channel deletes user messages that carry no attachment, but
 * must NOT police bot/webhook messages (same convention as rcon-forward and
 * todo-channel) — deleting the bot's own posts in such a channel is never
 * intended.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

import type { Client, Message } from "discord.js";
import { sequelize } from "../src/db.js";
import { PictureOnlyChannel } from "../src/modules/builtin-features/picture-only/picture-only-channel.model.js";
import { registerPictureOnlyChannelEvents } from "../src/modules/builtin-features/picture-only/picture-only-channel.events.js";

const CHANNEL = "chan-1";
const GUILD = "guild-1";

// Capture the messageCreate handler so the async body can be awaited directly.
function buildHandler(): (m: Message) => Promise<void> {
  let handler: ((m: Message) => Promise<void>) | undefined;
  const client = {
    on: (event: string, fn: (m: Message) => Promise<void>) => {
      if (event === "messageCreate") handler = fn;
    },
  } as unknown as Client;
  registerPictureOnlyChannelEvents(client);
  if (!handler) throw new Error("messageCreate handler not registered");
  return handler;
}

function fakeMessage(opts: {
  bot?: boolean;
  attachments?: number;
  channelId?: string;
}): { delete: ReturnType<typeof vi.fn> } & Message {
  return {
    author: { bot: opts.bot ?? false, id: "user-1" },
    attachments: { size: opts.attachments ?? 0 },
    channelId: opts.channelId ?? CHANNEL,
    guildId: GUILD,
    id: "msg-1",
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as { delete: ReturnType<typeof vi.fn> } & Message;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await PictureOnlyChannel.destroy({ where: {} });
  await PictureOnlyChannel.create({ channelId: CHANNEL, guildId: GUILD });
});

describe("picture-only channel", () => {
  it("deletes a user message with no attachment", async () => {
    const handler = buildHandler();
    const msg = fakeMessage({ bot: false, attachments: 0 });
    await handler(msg);
    expect(msg.delete).toHaveBeenCalledTimes(1);
  });

  it("does NOT delete a bot/webhook message", async () => {
    const handler = buildHandler();
    const msg = fakeMessage({ bot: true, attachments: 0 });
    await handler(msg);
    expect(msg.delete).not.toHaveBeenCalled();
  });

  it("does NOT delete a user message that has an attachment", async () => {
    const handler = buildHandler();
    const msg = fakeMessage({ bot: false, attachments: 1 });
    await handler(msg);
    expect(msg.delete).not.toHaveBeenCalled();
  });

  it("ignores messages outside a picture-only channel", async () => {
    const handler = buildHandler();
    const msg = fakeMessage({ bot: false, attachments: 0, channelId: "other" });
    await handler(msg);
    expect(msg.delete).not.toHaveBeenCalled();
  });
});
