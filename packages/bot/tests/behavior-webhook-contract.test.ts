/**
 * BH-2.3 — the behavior custom-webhook contract, locked against the
 * shared fixtures (`CONTRACT_FIXTURES.behaviorWebhook`, owned by
 * `@karyl-chan/plugin-wire` — imported as a package, never read as a
 * file across a package boundary).
 *
 * If the bot changes the outbound payload shape or the embed whitelist without updating the fixtures, this goes red —
 * external webhook authors read the fixtures as the canonical schema.
 */
import { vi, describe, it, expect, beforeAll, type Mock } from "vitest";

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
import { MessageTriggerMatcher } from "../src/modules/command-system/message-trigger-matcher.service.js";
import { InteractionDispatcher } from "../src/modules/command-system/interaction-dispatcher.service.js";
import {
  ALLOWED_REPLY_FLAGS,
  MAX_REPLY_BODY_BYTES,
  MAX_REPLY_CONTENT,
  MAX_REPLY_EMBED_CHARS,
  parseBehaviorReply,
} from "../src/modules/command-system/behavior-reply.js";
import { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import {
  clearBehaviors,
  seedCommand,
  seedLeaf,
  seedMessageTrigger,
} from "./behavior-fixtures.js";
import { CONTRACT_FIXTURES } from "@karyl-chan/plugin-wire";
import { signBody, verifyInboundSignature } from "../src/utils/hmac.js";
import { encryptSecret } from "../src/utils/crypto.js";
import {
  TEST_HEADER,
  TEST_PREVIOUS_TOKEN_HEADER,
  TEST_SIGNATURE_PREFIX,
  TEST_TOKEN_HEADER,
} from "../src/modules/command-system/webhook-forwarder.service.js";

const C = CONTRACT_FIXTURES.behaviorWebhook;


beforeAll(async () => {
  await sequelize.sync({ force: true });
});

function captureForwarder(): { forward: Mock } {
  return {
    forward: vi.fn(async () => ({ ok: true, reply: {}, notes: [] })),
  };
}

describe("behavior webhook contract (BH-2.3)", () => {
  it("pattern payload matches the fixture key sets", async () => {
    await clearBehaviors();
    await seedMessageTrigger({ title: "contract-pattern", patternValue: "!c" });
    const f = captureForwarder();
    const matcher = new MessageTriggerMatcher(f as unknown as WebhookForwarder);
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
    const att = (meta.attachments as object[])[0];
    expect(Object.keys(att).sort()).toEqual([...C.request.attachmentKeys].sort());
  });

  it("slash payload _meta matches the fixture key set", async () => {
    await clearBehaviors();
    await seedLeaf(await seedCommand({ name: "contract", description: "d" }), {
      title: "contract-slash",
    });
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
      commandGuildId: null,
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
      options: {
        data: [],
        getSubcommand: () => null,
        getSubcommandGroup: () => null,
      },
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

  it("the response fields are the reply model's", () => {
    const parsed = parseBehaviorReply({
      content: "c",
      embeds: [{ title: "t" }],
      components: [{ type: 1, components: [{ type: 2, style: 5, label: "l", url: "https://x.example" }] }],
      ephemeral: false,
      flags: 4,
    });
    expect(parsed.ok && Object.keys(parsed.reply).sort()).toEqual([...C.response.fields].sort());
    expect(C.response.allowedFlags.reduce((a, b) => a | b, 0)).toBe(ALLOWED_REPLY_FLAGS);
    const row = {
      type: 1,
      components: Array.from({ length: 9 }, () => ({ type: 2, style: 5, label: "l", url: "https://x.example" })),
    };
    const many = parseBehaviorReply({ components: Array.from({ length: 9 }, () => row) });
    const rows = many.ok ? many.reply.components! : [];
    expect(rows).toHaveLength(C.response.maxComponentRows);
    expect(rows[0].components).toHaveLength(C.response.maxButtonsPerRow);
  });

  it("the size limits are the fixtures'", () => {
    expect(MAX_REPLY_CONTENT).toBe(C.response.maxContentLength);
    expect(MAX_REPLY_EMBED_CHARS).toBe(C.response.maxEmbedTotalLength);
    expect(MAX_REPLY_BODY_BYTES).toBe(C.response.maxBodyBytes);
    const long = parseBehaviorReply({ content: "x".repeat(C.response.maxContentLength + 1) });
    expect(long.ok && long.reply.content!.length).toBe(C.response.maxContentLength);
  });

  it("a response signature over the request nonce reproduces the golden vectors", () => {
    for (const g of C.signing.responseGolden) {
      expect(signBody(g.secret, g.method, g.path, g.ts, g.nonce, g.body)).toBe(g.expectedHex);
    }
  });

  it("a golden response verifies against its request's nonce and no other", () => {
    for (const g of C.signing.responseGolden) {
      const headers = new Headers({
        [CONTRACT_FIXTURES.hmac.timestampHeader]: g.ts,
        [CONTRACT_FIXTURES.hmac.signatureHeader]: g.expectedHex,
      });
      const verify = (boundNonce: string) =>
        verifyInboundSignature(g.secret, headers, g.body, Number(g.ts), g.method, g.path, {
          boundNonce,
        });
      expect(verify(g.nonce)).toEqual({ ok: true });
      expect(verify("f".repeat(32))).toEqual({ ok: false, reason: "response signature mismatch" });
    }
  });

  it("each auth mode sends the fixtures' request headers", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("", { status: 200 }));
    const host = await import("../src/utils/host-policy.js");
    const resolve = vi.spyOn(host, "resolveWebhookTarget").mockImplementation(async (u) => ({
      url: new URL(u),
      addresses: [{ address: "203.0.113.10", family: 4 }],
    }));
    try {
      for (const mode of ["hmac", "token"] as const) {
        fetchSpy.mockClear();
        await new WebhookForwarder().forward(
          {
            behaviorId: 1,
            url: encryptSecret("https://203.0.113.10/hook"),
            secret: encryptSecret("s"),
            authMode: mode,
            previousSecret: null,
            previousSecretExpiresAt: null,
          },
          {},
        );
        const sent = (fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
        for (const h of C.signing.requestHeaders[mode]) expect(sent).toHaveProperty(h);
      }
    } finally {
      fetchSpy.mockRestore();
      resolve.mockRestore();
    }
  });

  it("a test-fire is signed under the fixtures' prefix and headers", () => {
    expect(TEST_SIGNATURE_PREFIX).toBe(C.signing.testPrefix);
    expect(TEST_HEADER).toBe(C.signing.testHeader);
    expect(TEST_TOKEN_HEADER).toBe(C.signing.testTokenHeader);
    expect(TEST_PREVIOUS_TOKEN_HEADER).toBe(C.signing.testPreviousTokenHeader);
    const prefix = { prefix: C.signing.testPrefix };
    for (const g of [...C.signing.testGolden, ...C.signing.testResponseGolden]) {
      expect(signBody(g.secret, g.method, g.path, g.ts, g.nonce, g.body, prefix)).toBe(g.expectedHex);
    }
  });

  it("a golden test-fire response verifies only as a test, bound to its request nonce", () => {
    for (const g of C.signing.testResponseGolden) {
      const headers = new Headers({
        [CONTRACT_FIXTURES.hmac.timestampHeader]: g.ts,
        [CONTRACT_FIXTURES.hmac.signatureHeader]: g.expectedHex,
      });
      const verify = (boundNonce: string, prefix?: string) =>
        verifyInboundSignature(g.secret, headers, g.body, Number(g.ts), g.method, g.path, {
          boundNonce,
          prefix,
        });
      expect(verify(g.nonce, C.signing.testPrefix)).toEqual({ ok: true });
      expect(verify(g.nonce).ok).toBe(false);
      expect(verify("f".repeat(32), C.signing.testPrefix).ok).toBe(false);
    }
  });

  it("embed whitelist matches the fixtures", () => {
    const embedsOf = (raw: unknown[]) => {
      const parsed = parseBehaviorReply({ embeds: raw });
      return parsed.ok ? (parsed.reply.embeds ?? []) : [];
    };
    const sanitized = embedsOf([
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
      embedsOf(Array.from({ length: 99 }, () => ({ title: "x" }))).length,
    ).toBe(C.response.maxEmbeds);
  });
});
