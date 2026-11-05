/**
 * #101 — a test-fire must not pass for a real user's request at the
 * signature level. It is marked `x-karyl-test: 1` and signed under its own
 * prefix: `test:<METHOD>:<path>:<ts>:<nonce>:<body>` in hmac mode, the
 * token under `x-plugin-webhook-test-token` in token mode. A receiver that
 * verifies only the real scheme therefore refuses a test; one that wants
 * to answer tests verifies (and signs its response) under the prefix.
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

const SECRET = "current-secret";
const PREVIOUS = "previous-secret";

function action(
  authMode: "hmac" | "token" | null,
  rotating = false,
): BehaviorWebhookActionRow {
  return {
    behaviorId: 9,
    url: encryptSecret("https://203.0.113.10/hook"),
    secret: authMode ? encryptSecret(SECRET) : null,
    authMode,
    previousSecret: rotating ? encryptSecret(PREVIOUS) : null,
    previousSecretExpiresAt: rotating ? new Date(Date.now() + 3600_000) : null,
  };
}

describe("test-fire signing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("hmac: signs under the test prefix, so the real scheme does not verify", async () => {
    const spy = fakeReceiver({ secret: SECRET, prefix: "test:" });
    const result = await new WebhookForwarder().forward(action("hmac"), { content: "t" }, { test: true });
    expect(result).toMatchObject({ ok: true, reply: { content: "pong" } });

    const { headers, body } = sentRequest(spy);
    const ts = headers["x-karyl-timestamp"]!;
    const nonce = headers["x-karyl-nonce"]!;
    expect(headers["x-karyl-test"]).toBe("1");
    expect(headers["x-karyl-signature"]).toBe(signBody(SECRET, "POST", "/hook", ts, nonce, body, { prefix: "test:" }));
    expect(headers["x-karyl-signature"]).not.toBe(signBody(SECRET, "POST", "/hook", ts, nonce, body));
  });

  it("hmac: the previous secret's signature carries the prefix too", async () => {
    const spy = fakeReceiver({ secret: SECRET, prefix: "test:" });
    await new WebhookForwarder().forward(action("hmac", true), {}, { test: true });
    const { headers, body } = sentRequest(spy);
    expect(headers["x-karyl-signature-previous"]).toBe(
      signBody(PREVIOUS, "POST", "/hook", headers["x-karyl-timestamp"]!, headers["x-karyl-nonce"]!, body, { prefix: "test:" }),
    );
  });

  it("hmac: a response signed as a real one does not answer a test", async () => {
    fakeReceiver({ secret: SECRET });
    const result = await new WebhookForwarder().forward(action("hmac"), {}, { test: true });
    expect(result).toMatchObject({ ok: false, error: "response signature mismatch" });
  });

  it("hmac: a response signed as a test does not answer a real request", async () => {
    fakeReceiver({ secret: SECRET, prefix: "test:" });
    const result = await new WebhookForwarder().forward(action("hmac"), {});
    expect(result).toMatchObject({ ok: false, error: "response signature mismatch" });
  });

  it("token: sends the token under the test header only", async () => {
    const spy = fakeReceiver({ secret: null });
    await new WebhookForwarder().forward(action("token", true), {}, { test: true });
    const { headers } = sentRequest(spy);
    expect(headers["x-plugin-webhook-token"]).toBeUndefined();
    expect(headers["x-plugin-webhook-token-previous"]).toBeUndefined();
    expect(headers["x-plugin-webhook-test-token"]).toBe(SECRET);
    expect(headers["x-plugin-webhook-test-token-previous"]).toBe(PREVIOUS);
    expect(headers["x-karyl-test"]).toBe("1");
  });

  it("no auth: only the test marker", async () => {
    const spy = fakeReceiver({ secret: null });
    await new WebhookForwarder().forward(action(null), {}, { test: true });
    expect(sentRequest(spy).headers["x-karyl-test"]).toBe("1");
  });

  it("a real request carries no test marker", async () => {
    const spy = fakeReceiver({ secret: SECRET });
    await new WebhookForwarder().forward(action("hmac"), {});
    expect(sentRequest(spy).headers).not.toHaveProperty("x-karyl-test");
  });
});
