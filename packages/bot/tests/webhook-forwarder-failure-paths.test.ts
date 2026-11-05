/**
 * #124 — the forwarder's failure paths, at its public seam (`forward`):
 *
 *   - a receiver that never answers is cut off by the timeout (injected
 *     short here; production keeps 10 s) and the forward fails, no throw
 *   - a receiver that can't be reached fails as a network error
 *   - hmac mode refuses an unsigned response (fail closed)
 *   - token mode relays an unsigned response but warns once per behavior;
 *     an empty body warns nothing; a response signed with the wrong
 *     secret is refused
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
import { botEventLog } from "../src/modules/bot-events/bot-event-log.js";
import { encryptSecret } from "../src/utils/crypto.js";
import {
  emptyReceiver,
  fakeReceiver,
  hangingReceiver,
  unreachableReceiver,
} from "./webhook-receiver-fake.js";

const SECRET = "shared-secret";

// a fresh behavior id per action: the unsigned-response warning is deduped
// per behavior within the bot-event dedup window, which outlives a test
let nextBehaviorId = 1240;
function action(authMode: "hmac" | "token" | null): BehaviorWebhookActionRow {
  return {
    behaviorId: nextBehaviorId++,
    url: encryptSecret("https://203.0.113.10/hook"),
    secret: authMode ? encryptSecret(SECRET) : null,
    authMode,
    previousSecret: null,
    previousSecretExpiresAt: null,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(botEventLog.record).mockClear();
});

/** The "relayed unauthenticated" warnings logged for `behaviorId`. */
function unsignedWarnings(behaviorId: number) {
  return vi
    .mocked(botEventLog.record)
    .mock.calls.filter(
      ([level, , msg]) =>
        level === "warn" &&
        String(msg).includes(`behavior ${behaviorId} `) &&
        String(msg).includes("unsigned response"),
    );
}

describe("a receiver that does not answer", () => {
  it("is cut off by the timeout and the forward fails", async () => {
    hangingReceiver();
    const started = Date.now();
    const result = await new WebhookForwarder(undefined, 50).forward(action(null), {});
    expect(result).toMatchObject({
      ok: false,
      reply: {},
      error: expect.stringMatching(/^network error: .*(abort|timeout)/i),
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("a receiver that cannot be reached", () => {
  it("fails the forward as a network error", async () => {
    unreachableReceiver(new TypeError("fetch failed"));
    expect(await new WebhookForwarder().forward(action(null), {})).toEqual({
      ok: false,
      reply: {},
      notes: [],
      error: "network error: fetch failed",
    });
  });
});

describe("hmac mode: an unsigned response", () => {
  it("is refused as a response signature failure", async () => {
    fakeReceiver({ secret: null });
    expect(await new WebhookForwarder().forward(action("hmac"), {})).toMatchObject({
      ok: false,
      reply: {},
      status: 200,
      errorCode: "response_signature",
      error: "missing X-Karyl-Timestamp on response",
    });
  });
});

describe("token mode: an unsigned response", () => {
  it("is relayed, unverified, and warned about once per behavior", async () => {
    const tokenAction = action("token");
    const forwarder = new WebhookForwarder();
    fakeReceiver({ secret: null, body: { content: "pong" } });

    const first = await forwarder.forward(tokenAction, {});
    const second = await forwarder.forward(tokenAction, {});

    expect(first).toEqual({ ok: true, reply: { content: "pong" }, notes: [] });
    expect(second).toEqual({ ok: true, reply: { content: "pong" }, notes: [] });
    expect(unsignedWarnings(tokenAction.behaviorId)).toHaveLength(1);
  });

  it("warns separately for each behavior", async () => {
    const [a, b] = [action("token"), action("token")];
    fakeReceiver({ secret: null });
    await new WebhookForwarder().forward(a, {});
    await new WebhookForwarder().forward(b, {});
    expect(unsignedWarnings(a.behaviorId)).toHaveLength(1);
    expect(unsignedWarnings(b.behaviorId)).toHaveLength(1);
  });

  it("an empty body relays nothing and warns nothing", async () => {
    const tokenAction = action("token");
    const forwarder = new WebhookForwarder();
    emptyReceiver();
    expect(await forwarder.forward(tokenAction, {})).toEqual({ ok: true, reply: {}, notes: [] });
    expect(unsignedWarnings(tokenAction.behaviorId)).toHaveLength(0);

    // ...and did not use up the behavior's one warning
    vi.restoreAllMocks();
    fakeReceiver({ secret: null });
    await forwarder.forward(tokenAction, {});
    expect(unsignedWarnings(tokenAction.behaviorId)).toHaveLength(1);
  });
});

describe("token mode: a response signed with the wrong secret", () => {
  it("is refused as a response signature failure", async () => {
    fakeReceiver({ secret: "not-the-shared-secret" });
    expect(await new WebhookForwarder().forward(action("token"), {})).toMatchObject({
      ok: false,
      reply: {},
      status: 200,
      errorCode: "response_signature",
      error: "response signature mismatch",
    });
  });
});
