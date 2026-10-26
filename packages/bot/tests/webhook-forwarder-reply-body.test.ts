/**
 * #114 / #140 — the forwarder reads a webhook response as a Behavior Reply:
 *
 *   - the body is capped at 64 KiB; a larger one is a failed forward
 *   - a non-empty 2xx body that isn't a JSON object is a failed forward
 *     (it used to become an empty reply and vanish)
 *   - an empty body is an empty reply (the action chose not to answer)
 *   - what parsing dropped comes back as notes; unknown fields are logged
 *     once per behavior, not per message
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

let nextBehaviorId = 100;
function plainAction(): BehaviorWebhookActionRow {
  return {
    behaviorId: nextBehaviorId++,
    url: encryptSecret("http://203.0.113.10/hook"),
    secret: null,
    authMode: null,
    previousSecret: null,
    previousSecretExpiresAt: null,
  };
}

function respond(body: string, headers: Record<string, string> = {}) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(body, { status: 200, headers }),
  );
}

describe("WebhookForwarder — the response body", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(botEventLog.record).mockClear();
  });

  it("refuses a body over 64 KiB", async () => {
    respond(JSON.stringify({ content: "x".repeat(70 * 1024) }));
    const result = await new WebhookForwarder().forward(plainAction(), {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/64 KiB/);
    expect(result.reply).toEqual({});
  });

  it("refuses a 2xx body that is not JSON", async () => {
    respond("<html>oops</html>");
    const result = await new WebhookForwarder().forward(plainAction(), {});
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/not JSON/) });
  });

  it("refuses JSON that is not an object", async () => {
    respond("[1,2]");
    const result = await new WebhookForwarder().forward(plainAction(), {});
    expect(result).toMatchObject({ ok: false, error: "response body is not a JSON object" });
  });

  it("an empty body is an empty reply", async () => {
    respond("");
    expect(await new WebhookForwarder().forward(plainAction(), {})).toEqual({
      ok: true,
      reply: {},
      notes: [],
    });
  });

  it("returns what parsing dropped, and logs unknown fields once per behavior", async () => {
    const action = plainAction();
    const body = JSON.stringify({ content: "hi", attachments: [] });
    const forwarder = new WebhookForwarder();
    respond(body);
    const first = await forwarder.forward(action, {});
    respond(body);
    await forwarder.forward(action, {});

    expect(first).toEqual({
      ok: true,
      reply: { content: "hi" },
      notes: [{ kind: "unknown_fields", fields: ["attachments"] }],
    });
    const logged = vi
      .mocked(botEventLog.record)
      .mock.calls.filter(([, , msg]) => String(msg).includes("attachments"));
    expect(logged).toHaveLength(1);
  });
});
