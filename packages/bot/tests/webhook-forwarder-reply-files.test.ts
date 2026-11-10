/**
 * #156 — a webhook reply's attachments, at the forwarder's seam
 * (`fetchReplyFiles`), against a real local HTTP receiver serving files:
 *
 *   - each `path` is fetched from the webhook URL's origin (not its path),
 *     over the connection pinned to the address the target policy checked
 *     (the host is `rebind.invalid`, which never resolves), with no
 *     credentials
 *   - at most 5 files of at most 8 MiB each and 25 MiB together: a
 *     declared Content-Length over the cap and a body that streams past it
 *     are both cut off
 *   - at most 2 batches download at a time across the process; another
 *     waits its turn within its timeout
 *   - a redirect is never followed; a non-2xx, a hang (the timeout) and an
 *     unsafe path fail the whole set
 *   - the real target policy still applies: loopback and metadata never
 *     pass, a private address only when allowlisted
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
});

vi.mock("../src/utils/host-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/host-policy.js")>()),
  // vouch for the local receiver by default; the SSRF tests put the real policy back
  resolveWebhookTarget: vi.fn(async (u: string | URL) => ({
    url: new URL(u),
    addresses: [{ address: "127.0.0.1", family: 4 }],
  })),
}));

import * as hostPolicy from "../src/utils/host-policy.js";
import { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import {
  MAX_REPLY_ATTACHMENT_BYTES,
  MAX_REPLY_ATTACHMENT_TOTAL_BYTES,
} from "../src/modules/command-system/behavior-reply.js";
import { MAX_DOWNLOAD_BATCHES } from "../src/modules/command-system/webhook-forwarder.service.js";
import type { BehaviorWebhookActionRow } from "../src/modules/behavior/models/behavior-webhook-action.model.js";
import { encryptSecret } from "../src/utils/crypto.js";
import { parseAllowlistEntries } from "../src/utils/webhook-allowlist.js";

const realPolicy = await vi.importActual<typeof import("../src/utils/host-policy.js")>(
  "../src/utils/host-policy.js",
);

const MiB = 1024 * 1024;

let server: Server;
let port: number;
const received: Array<{ method?: string; url?: string; headers: IncomingMessage["headers"] }> = [];
/** Answers to /hold requests, sent when a test releases them; and how many were open at most. */
let held: Array<() => void> = [];
let holding = 0;
let maxHolding = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    received.push({ method: req.method, url: req.url, headers: req.headers });
    const path = (req.url ?? "").split("?")[0];
    switch (path) {
      case "/files/a.png":
        res.writeHead(200, { "content-type": "image/png" });
        res.end("PNG-A");
        return;
      case "/files/b.txt":
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("text-b");
        return;
      case "/exact":
        res.writeHead(200, { "content-length": String(MAX_REPLY_ATTACHMENT_BYTES) });
        res.end(Buffer.alloc(MAX_REPLY_ATTACHMENT_BYTES, 1));
        return;
      case "/declared-big":
        // says so up front: refused before the body is read
        res.writeHead(200, { "content-length": String(MAX_REPLY_ATTACHMENT_BYTES + 1) });
        res.end(Buffer.alloc(16));
        return;
      case "/streamed-big": {
        // no Content-Length: the cap has to be counted while streaming
        res.writeHead(200, { "transfer-encoding": "chunked" });
        const chunk = Buffer.alloc(MiB, 2);
        let sent = 0;
        const pump = () => {
          while (sent < 9) {
            sent += 1;
            if (!res.write(chunk)) return void res.once("drain", pump);
          }
          res.end();
        };
        res.on("error", () => {});
        pump();
        return;
      }
      case "/redirect":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      case "/hang":
        return; // never answers
      case "/seven": {
        // 7 MiB, streamed without a Content-Length
        res.writeHead(200, { "transfer-encoding": "chunked" });
        res.on("error", () => {});
        res.end(Buffer.alloc(7 * MiB, 3));
        return;
      }
      case "/hold":
        holding += 1;
        maxHolding = Math.max(maxHolding, holding);
        held.push(() => {
          holding -= 1;
          res.writeHead(200);
          res.end("held");
        });
        return;
      default:
        res.writeHead(404);
        res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  received.length = 0;
  held = [];
  holding = 0;
  maxHolding = 0;
});

/** Wait until `n` /hold requests are open. */
async function untilHolding(n: number) {
  for (let i = 0; i < 200 && holding < n; i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(holding).toBe(n);
}

function releaseHeld() {
  const all = held;
  held = [];
  for (const answer of all) answer();
}

function action(url = `http://rebind.invalid:${port}/hooks/weather?x=1`): BehaviorWebhookActionRow {
  return {
    behaviorId: 1,
    url: encryptSecret(url),
    secret: encryptSecret("shared-secret"),
    authMode: "token",
    previousSecret: null,
    previousSecretExpiresAt: null,
  };
}

const forwarder = () => new WebhookForwarder(parseAllowlistEntries([]), 2000);

describe("fetchReplyFiles — downloading", () => {
  it("fetches each path from the webhook URL's origin, pinned, without credentials", async () => {
    const result = await forwarder().fetchReplyFiles(action(), [
      { name: "chart.png", path: "/files/a.png" },
      { name: "notes.txt", path: "/files/b.txt?v=2" },
    ]);

    expect(result.ok).toBe(true);
    const files = result.ok ? result.files : [];
    expect(files.map((f) => [f.name, f.data.toString("utf8")])).toEqual([
      ["chart.png", "PNG-A"],
      ["notes.txt", "text-b"],
    ]);
    expect(received.map((r) => [r.method, r.url])).toEqual([
      ["GET", "/files/a.png"],
      ["GET", "/files/b.txt?v=2"],
    ]);
    for (const r of received) {
      expect(r.headers.host).toBe(`rebind.invalid:${port}`);
      expect(r.headers).not.toHaveProperty("x-plugin-webhook-token");
      expect(r.headers).not.toHaveProperty("x-karyl-signature");
      expect(r.headers).not.toHaveProperty("authorization");
    }
  });

  it("an empty list fetches nothing", async () => {
    expect(await forwarder().fetchReplyFiles(action(), [])).toEqual({ ok: true, files: [] });
    expect(received).toHaveLength(0);
  });

  it("takes a file of exactly 8 MiB", async () => {
    const result = await forwarder().fetchReplyFiles(action(), [{ name: "big.bin", path: "/exact" }]);
    expect(result.ok && result.files[0]!.data.byteLength).toBe(8 * MiB);
  });
});

describe("fetchReplyFiles — limits and failures", () => {
  it("refuses more than 5 files before fetching any", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `${i}.png`, path: "/files/a.png" }));
    const result = await forwarder().fetchReplyFiles(action(), six);
    expect(result).toEqual({ ok: false, error: "at most 5 attachments, got 6" });
    expect(received).toHaveLength(0);
  });

  it("refuses a declared Content-Length over 8 MiB", async () => {
    const result = await forwarder().fetchReplyFiles(action(), [{ name: "x.bin", path: "/declared-big" }]);
    expect(result).toEqual({ ok: false, error: 'attachment 1 ("x.bin"): larger than 8 MiB' });
  });

  it("cuts off a body that streams past 8 MiB", async () => {
    const result = await forwarder().fetchReplyFiles(action(), [{ name: "x.bin", path: "/streamed-big" }]);
    expect(result).toEqual({ ok: false, error: 'attachment 1 ("x.bin"): larger than 8 MiB' });
  });

  it("cuts off files that together pass 25 MiB", async () => {
    expect(MAX_REPLY_ATTACHMENT_TOTAL_BYTES).toBe(25 * MiB);
    const four = Array.from({ length: 4 }, (_, i) => ({ name: `${i}.bin`, path: "/seven" }));
    const result = await forwarder().fetchReplyFiles(action(), four);
    expect(result).toEqual({
      ok: false,
      error: 'attachment 4 ("3.bin"): the files together are larger than 25 MiB',
    });
    // three of 7 MiB fit
    const three = await forwarder().fetchReplyFiles(action(), four.slice(0, 3));
    expect(three.ok && three.files.length).toBe(3);
  });

  it("never follows a redirect", async () => {
    const result = await forwarder().fetchReplyFiles(action(), [{ name: "x.png", path: "/redirect" }]);
    expect(result).toEqual({
      ok: false,
      error: 'attachment 1 ("x.png"): a redirect (HTTP 302); redirects are not followed',
    });
    expect(received.map((r) => r.url)).toEqual(["/redirect"]);
  });

  it("fails the whole set on one missing file", async () => {
    const result = await forwarder().fetchReplyFiles(action(), [
      { name: "a.png", path: "/files/a.png" },
      { name: "gone.png", path: "/gone.png" },
    ]);
    expect(result).toEqual({ ok: false, error: 'attachment 2 ("gone.png"): HTTP 404' });
  });

  it("gives up on a receiver that does not answer within the timeout", async () => {
    const started = Date.now();
    const result = await new WebhookForwarder(parseAllowlistEntries([]), 100).fetchReplyFiles(action(), [
      { name: "slow.png", path: "/hang" },
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/^attachment 1 \("slow.png"\): network error: /);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("refuses a path that could leave the origin, sending nothing", async () => {
    for (const path of [
      `//evil.example:${port}/files/a.png`,
      `http://evil.example:${port}/files/a.png`,
      "/\\evil.example/files/a.png",
      "/%2F%2Fevil.example/files/a.png",
      "files/a.png",
    ]) {
      const result = await forwarder().fetchReplyFiles(action(), [{ name: "a.png", path }]);
      expect(result.ok, path).toBe(false);
      expect(!result.ok && result.error, path).toMatch(/^attachment 1: path /);
    }
    expect(received).toHaveLength(0);
  });
});

describe("fetchReplyFiles — the real target policy", () => {
  beforeEach(() => {
    vi.mocked(hostPolicy.resolveWebhookTarget).mockImplementationOnce(realPolicy.resolveWebhookTarget);
  });

  it("refuses a loopback origin, allowlisted or not", async () => {
    const result = await new WebhookForwarder(parseAllowlistEntries(["127.0.0.1"])).fetchReplyFiles(
      action(`http://127.0.0.1:${port}/hook`),
      [{ name: "a.png", path: "/files/a.png" }],
    );
    expect(result.ok).toBe(false);
    expect(received).toHaveLength(0);
  });

  it("refuses the cloud metadata address", async () => {
    const result = await forwarder().fetchReplyFiles(action("http://169.254.169.254/hook"), [
      { name: "a.png", path: "/latest/meta-data/" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("refuses a private address that is not allowlisted", async () => {
    const result = await forwarder().fetchReplyFiles(action("http://10.20.30.40/hook"), [
      { name: "a.png", path: "/a.png" },
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("WEBHOOK_PRIVATE_ALLOWLIST");
  });
});

describe("fetchReplyFiles — downloads in flight, process-wide", () => {
  it("runs at most 2 batches at a time; the next waits its turn", async () => {
    expect(MAX_DOWNLOAD_BATCHES).toBe(2);
    const batch = () =>
      new WebhookForwarder(parseAllowlistEntries([]), 3000).fetchReplyFiles(action(), [
        { name: "h.bin", path: "/hold" },
      ]);
    const runs = [batch(), batch(), batch()];
    await untilHolding(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(holding).toBe(2); // the third has not started
    releaseHeld();
    await untilHolding(1);
    releaseHeld();
    const results = await Promise.all(runs);
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(maxHolding).toBe(2);
  });

  it("fails a batch whose timeout ends while it waits", async () => {
    const long = () =>
      new WebhookForwarder(parseAllowlistEntries([]), 3000).fetchReplyFiles(action(), [
        { name: "h.bin", path: "/hold" },
      ]);
    const busy = [long(), long()];
    await untilHolding(2);
    const waited = await new WebhookForwarder(parseAllowlistEntries([]), 100).fetchReplyFiles(action(), [
      { name: "a.png", path: "/files/a.png" },
    ]);
    expect(waited).toEqual({
      ok: false,
      error: "timed out waiting for a download slot (the bot is downloading other replies' files)",
    });
    expect(received.filter((r) => r.url === "/files/a.png")).toHaveLength(0);
    releaseHeld();
    expect((await Promise.all(busy)).map((r) => r.ok)).toEqual([true, true]);
    // the turns came back: a new batch runs at once
    const after = await forwarder().fetchReplyFiles(action(), [{ name: "a.png", path: "/files/a.png" }]);
    expect(after.ok).toBe(true);
  });
});
