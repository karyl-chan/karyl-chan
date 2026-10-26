/**
 * #102 — a webhook response's signature binds the REQUEST's nonce:
 * `<METHOD>:<path>:<ts>:<request nonce>:<body>`. A response signed for a
 * different request (another user's, within the replay window) no longer
 * verifies, and neither does the old nonce-less form — a hard switch
 * (production had no custom behaviors; see docs/features/behaviors.md).
 * Token mode sends the nonce too, so a receiver that signs its responses
 * there can bind it.
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
import { fakeReceiver, sentRequest } from "./webhook-receiver-fake.js";

const SECRET = "shared-hmac-secret";

function action(authMode: "hmac" | "token"): BehaviorWebhookActionRow {
  return {
    behaviorId: 7,
    url: encryptSecret("https://203.0.113.10/hook"),
    secret: encryptSecret(SECRET),
    authMode,
    previousSecret: null,
    previousSecretExpiresAt: null,
  };
}

describe("response signatures bind the request nonce", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a response signed over the request's nonce", async () => {
    fakeReceiver({ secret: SECRET, nonce: "request" });
    const result = await new WebhookForwarder().forward(action("hmac"), { content: "hi" });
    expect(result).toMatchObject({ ok: true, reply: { content: "pong" }, verified: "hmac" });
  });

  it("refuses a response signed over a nonce of its own", async () => {
    fakeReceiver({ secret: SECRET, nonce: "own" });
    const result = await new WebhookForwarder().forward(action("hmac"), { content: "hi" });
    expect(result).toMatchObject({
      ok: false,
      error: "response nonce does not match the request",
      errorCode: "response_signature",
    });
  });

  it("refuses the nonce-less legacy form", async () => {
    fakeReceiver({ secret: SECRET, nonce: "none" });
    const result = await new WebhookForwarder().forward(action("hmac"), { content: "hi" });
    expect(result).toMatchObject({ ok: false, error: "response signature mismatch" });
  });

  it("every request carries a fresh nonce", async () => {
    const spy = fakeReceiver({ secret: SECRET });
    const forwarder = new WebhookForwarder();
    await forwarder.forward(action("hmac"), { content: "a" });
    await forwarder.forward(action("hmac"), { content: "b" });
    const [first, second] = [sentRequest(spy, 0), sentRequest(spy, 1)];
    expect(first.headers["x-karyl-nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(first.headers["x-karyl-nonce"]).not.toBe(second.headers["x-karyl-nonce"]);
  });

  it("token mode sends a nonce and binds a signed response to it", async () => {
    const spy = fakeReceiver({ secret: SECRET, nonce: "request" });
    expect(await new WebhookForwarder().forward(action("token"), {})).toMatchObject({
      ok: true,
      verified: "token",
    });
    expect(sentRequest(spy).headers["x-karyl-nonce"]).toMatch(/^[0-9a-f]{32}$/);

    vi.restoreAllMocks();
    fakeReceiver({ secret: SECRET, nonce: "own" });
    expect(await new WebhookForwarder().forward(action("token"), {})).toMatchObject({ ok: false });
  });
});
