/**
 * Delivery log (#120): one row per webhook delivery of a behavior, written
 * by runWebhookAction next to the stats, read back newest first, bounded
 * by the pruner (20 per behavior, 7 days).
 *
 *   - a row holds the outcome only: ok, HTTP status, duration, error code,
 *     a short error, the verified signature kind, the trigger kind — never
 *     a URL, a secret, the payload, the reply or a user id
 *   - a failed write never breaks the action
 */
import { vi, describe, it, expect, beforeAll, beforeEach, type Mock } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import { ChannelType, type Message } from "discord.js";
import { QueryTypes } from "sequelize";
import { sequelize } from "../src/db.js";
import { BehaviorDefinition } from "../src/modules/behavior/models/behavior-definition.model.js";
import { findStatsBulk } from "../src/modules/behavior/models/behavior-stats.model.js";
import { findRecentDeliveries } from "../src/modules/behavior/behavior-deliveries.js";
import { BehaviorDelivery } from "../src/modules/behavior/models/behavior-delivery.model.js";
import { runWebhookAction } from "../src/modules/command-system/webhook-action.js";
import type { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import type { ForwardResult } from "../src/modules/command-system/types.js";
import { clearBehaviors, seedMessageTrigger } from "./behavior-fixtures.js";

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearBehaviors();
});

/** A message the bot answers: in a DM with the bot, or in a guild channel. */
function fakeMessage(opts: { guild?: boolean; channelSend?: Mock; authorSend?: Mock } = {}) {
  const channelSend = opts.channelSend ?? vi.fn(async () => ({}));
  const authorSend = opts.authorSend ?? vi.fn(async () => ({}));
  const message = {
    id: "M1",
    content: "!go",
    guild: opts.guild ? { preferredLocale: "en-US" } : null,
    guildId: opts.guild ? "G1" : null,
    channel: {
      id: "C1",
      type: opts.guild ? ChannelType.GuildText : ChannelType.DM,
      send: channelSend,
    },
    author: { id: "U1", send: authorSend },
  };
  return message as unknown as Message;
}

function forwarderReturning(result: ForwardResult): WebhookForwarder {
  return { forward: vi.fn(async () => result) } as unknown as WebhookForwarder;
}

async function fire(
  behaviorId: number,
  result: ForwardResult,
  message: Message = fakeMessage(),
): Promise<void> {
  await runWebhookAction({
    forwarder: forwarderReturning(result),
    behaviorId,
    webhook: {
      behaviorId,
      url: "enc",
      secret: null,
      authMode: null,
      previousSecret: null,
      previousSecretExpiresAt: null,
    },
    payload: { content: "!go" },
    target: { kind: "message", message },
    visibility: null,
  });
}

describe("runWebhookAction records a delivery", () => {
  it("a successful forward: ok, its HTTP status, a duration and the verified signature", async () => {
    const id = await seedMessageTrigger();

    await fire(id, { ok: true, reply: { content: "pong" }, notes: [], status: 200, verified: "hmac" });

    const rows = await findRecentDeliveries(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      via: "message",
      ok: true,
      httpStatus: 200,
      errorCode: null,
      error: null,
      verified: "hmac",
    });
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof rows[0].firedAt).toBe("string");
  });
});

describe("a failed delivery records why", () => {
  it("a non-2xx answer: http_error with the status and the receiver's error", async () => {
    const id = await seedMessageTrigger();

    await fire(id, { ok: false, reply: {}, notes: [], status: 500, error: "Internal Server Error" });

    const [row] = await findRecentDeliveries(id);
    expect(row).toMatchObject({
      ok: false,
      httpStatus: 500,
      errorCode: "http_error",
      error: "Internal Server Error",
      verified: null,
    });
  });

  it("a bad response signature keeps the forwarder's code", async () => {
    const id = await seedMessageTrigger();

    await fire(id, {
      ok: false,
      reply: {},
      notes: [],
      status: 200,
      error: "signature mismatch",
      errorCode: "response_signature",
    });

    expect((await findRecentDeliveries(id))[0]).toMatchObject({
      ok: false,
      httpStatus: 200,
      errorCode: "response_signature",
    });
  });

  it("a 2xx the bot cannot use is invalid_reply; no response at all is request_failed", async () => {
    const id = await seedMessageTrigger();

    await fire(id, { ok: false, reply: {}, notes: [], status: 200, error: "response body is not JSON" });
    await fire(id, { ok: false, reply: {}, notes: [], error: "network error: fetch failed" });

    const [noResponse, notJson] = await findRecentDeliveries(id);
    expect(notJson).toMatchObject({ errorCode: "invalid_reply", httpStatus: 200 });
    expect(noResponse).toMatchObject({ errorCode: "request_failed", httpStatus: null });
  });

  it("Discord refusing the reply: render_failed", async () => {
    const id = await seedMessageTrigger();
    const channelSend = vi.fn(async () => {
      throw new Error("Missing Permissions");
    });

    await fire(id, { ok: true, reply: { content: "pong" }, notes: [], status: 200 }, fakeMessage({ channelSend }));

    expect((await findRecentDeliveries(id))[0]).toMatchObject({
      ok: false,
      httpStatus: 200,
      errorCode: "render_failed",
      error: "Discord refused the reply: Missing Permissions",
    });
  });

  it("a private reply the author cannot be DMed: dm_failed", async () => {
    const id = await seedMessageTrigger({ surface: "guild" });
    const authorSend = vi.fn(async () => {
      throw new Error("Cannot send messages to this user");
    });

    await fire(
      id,
      { ok: true, reply: { content: "psst", ephemeral: true }, notes: [], status: 200 },
      fakeMessage({ guild: true, authorSend }),
    );

    expect((await findRecentDeliveries(id))[0]).toMatchObject({ ok: false, errorCode: "dm_failed" });
  });

  it("keeps at most 300 characters of the error", async () => {
    const id = await seedMessageTrigger();

    await fire(id, { ok: false, reply: {}, notes: [], status: 502, error: "x".repeat(1000) });

    const [row] = await findRecentDeliveries(id);
    expect(row.error).toHaveLength(300);
    // the stats keep their own, longer cut
    expect((await findStatsBulk([id])).get(id)!.lastError).toHaveLength(500);
  });
});

describe("what a delivery never holds", () => {
  it("no webhook URL, secret, message content, reply or user id", async () => {
    const MARK = {
      url: "https://marker-url.example/hook",
      secret: "marker-secret-value",
      content: "marker-content-text",
      reply: "marker-reply-text",
      userId: "987654321098765432",
    };
    const id = await seedMessageTrigger();
    const message = {
      ...(fakeMessage() as unknown as Record<string, unknown>),
      content: MARK.content,
      author: { id: MARK.userId, send: vi.fn(async () => ({})) },
    } as unknown as Message;

    await runWebhookAction({
      forwarder: forwarderReturning({ ok: true, reply: { content: MARK.reply }, notes: [], status: 200 }),
      behaviorId: id,
      webhook: {
        behaviorId: id,
        url: MARK.url,
        secret: MARK.secret,
        authMode: "hmac",
        previousSecret: null,
        previousSecretExpiresAt: null,
      },
      payload: { content: MARK.content, _meta: { user: { id: MARK.userId } } },
      target: { kind: "message", message },
      visibility: null,
    });

    const stored = JSON.stringify(await findRecentDeliveries(id));
    expect(stored).toContain('"ok":true');
    for (const marker of Object.values(MARK)) expect(stored).not.toContain(marker);
  });
});

describe("the delivery log goes with its behavior", () => {
  it("deleting a behavior deletes its deliveries (foreign keys on)", async () => {
    const [fk] = await sequelize.query<{ foreign_keys: number }>("PRAGMA foreign_keys", {
      type: QueryTypes.SELECT,
    });
    expect(fk.foreign_keys).toBe(1);
    const id = await seedMessageTrigger();
    await fire(id, { ok: true, reply: {}, notes: [], status: 204 });
    expect(await findRecentDeliveries(id)).toHaveLength(1);

    await BehaviorDefinition.destroy({ where: { id } });

    expect(await findRecentDeliveries(id)).toEqual([]);
  });
});

describe("a delivery that cannot be written", () => {
  it("does not break the action: the reply is sent and the stats counted", async () => {
    const id = await seedMessageTrigger();
    const create = vi.spyOn(BehaviorDelivery, "create").mockRejectedValueOnce(new Error("disk full"));
    const channelSend = vi.fn(async () => ({}));

    await expect(
      fire(id, { ok: true, reply: { content: "pong" }, notes: [], status: 200 }, fakeMessage({ channelSend })),
    ).resolves.toBeUndefined();

    expect(create).toHaveBeenCalledTimes(1);
    expect(channelSend).toHaveBeenCalledTimes(1);
    expect((await findStatsBulk([id])).get(id)!.successCount).toBe(1);
    expect(await findRecentDeliveries(id)).toEqual([]);
    create.mockRestore();
  });
});
