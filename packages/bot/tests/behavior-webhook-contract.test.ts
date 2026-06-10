/**
 * BH-2.3 — the behavior custom-webhook contract, locked against the
 * shared fixtures (contract-fixtures.json `behaviorWebhook` section).
 *
 * If the bot changes the outbound payload shape, the END sentinel, or
 * the embed whitelist without updating the fixtures, this goes red —
 * external webhook authors read the fixtures as the canonical schema.
 */
import { vi, describe, it, expect, beforeAll, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));
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

import { ChannelType } from "discord.js";
import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { MessagePatternMatcher } from "../src/modules/command-system/message-pattern-matcher.service.js";
import { InteractionDispatcher } from "../src/modules/command-system/interaction-dispatcher.service.js";
import { sanitizeEmbeds } from "../src/modules/command-system/webhook-forwarder.service.js";
import type { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { encryptSecret } from "../src/utils/crypto.js";

const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../plugin-sdk/tests/contract/contract-fixtures.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as {
  behaviorWebhook: {
    endSentinel: string;
    request: {
      topLevelKeys: string[];
      patternMetaKeys: string[];
      slashMetaKeys: string[];
      userKeys: string[];
      sessionKeys: { inactive: string[]; active: string[] };
      attachmentKeys: string[];
    };
    response: {
      fields: string[];
      embedWhitelist: string[];
      maxEmbeds: number;
    };
  };
};

const C = fixtures.behaviorWebhook;

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

function captureForwarder(): { forward: Mock } {
  return {
    forward: vi.fn(async () => ({ ok: true, ended: false, relayContent: "" })),
  };
}

const BASE = {
  enabled: true,
  sortOrder: 0,
  stopOnMatch: false,
  ignoreBots: true,
  forwardType: "one_time",
  source: "custom",
  scope: "global",
  integrationTypes: "guild_install,user_install",
  contexts: "BotDM,Guild,PrivateChannel",
  audienceKind: "all",
  webhookUrl: encryptSecret("https://example.test/hook"),
  scopeTabId: 1,
} as const;

describe("behavior webhook contract (BH-2.3)", () => {
  it("pattern payload matches the fixture key sets", async () => {
    await Behavior.destroy({ where: {} });
    await Behavior.create({
      id: 1,
      title: "contract-pattern",
      triggerType: "message_pattern",
      messagePatternKind: "startswith",
      messagePatternValue: "!c",
      ...BASE,
      contexts: "BotDM",
    } as Record<string, unknown>);
    const f = captureForwarder();
    const matcher = new MessagePatternMatcher(f as unknown as WebhookForwarder);
    await matcher.onMessage({
      id: "M1",
      content: "!c hi",
      guildId: null,
      attachments: new Map([
        [
          "a",
          { url: "https://cdn.example/f.png", name: "f.png", contentType: "image/png", size: 9 },
        ],
      ]),
      author: {
        id: "U1",
        bot: false,
        username: "u",
        globalName: "U",
        discriminator: "0",
        avatar: null,
        displayAvatarURL: () => "https://cdn.example/a.png",
      },
      client: { user: { id: "BOT" } },
      channel: { id: "DM-U1", type: ChannelType.DM, send: vi.fn(async () => {}) },
    } as never);

    const payload = (f.forward.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload).sort()).toEqual([...C.request.topLevelKeys].sort());
    const meta = payload._meta as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual([...C.request.patternMetaKeys].sort());
    expect(Object.keys(meta.user as object).sort()).toEqual(
      [...C.request.userKeys].sort(),
    );
    expect(Object.keys(meta.session as object).sort()).toEqual(
      [...C.request.sessionKeys.inactive].sort(),
    );
    const att = (meta.attachments as object[])[0];
    expect(Object.keys(att).sort()).toEqual([...C.request.attachmentKeys].sort());
  });

  it("slash payload _meta matches the fixture key set", async () => {
    await Behavior.destroy({ where: {} });
    await Behavior.create({
      id: 2,
      title: "contract-slash",
      triggerType: "slash_command",
      slashCommandName: "contract",
      slashCommandDescription: "d",
      ...BASE,
    } as Record<string, unknown>);
    const f = captureForwarder();
    const d = new InteractionDispatcher(f as unknown as WebhookForwarder);
    await d.dispatch({
      isChatInputCommand: () => true,
      isAutocomplete: () => false,
      isButton: () => false,
      isAnySelectMenu: () => false,
      isModalSubmit: () => false,
      id: "ix",
      token: "tok",
      applicationId: "app",
      commandName: "contract",
      guildId: null,
      channelId: "C1",
      locale: "en-US",
      user: {
        id: "U1",
        username: "u",
        globalName: "U",
        discriminator: "0",
        avatar: null,
        displayAvatarURL: () => "https://cdn.example/a.png",
        createDM: async () => ({ id: "DM1" }),
      },
      options: { data: [] },
      reply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      deleteReply: vi.fn(async () => {}),
    } as never);

    const payload = (f.forward.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload).sort()).toEqual([...C.request.topLevelKeys].sort());
    const meta = payload._meta as Record<string, unknown>;
    // interaction_token is deleted for external webhooks before forward
    expect(Object.keys(meta).sort()).toEqual([...C.request.slashMetaKeys].sort());
    expect(Object.keys(meta.user as object).sort()).toEqual(
      [...C.request.userKeys].sort(),
    );
  });

  it("END sentinel and embed whitelist match the fixtures", () => {
    expect(C.endSentinel).toBe("[BEHAVIOR:END]");
    const sanitized = sanitizeEmbeds([
      {
        title: "t",
        description: "d",
        url: "https://x.example",
        color: 1,
        timestamp: "2026-06-11T00:00:00.000Z",
        footer: { text: "f" },
        image: { url: "https://x.example/i.png" },
        thumbnail: { url: "https://x.example/t.png" },
        author: { name: "a" },
        fields: [{ name: "n", value: "v" }],
        NOT_IN_WHITELIST: "x",
      },
    ]);
    expect(Object.keys(sanitized[0]).sort()).toEqual(
      [...C.response.embedWhitelist].sort(),
    );
    expect(
      sanitizeEmbeds(Array.from({ length: 99 }, () => ({ title: "x" }))).length,
    ).toBe(C.response.maxEmbeds);
  });
});
