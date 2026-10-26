/**
 * #99 — webhook secret rotation grace. For 24 h after a rotation the
 * previous secret still verifies: the bot signs the standard headers with
 * the CURRENT secret (same format as before, so a receiver that switched
 * keeps working), adds the same signature made with the PREVIOUS secret in
 * a `-previous` header for a receiver that has not switched yet — it must
 * check that header to keep working — and accepts a response signed with
 * either secret. After the grace period the previous secret is gone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

vi.mock("../src/utils/host-policy.js", () => ({
  resolveWebhookTarget: vi.fn(async (u: string | URL) => ({
    url: new URL(u),
    addresses: [{ address: "203.0.113.10", family: 4 }],
  })),
  HostPolicyError: class HostPolicyError extends Error {},
}));

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import type { BehaviorWebhookActionRow } from "../src/modules/behavior/models/behavior-webhook-action.model.js";
import { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { encryptSecret } from "../src/utils/crypto.js";
import { signBody } from "../src/utils/hmac.js";
import { fakeReceiver, sentRequest } from "./webhook-receiver-fake.js";

const HOOK_URL = "https://203.0.113.10/hook";
const CURRENT = "current-secret";
const PREVIOUS = "previous-secret";
const HOUR = 3600_000;

function action(
  authMode: "token" | "hmac",
  previousExpiresAt: Date | null,
): BehaviorWebhookActionRow {
  return {
    behaviorId: 1,
    url: encryptSecret(HOOK_URL),
    secret: encryptSecret(CURRENT),
    authMode,
    previousSecret: previousExpiresAt ? encryptSecret(PREVIOUS) : null,
    previousSecretExpiresAt: previousExpiresAt,
  };
}

const respondSignedWith = (secret: string | null) => fakeReceiver({ secret });
const sentHeaders = sentRequest;

describe("webhook secret rotation grace", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("hmac: signs with the current secret and adds the previous one's signature", async () => {
    const fetchSpy = respondSignedWith(CURRENT);
    const result = await new WebhookForwarder().forward(
      action("hmac", new Date(Date.now() + HOUR)),
      { content: "hi" },
    );
    expect(result.ok).toBe(true);

    const { headers, body } = sentHeaders(fetchSpy);
    const ts = headers["x-karyl-timestamp"]!;
    const nonce = headers["x-karyl-nonce"]!;
    expect(headers["x-karyl-signature"]).toBe(signBody(CURRENT, "POST", "/hook", ts, nonce, body));
    expect(headers["x-karyl-signature-previous"]).toBe(
      signBody(PREVIOUS, "POST", "/hook", ts, nonce, body),
    );
  });

  it("hmac: a response signed with the previous secret verifies during the grace period", async () => {
    respondSignedWith(PREVIOUS);
    const result = await new WebhookForwarder().forward(
      action("hmac", new Date(Date.now() + HOUR)),
      { content: "hi" },
    );
    expect(result).toMatchObject({ ok: true, reply: { content: "pong" } });
  });

  it("hmac: after the grace period only the current secret counts", async () => {
    const fetchSpy = respondSignedWith(PREVIOUS);
    const result = await new WebhookForwarder().forward(
      action("hmac", new Date(Date.now() - 1000)),
      { content: "hi" },
    );
    expect(result.ok).toBe(false);
    expect(sentHeaders(fetchSpy).headers).not.toHaveProperty("x-karyl-signature-previous");
  });

  it("token: sends the current token and the previous one beside it", async () => {
    const fetchSpy = respondSignedWith(null);
    await new WebhookForwarder().forward(action("token", new Date(Date.now() + HOUR)), {
      content: "hi",
    });
    const { headers } = sentHeaders(fetchSpy);
    expect(headers["x-plugin-webhook-token"]).toBe(CURRENT);
    expect(headers["x-plugin-webhook-token-previous"]).toBe(PREVIOUS);
  });

  it("without a rotation the headers are exactly the usual ones", async () => {
    const fetchSpy = respondSignedWith(CURRENT);
    await new WebhookForwarder().forward(action("hmac", null), { content: "hi" });
    expect(Object.keys(sentHeaders(fetchSpy).headers).sort()).toEqual([
      "Content-Type",
      "x-karyl-nonce",
      "x-karyl-signature",
      "x-karyl-timestamp",
    ]);
  });
});
