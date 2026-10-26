/**
 * A fake behavior webhook receiver for forwarder tests: stubs `fetch` with
 * a 200 JSON response, optionally signed the way the reply contract asks —
 * over `<METHOD>:<path>:<ts>:<request nonce>:<body>` (#102), with the
 * `test:` prefix when it answers a test-fire (#101).
 */
import { vi } from "vitest";
import { signBody } from "../src/utils/hmac.js";

export interface FakeReceiverOptions {
  /** Sign the response with this secret; null = unsigned. */
  secret: string | null;
  body?: unknown;
  /**
   * Which nonce the signature binds: the request's (the contract), a
   * nonce of the receiver's own (sent in X-Karyl-Nonce), or none (the
   * legacy nonce-less form).
   */
  nonce?: "request" | "own" | "none";
  /** Prepended to the signed string (`test:` for a test-fire). */
  prefix?: string;
}

export function fakeReceiver(opts: FakeReceiverOptions) {
  const raw = JSON.stringify(opts.body ?? { content: "pong" });
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.secret) {
      const sent = (init as { headers: Record<string, string> }).headers;
      const path = new URL(String(input)).pathname;
      const ts = String(Math.floor(Date.now() / 1000));
      const mode = opts.nonce ?? "request";
      const nonce =
        mode === "request" ? sent["x-karyl-nonce"]! : mode === "own" ? "0".repeat(32) : null;
      if (mode === "own") headers["x-karyl-nonce"] = nonce!;
      headers["x-karyl-timestamp"] = ts;
      headers["x-karyl-signature"] = signBody(
        opts.secret,
        "POST",
        path,
        ts,
        nonce,
        raw,
        { prefix: opts.prefix },
      );
    }
    return new Response(raw, { status: 200, headers });
  });
}

/** The headers and body of the n-th request the forwarder sent. */
export function sentRequest(
  fetchSpy: ReturnType<typeof fakeReceiver>,
  n = 0,
): { headers: Record<string, string>; body: string } {
  return fetchSpy.mock.calls[n]![1] as { headers: Record<string, string>; body: string };
}
