/**
 * BH-2.1 — the pattern/session webhook payload carries `_meta`.
 *
 * The old payload was only { content, username, avatar_url }: a webhook
 * serving multiple users had no stable way to tell callers apart
 * (usernames are mutable). `_meta.user.id` fixes that; `behavior_id`,
 * `message_id`, `session` and `attachments` round out the contract.
 * Top-level fields stay Discord-webhook compatible.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, type Mock } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import { ChannelType, Collection } from "discord.js";
import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { BehaviorSession } from "../src/modules/behavior/models/behavior-session.model.js";
import { MessagePatternMatcher } from "../src/modules/command-system/message-pattern-matcher.service.js";
import type { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { encryptSecret } from "../src/utils/crypto.js";

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await Behavior.destroy({ where: {} });
  await BehaviorSession.destroy({ where: {} });
});

function makeForwarder(): { forward: Mock } {
  return {
    forward: vi.fn(async () => ({ ok: true, ended: false, relayContent: "" })),
  };
}

function fakeDm(userId: string, content: string) {
  const attachments = new Collection<string, unknown>();
  attachments.set("att1", {
    url: "https://cdn.example/file.png",
    name: "file.png",
    contentType: "image/png",
    size: 1234,
  });
  return {
    id: "MSG-1",
    content,
    attachments,
    author: {
      id: userId,
      bot: false,
      username: "tester",
      globalName: "Tester G",
      discriminator: "0",
      avatar: "abc",
      displayAvatarURL: () => "https://cdn.example/a.png",
    },
    channel: { id: `DM-${userId}`, type: ChannelType.DM, send: vi.fn(async () => {}) },
  } as never;
}

async function seedPattern(overrides: Record<string, unknown> = {}): Promise<void> {
  await Behavior.create({
    id: 7,
    title: "meta test",
    enabled: true,
    sortOrder: 0,
    stopOnMatch: false,
    forwardType: "one_time",
    source: "custom",
    triggerType: "message_pattern",
    messagePatternKind: "startswith",
    messagePatternValue: "!go",
    scope: "global",
    integrationTypes: "guild_install,user_install",
    contexts: "BotDM",
    audienceKind: "all",
    webhookUrl: encryptSecret("https://example.test/hook"),
    scopeTabId: 1,
    ...overrides,
  } as Record<string, unknown>);
}

type Meta = {
  user: { id: string; global_name: string | null };
  message_id: string;
  channel_id: string;
  behavior_id: number;
  session: { active: boolean; started_at?: string };
  attachments: Array<{ url: string; filename: string | null }>;
};

describe("pattern payload _meta (BH-2.1)", () => {
  it("the triggering match carries user id / ids / inactive session / attachments", async () => {
    await seedPattern();
    const forwarder = makeForwarder();
    const matcher = new MessagePatternMatcher(
      forwarder as unknown as WebhookForwarder,
    );
    await matcher.onMessage(fakeDm("U1", "!go hello"));

    expect(forwarder.forward).toHaveBeenCalledTimes(1);
    const payload = (forwarder.forward.mock.calls[0] as unknown[])[1] as {
      content: string;
      username: string;
      _meta: Meta;
    };
    expect(payload.content).toBe("!go hello");
    expect(payload.username).toBe("tester");
    expect(payload._meta.user.id).toBe("U1");
    expect(payload._meta.user.global_name).toBe("Tester G");
    expect(payload._meta.message_id).toBe("MSG-1");
    expect(payload._meta.channel_id).toBe("DM-U1");
    expect(payload._meta.behavior_id).toBe(7);
    expect(payload._meta.session).toEqual({ active: false });
    expect(payload._meta.attachments).toEqual([
      {
        url: "https://cdn.example/file.png",
        filename: "file.png",
        content_type: "image/png",
        size: 1234,
      },
    ]);
  });

  it("messages routed through an open session carry session.active=true", async () => {
    await seedPattern({ forwardType: "continuous" });
    const forwarder = makeForwarder();
    const matcher = new MessagePatternMatcher(
      forwarder as unknown as WebhookForwarder,
    );

    // first message starts the session
    await matcher.onMessage(fakeDm("U1", "!go start"));
    // second message rides the session (no pattern needed)
    await matcher.onMessage(fakeDm("U1", "just chatting"));

    expect(forwarder.forward).toHaveBeenCalledTimes(2);
    const second = (forwarder.forward.mock.calls[1] as unknown[])[1] as {
      _meta: Meta;
    };
    expect(second._meta.user.id).toBe("U1");
    expect(second._meta.session.active).toBe(true);
    expect(typeof second._meta.session.started_at).toBe("string");
  });
});
