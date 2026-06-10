/**
 * hmac mode is fail-CLOSED by contract. If the webhook secret can't be
 * decrypted (e.g. an encryption key was rotated out, leaving the stored
 * ciphertext's keyId unknown — a reachable operational state), the forwarder
 * must REFUSE to deliver rather than silently sending the request unsigned and
 * relaying an unverified response into the user's DM. These tests lock that in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

// Let the host-policy check pass so we exercise the forward/verify path.
vi.mock("../src/utils/host-policy.js", () => ({
  assertExternalTarget: vi.fn().mockResolvedValue(undefined),
  HostPolicyError: class HostPolicyError extends Error {},
}));

import type { BehaviorRow } from "../src/modules/behavior/models/behavior.model.js";
import { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { encryptSecret } from "../src/utils/crypto.js";
import { buildOutboundSignatureHeaders } from "../src/utils/hmac.js";

const HOOK_URL = "http://203.0.113.10/hook";

function hmacBehavior(webhookSecret: string | null): BehaviorRow {
  return {
    id: 1,
    source: "custom",
    webhookUrl: encryptSecret(HOOK_URL),
    webhookSecret,
    webhookAuthMode: "hmac",
  } as unknown as BehaviorRow;
}

describe("WebhookForwarder hmac fail-closed", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses to forward (no POST) when an hmac secret can't be decrypted", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    // A well-formed v2 ciphertext whose keyId no longer exists (rotated out)
    // → decryptSecret throws → safeDecrypt returns null. Pre-fix the forwarder
    // sent this unsigned and skipped response verification (ok:true).
    const result = await new WebhookForwarder().forward(
      hmacBehavior("v2:rotatedKeyId:aaa:bbb:ccc"),
      { content: "hi" },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/hmac/i);
    expect(fetchSpy).not.toHaveBeenCalled(); // never sent unsigned
  });

  it("still delivers when the hmac secret is valid and the response is signed", async () => {
    const secret = "shared-hmac-secret";
    const responseBody = JSON.stringify({ content: "pong" });
    // The webhook signs its response with the shared secret over the SAME
    // canonical form the forwarder verifies (POST + the URL path + body).
    const headers = buildOutboundSignatureHeaders(
      secret,
      "POST",
      "/hook",
      responseBody,
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(responseBody, { status: 200, headers }));

    const result = await new WebhookForwarder().forward(
      hmacBehavior(encryptSecret(secret)),
      { content: "hi" },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1); // guard did NOT block a valid hmac behavior
    expect(result.ok).toBe(true);
    expect(result.relayContent).toBe("pong");
  });
});
