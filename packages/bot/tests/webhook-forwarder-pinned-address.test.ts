/**
 * #103 — DNS rebinding: the forwarder must connect to exactly the address
 * the host policy checked, never re-resolve the hostname at connect time.
 *
 * The policy is stubbed to vouch for `rebind.invalid` at 127.0.0.1 (the
 * local receiver). `.invalid` can never resolve (RFC 6761), so the POST
 * only lands if the connection is pinned to the checked address.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

vi.mock("../src/utils/host-policy.js", () => ({
  resolveWebhookTarget: vi.fn(async (u: string | URL) => ({
    url: new URL(u),
    addresses: [{ address: "127.0.0.1", family: 4 }],
  })),
  HostPolicyError: class HostPolicyError extends Error {},
}));

import { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { encryptSecret } from "../src/utils/crypto.js";
import type { BehaviorWebhookActionRow } from "../src/modules/behavior/models/behavior-webhook-action.model.js";

let server: Server;
let port: number;
const received: Array<{ host: string | undefined; url: string | undefined; body: string }> = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ host: req.headers.host, url: req.url, body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ content: "pinned ok" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("WebhookForwarder connects to the checked address", () => {
  it("POSTs to the pinned IP while keeping the hostname in the Host header", async () => {
    const behavior: BehaviorWebhookActionRow = {
      behaviorId: 1,
      url: encryptSecret(`http://rebind.invalid:${port}/hook`),
      secret: null,
      authMode: null,
    };

    const result = await new WebhookForwarder().forward(behavior, {
      content: "hi",
    });

    expect(result).toMatchObject({ ok: true, relayContent: "pinned ok" });
    expect(received).toHaveLength(1);
    expect(received[0].host).toBe(`rebind.invalid:${port}`);
    expect(received[0].url).toBe("/hook?wait=true");
    expect(JSON.parse(received[0].body)).toEqual({ content: "hi" });
  });
});
