/**
 * The webhook forwarder validates the configured destination host against
 * the SSRF host policy, but the POST itself must NOT follow 3xx redirects:
 * a redirect Location is attacker-controlled and would chase the request to
 * cloud metadata / internal hosts WITHOUT re-validation. These tests lock
 * in `redirect: "manual"` + the 3xx-as-failure handling.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

// Let the host-policy check pass so the test exercises the fetch/redirect
// path rather than the (separately-tested) host validation.
vi.mock("../src/utils/host-policy.js", () => ({
  assertExternalTarget: vi.fn().mockResolvedValue(undefined),
  HostPolicyError: class HostPolicyError extends Error {},
}));

import { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { encryptSecret } from "../src/utils/crypto.js";
import type { BehaviorRow } from "../src/modules/behavior/models/behavior.model.js";

function customBehavior(url: string): BehaviorRow {
  return {
    id: 1,
    source: "custom",
    webhookUrl: encryptSecret(url),
    webhookSecret: null,
    webhookAuthMode: null,
  } as unknown as BehaviorRow;
}

describe("WebhookForwarder redirect / SSRF handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not follow redirects and treats a 3xx as a failed delivery", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("redirecting", {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        }),
      );

    const fwd = new WebhookForwarder();
    const result = await fwd.forward(customBehavior("http://203.0.113.10/hook"), {
      content: "hi",
    });

    expect(result.ok).toBe(false);
    // 3xx is reported as a redirect failure, not relayed as content (this
    // message is unique to the explicit 3xx guard, so it also locks that
    // branch — the generic !res.ok path would echo the response body).
    expect(result.error).toContain("redirects are not followed");
    // The redirect target must never be fetched: exactly one request, and
    // fetch is explicitly told not to follow redirects.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const opts = fetchSpy.mock.calls[0][1] as RequestInit | undefined;
    expect(opts?.redirect).toBe("manual");
  });

  it("still delivers normally on a 2xx (redirect: manual does not break the happy path)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    const fwd = new WebhookForwarder();
    const result = await fwd.forward(customBehavior("http://203.0.113.10/hook"), {
      content: "hi",
    });

    expect(result.ok).toBe(true);
    const opts = fetchSpy.mock.calls[0][1] as RequestInit | undefined;
    expect(opts?.redirect).toBe("manual");
  });
});
