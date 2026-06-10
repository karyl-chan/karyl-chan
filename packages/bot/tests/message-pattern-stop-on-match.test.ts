/**
 * BH-0.3 — stopOnMatch multi-match semantics on the DM pattern path.
 *
 * The matcher walks applicable message_pattern behaviors in sortOrder:
 *   - one_time + stopOnMatch=false → forward and KEEP evaluating
 *   - one_time + stopOnMatch=true  → forward and stop
 *   - continuous match             → forward and stop (session takes over)
 *
 * Previously the loop returned on the first match unconditionally and the
 * field was dead ("treat as reserved").
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
    forward: vi.fn(async () => ({ ok: true, ended: false, relayContent: "ok" })),
  };
}

function fakeDm(userId: string, content: string) {
  const send = vi.fn(async () => {});
  return {
    message: {
      content,
      author: {
        id: userId,
        bot: false,
        username: "tester",
        displayAvatarURL: () => "https://cdn.example/a.png",
      },
      channel: { id: `DM-${userId}`, type: ChannelType.DM, send },
    } as never,
    send,
  };
}

const BASE = {
  enabled: true,
  forwardType: "one_time",
  source: "custom",
  triggerType: "message_pattern",
  messagePatternKind: "startswith",
  webhookUrl: encryptSecret("https://example.test/hook"),
  scope: "global",
  integrationTypes: "guild_install,user_install",
  contexts: "BotDM",
  audienceKind: "all",
  scopeTabId: 1,
} as const;

async function seedPattern(
  id: number,
  sortOrder: number,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await Behavior.create({
    id,
    title: `pattern-${id}`,
    sortOrder,
    stopOnMatch: false,
    messagePatternValue: "!go",
    ...BASE,
    ...overrides,
  } as Record<string, unknown>);
}

describe("MessagePatternMatcher — stopOnMatch multi-match", () => {
  it("one_time + stopOnMatch=false lets BOTH matching behaviors fire", async () => {
    await seedPattern(1, 0);
    await seedPattern(2, 1);
    const forwarder = makeForwarder();
    const matcher = new MessagePatternMatcher(
      forwarder as unknown as WebhookForwarder,
    );
    const { message, send } = fakeDm("U1", "!go now");
    const outcome = await matcher.onMessage(message);
    expect(outcome.handled).toBe(true);
    expect(forwarder.forward).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("one_time + stopOnMatch=true on the first blocks the second", async () => {
    await seedPattern(1, 0, { stopOnMatch: true });
    await seedPattern(2, 1);
    const forwarder = makeForwarder();
    const matcher = new MessagePatternMatcher(
      forwarder as unknown as WebhookForwarder,
    );
    const { message } = fakeDm("U1", "!go now");
    const outcome = await matcher.onMessage(message);
    expect(outcome.handled).toBe(true);
    expect(forwarder.forward).toHaveBeenCalledTimes(1);
    const [firstCall] = forwarder.forward.mock.calls as [
      [{ id: number }, unknown],
    ];
    expect(firstCall[0].id).toBe(1);
  });

  it("a continuous match always stops the walk and starts the session", async () => {
    await seedPattern(1, 0, { forwardType: "continuous" });
    await seedPattern(2, 1);
    const forwarder = makeForwarder();
    const matcher = new MessagePatternMatcher(
      forwarder as unknown as WebhookForwarder,
    );
    const { message } = fakeDm("U1", "!go now");
    const outcome = await matcher.onMessage(message);
    expect(outcome.handled).toBe(true);
    expect(outcome.sessionStarted).toBe(true);
    expect(forwarder.forward).toHaveBeenCalledTimes(1);
    expect(await findActiveSession("U1")).not.toBeNull();
  });

  it("a non-matching first behavior does not stop the second from firing", async () => {
    await seedPattern(1, 0, { messagePatternValue: "!other", stopOnMatch: true });
    await seedPattern(2, 1);
    const forwarder = makeForwarder();
    const matcher = new MessagePatternMatcher(
      forwarder as unknown as WebhookForwarder,
    );
    const { message } = fakeDm("U1", "!go now");
    const outcome = await matcher.onMessage(message);
    expect(outcome.handled).toBe(true);
    expect(forwarder.forward).toHaveBeenCalledTimes(1);
    const [firstCall] = forwarder.forward.mock.calls as [
      [{ id: number }, unknown],
    ];
    expect(firstCall[0].id).toBe(2);
  });
});
