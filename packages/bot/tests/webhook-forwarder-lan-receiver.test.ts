/**
 * #134 end to end, nothing mocked: the real webhook target policy, the
 * real allowlist and the real pinned connection, against a receiver on
 * this machine's first private (non-loopback) IPv4 — loopback is always
 * refused, so the receiver cannot use it (same placement as the e2e
 * harness in e2e/src/behavior-and-dm.e2e.ts). Skips cleanly on a
 * machine without a private IPv4 interface.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
});

import { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import type { BehaviorWebhookActionRow } from "../src/modules/behavior/models/behavior-webhook-action.model.js";
import { encryptSecret } from "../src/utils/crypto.js";
import { classifyAddress } from "../src/utils/ip-address.js";
import { parseAllowlistEntries } from "../src/utils/webhook-allowlist.js";

function firstPrivateIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (
        addr.family === "IPv4" &&
        !addr.internal &&
        classifyAddress(addr.address) === "private"
      ) {
        return addr.address;
      }
    }
  }
  return null;
}

const lanIp = firstPrivateIPv4();

describe.skipIf(lanIp === null)("webhook forward to a LAN receiver (real policy)", () => {
  let server: Server;
  let url: string;
  const received: Array<{ url: string | undefined; body: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ url: req.url, body });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ content: "hello from the LAN" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, lanIp!, r));
    url = `http://${lanIp}:${(server.address() as AddressInfo).port}/hook`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    received.length = 0;
  });

  function behavior(): BehaviorWebhookActionRow {
    return {
      behaviorId: 1,
      url: encryptSecret(url),
      secret: null,
      authMode: null,
      previousSecret: null,
      previousSecretExpiresAt: null,
    };
  }

  it("delivers over plain http when the receiver's IP is allowlisted", async () => {
    const forwarder = new WebhookForwarder(parseAllowlistEntries([lanIp!]));
    const result = await forwarder.forward(behavior(), { content: "ping" });

    expect(result).toMatchObject({ ok: true, reply: { content: "hello from the LAN" } });
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe("/hook?wait=true");
    expect(JSON.parse(received[0].body)).toEqual({ content: "ping" });
  });

  it("refuses the same URL without the allowlist, sending nothing", async () => {
    const forwarder = new WebhookForwarder(parseAllowlistEntries([]));
    const result = await forwarder.forward(behavior(), { content: "ping" });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "private_not_allowlisted",
    });
    expect(result.error).toContain("WEBHOOK_PRIVATE_ALLOWLIST");
    expect(received).toHaveLength(0);
  });
});
