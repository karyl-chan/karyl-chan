/**
 * BH-2.2A — webhook responses may carry { content?, embeds? }.
 *
 * Embeds come from an untrusted external service: sanitizeEmbeds copies
 * only whitelisted fields, enforces types, truncates to Discord limits,
 * caps the count, and drops non-http(s) urls. The matcher relays them to
 * the DM/guild channel alongside (or instead of) plain content.
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
import { sanitizeEmbeds } from "../src/modules/command-system/webhook-forwarder.service.js";
import { MessagePatternMatcher } from "../src/modules/command-system/message-pattern-matcher.service.js";
import type { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { encryptSecret } from "../src/utils/crypto.js";

describe("sanitizeEmbeds (BH-2.2A)", () => {
  it("keeps whitelisted fields and drops junk", () => {
    const out = sanitizeEmbeds([
      {
        title: "Hello",
        description: "World",
        url: "https://example.com",
        color: 0x336699,
        footer: { text: "f", icon_url: "https://cdn.example/i.png" },
        fields: [
          { name: "a", value: "1", inline: true },
          { name: "", value: "dropped" },
        ],
        __proto__pollution: "x",
        video: { url: "https://evil.example/v.mp4" },
      },
      "not-an-object",
      null,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      title: "Hello",
      description: "World",
      url: "https://example.com",
      color: 0x336699,
      footer: { text: "f", icon_url: "https://cdn.example/i.png" },
      fields: [{ name: "a", value: "1", inline: true }],
    });
  });

  it("drops non-http(s) urls and truncates long strings", () => {
    const out = sanitizeEmbeds([
      {
        title: "x".repeat(300),
        url: "javascript:alert(1)",
        image: { url: "data:image/png;base64,AAAA" },
      },
    ]);
    expect(out[0].title).toHaveLength(256);
    expect(out[0].url).toBeUndefined();
    expect(out[0].image).toBeUndefined();
  });

  it("caps the embed count at 10", () => {
    const out = sanitizeEmbeds(
      Array.from({ length: 15 }, (_, i) => ({ title: `e${i}` })),
    );
    expect(out).toHaveLength(10);
  });

  it("returns [] for non-arrays", () => {
    expect(sanitizeEmbeds(undefined)).toEqual([]);
    expect(sanitizeEmbeds({ title: "obj" })).toEqual([]);
  });
});

describe("matcher relays embeds (BH-2.2A)", () => {
  beforeAll(async () => {
    await sequelize.sync({ force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await Behavior.destroy({ where: {} });
  });

  it("sends an embeds-only response (no content)", async () => {
    await Behavior.create({
      id: 1,
      title: "embeds",
      enabled: true,
      sortOrder: 0,
      stopOnMatch: false,
      ignoreBots: true,
      forwardType: "one_time",
      source: "custom",
      triggerType: "message_pattern",
      messagePatternKind: "startswith",
      messagePatternValue: "!card",
      scope: "global",
      integrationTypes: "guild_install,user_install",
      contexts: "BotDM",
      audienceKind: "all",
      webhookUrl: encryptSecret("https://example.test/hook"),
      scopeTabId: 1,
    } as Record<string, unknown>);

    const embeds = [{ title: "Card", description: "body" }];
    const forwarder = {
      forward: vi.fn(async () => ({
        ok: true,
        ended: false,
        relayContent: "",
        relayEmbeds: embeds,
      })),
    };
    const matcher = new MessagePatternMatcher(
      forwarder as unknown as WebhookForwarder,
    );
    const send = vi.fn(async () => {});
    await matcher.onMessage({
      id: "M1",
      content: "!card",
      guildId: null,
      author: {
        id: "U1",
        bot: false,
        username: "u",
        displayAvatarURL: () => "https://cdn.example/a.png",
      },
      client: { user: { id: "BOT" } },
      channel: { id: "DM-U1", type: ChannelType.DM, send },
    } as never);

    expect(send).toHaveBeenCalledTimes(1);
    const arg = (send as Mock).mock.calls[0][0] as { embeds: unknown[] };
    expect(arg.embeds).toEqual(embeds);
  });
});
