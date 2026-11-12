/**
 * #214 — a plugin RPC's own attachments (`messages.send`,
 * `interactions.respond`, `interactions.followup`), observed over HTTP
 * against a real local HTTP server standing in for the plugin. They
 * download as a plugin action reply's do (#203, `downloadReplyFiles`):
 *
 *   - each `path` is fetched from under the plugin's registered URL, path
 *     prefix included, over the connection pinned to the address the
 *     plugin target policy checked (the host is `rebind.invalid`, which
 *     never resolves — the #197 pinned-agent pattern)
 *   - 8 MiB a file, cut off as it streams; 25 MiB together
 *   - a `..` out of the prefix, a redirect and a hang (one timeout for
 *     the call) all fail it with a 400 carrying downloadReplyFiles' error
 *   - one batch per plugin at a time: a plugin's second call waits on its
 *     own turn without holding a process-wide one
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

// ── module-level mocks ──────────────────────────────────────────────────────

vi.mock("../src/modules/plugin-system/models/plugin.model.js", () => ({
  findPluginById: vi.fn(),
  findPluginByKey: vi.fn(),
}));

vi.mock("../src/utils/host-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/host-policy.js")>()),
  // vouch for the local plugin at an address its hostname never resolves to
  resolvePluginTarget: vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]),
}));

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
  setBotEventLogMetric: vi.fn(),
}));

vi.mock("../src/modules/bot-events/bot-event-dedup.js", () => ({
  shouldRecord: vi.fn(() => true),
}));

// ── imports after mocks ─────────────────────────────────────────────────────

import type { FastifyInstance } from "fastify";
import { createWebServer } from "../src/modules/web-core/server.js";
import { pluginAuthStore } from "../src/modules/plugin-system/plugin-auth.service.js";
import { findPluginById } from "../src/modules/plugin-system/models/plugin.model.js";
import { resolvePluginTarget } from "../src/utils/host-policy.js";
import {
  MAX_REPLY_ATTACHMENT_BYTES,
  MAX_REPLY_ATTACHMENT_TOTAL_BYTES,
} from "../src/modules/command-system/behavior-reply.js";

const MiB = 1024 * 1024;
const CHANNEL_ID = "chan-1";
const TOKEN = "interaction-token-abc";
/** Bearer token → plugin id; every plugin has every scope. */
const PLUGINS: Record<string, number> = { "token-a": 1, "token-b": 2 };

let files: Server;
let port: number;
const received: Array<{ url?: string; host?: string }> = [];
/** Answers to /p/hold requests, sent when a test releases them, by `?who=`. */
let held: Array<{ who: string; answer: () => void }> = [];
/** Whether the 9 MiB stream was written out to the end. */
let streamedToTheEnd = false;

beforeAll(async () => {
  files = createServer((req: IncomingMessage, res) => {
    received.push({ url: req.url, host: req.headers.host });
    const [path, query = ""] = (req.url ?? "").split("?");
    switch (path) {
      case "/p/files/a.png":
        res.writeHead(200, { "content-type": "image/png" });
        res.end("PNG-A");
        return;
      case "/p/streamed-big": {
        // no Content-Length: the cap has to be counted while streaming
        res.writeHead(200, { "transfer-encoding": "chunked" });
        const chunk = Buffer.alloc(MiB, 2);
        let sent = 0;
        const pump = () => {
          while (sent < 9) {
            sent += 1;
            if (!res.write(chunk)) return void res.once("drain", pump);
          }
          res.end(() => {
            streamedToTheEnd = true;
          });
        };
        res.on("error", () => {});
        pump();
        return;
      }
      case "/p/seven":
        res.writeHead(200, { "transfer-encoding": "chunked" });
        res.on("error", () => {});
        res.end(Buffer.alloc(7 * MiB, 3));
        return;
      case "/secret":
        res.writeHead(200);
        res.end("outside the plugin's prefix");
        return;
      case "/p/redirect":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      case "/p/hang":
        return; // never answers
      case "/p/hold":
        held.push({
          who: new URLSearchParams(query).get("who") ?? "",
          answer: () => {
            res.writeHead(200);
            res.end("held");
          },
        });
        return;
      default:
        res.writeHead(404);
        res.end("not found");
    }
  });
  await new Promise<void>((r) => files.listen(0, "127.0.0.1", r));
  port = (files.address() as AddressInfo).port;
});

afterAll(async () => {
  files.closeAllConnections();
  await new Promise<void>((r) => files.close(() => r()));
});

function fakeRest() {
  return {
    post: vi.fn().mockResolvedValue({ id: "followup-1" }),
    patch: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeBot(rest: ReturnType<typeof fakeRest>, send: ReturnType<typeof vi.fn>) {
  return {
    user: { id: "bot-1" },
    application: { id: "app-1" },
    isReady: () => true,
    uptime: 0,
    guilds: { cache: new Map() },
    channels: {
      fetch: vi.fn().mockResolvedValue({
        id: CHANNEL_ID,
        isTextBased: () => true,
        isDMBased: () => true,
        send,
      }),
    },
    rest,
  };
}

let server: FastifyInstance;
let rest: ReturnType<typeof fakeRest>;
let send: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  received.length = 0;
  held = [];
  streamedToTheEnd = false;
  vi.spyOn(pluginAuthStore, "verify").mockImplementation((token: string) =>
    PLUGINS[token] === undefined
      ? null
      : {
          pluginId: PLUGINS[token]!,
          pluginKey: `plugin-${PLUGINS[token]}`,
          scopes: new Set(["messages.send", "interactions.respond", "interactions.followup"]),
          expiresAt: Date.now() + 60_000,
        },
  );
  vi.mocked(findPluginById).mockImplementation(
    async (id: number) =>
      ({
        id,
        pluginKey: `plugin-${id}`,
        // a path prefix: every attachment path is resolved under it
        url: `http://rebind.invalid:${port}/p/`,
        enabled: true,
        status: "active",
        // no guild features: Guild Reach passes unconditionally
        manifestJson: "{}",
      }) as never,
  );
  rest = fakeRest();
  send = vi.fn().mockResolvedValue({ id: "msg-1", channelId: CHANNEL_ID });
  server = await createWebServer({
    staticRoot: undefined,
    bot: fakeBot(rest, send) as never,
    pluginAttachmentTimeoutMs: 1000,
  });
  await server.ready();
});

afterEach(async () => {
  for (const { answer } of held) answer();
  await server.close();
});

function rpc(method: string, payload: Record<string, unknown>, token = "token-a") {
  return server.inject({
    method: "POST",
    url: `/api/plugin/${method}`,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as never,
  });
}

function sendWith(attachments: unknown, token = "token-a") {
  return rpc("messages.send", { channel_id: CHANNEL_ID, content: "hi", attachments }, token);
}

/** Wait until the plugin holds `n` /p/hold requests open. */
async function untilHeld(n: number) {
  for (let i = 0; i < 200 && held.length < n; i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(held).toHaveLength(n);
}

function releaseHeld() {
  const all = held;
  held = [];
  for (const { answer } of all) answer();
}

describe("plugin RPC attachments — the three routes download them", () => {
  it("messages.send fetches each path under the plugin URL's prefix, pinned to the checked address", async () => {
    const res = await sendWith([{ name: "chart.png", path: "/files/a.png" }]);

    expect(res.statusCode).toBe(200);
    // the hostname never resolves: only the pinned connection gets there
    expect(resolvePluginTarget).toHaveBeenCalledWith("rebind.invalid", port);
    expect(received).toEqual([{ url: "/p/files/a.png", host: `rebind.invalid:${port}` }]);
    const [options] = send.mock.calls[0] as [{ files: Array<{ name: string; attachment: Buffer }> }];
    expect(options.files.map((f) => [f.name, Buffer.from(f.attachment).toString("utf8")])).toEqual([
      ["chart.png", "PNG-A"],
    ]);
  });

  it("interactions.respond sends the downloaded files with the PATCH", async () => {
    const res = await rpc("interactions.respond", {
      interaction_token: TOKEN,
      content: "here",
      attachments: [{ name: "chart.png", path: "/files/a.png" }],
    });

    expect(res.statusCode).toBe(200);
    expect(received).toEqual([{ url: "/p/files/a.png", host: `rebind.invalid:${port}` }]);
    const [, options] = rest.patch.mock.calls[0] as [string, { files: Array<{ name: string; data: Buffer }> }];
    expect(options.files.map((f) => [f.name, f.data.toString("utf8")])).toEqual([["chart.png", "PNG-A"]]);
  });

  it("interactions.followup sends the downloaded files with the POST", async () => {
    const res = await rpc("interactions.followup", {
      interaction_token: TOKEN,
      content: "more",
      attachments: [{ name: "chart.png", path: "/files/a.png" }],
    });

    expect(res.statusCode).toBe(200);
    expect(received).toEqual([{ url: "/p/files/a.png", host: `rebind.invalid:${port}` }]);
    const [, options] = rest.post.mock.calls[0] as [string, { files: Array<{ name: string; data: Buffer }> }];
    expect(options.files.map((f) => [f.name, f.data.toString("utf8")])).toEqual([["chart.png", "PNG-A"]]);
  });

  it("interactions.respond refuses a failed download with a 400, before anything reaches Discord", async () => {
    const res = await rpc("interactions.respond", {
      interaction_token: TOKEN,
      content: "here",
      attachments: [{ name: "x", path: "/redirect" }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'attachment error: attachment 1 ("x"): a redirect (HTTP 302); redirects are not followed',
    });
    expect(rest.patch).not.toHaveBeenCalled();
    expect(rest.post).not.toHaveBeenCalled();
  });

  it("interactions.followup refuses a path out of the prefix with a 400", async () => {
    const res = await rpc("interactions.followup", {
      interaction_token: TOKEN,
      content: "more",
      attachments: [{ name: "x", path: "/../secret" }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'attachment error: attachment 1 ("x"): the path leaves the base URL' });
    expect(received).toHaveLength(0);
    expect(rest.post).not.toHaveBeenCalled();
  });
});

describe("plugin RPC attachments — the download rules", () => {
  it("cuts a file off once it streams past 8 MiB", async () => {
    expect(MAX_REPLY_ATTACHMENT_BYTES).toBe(8 * MiB);
    const res = await sendWith([{ name: "x.bin", path: "/streamed-big" }]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'attachment error: attachment 1 ("x.bin"): larger than 8 MiB' });
    // the read stopped at the cap: the plugin never got to write all 9 MiB
    expect(streamedToTheEnd).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses files that together pass 25 MiB", async () => {
    expect(MAX_REPLY_ATTACHMENT_TOTAL_BYTES).toBe(25 * MiB);
    const four = Array.from({ length: 4 }, (_, i) => ({ name: `${i}.bin`, path: "/seven" }));
    const res = await sendWith(four);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'attachment error: attachment 4 ("3.bin"): the files together are larger than 25 MiB',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a `..` that climbs out of the plugin URL's prefix, without fetching it", async () => {
    const res = await sendWith([{ name: "x", path: "/../secret" }]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'attachment error: attachment 1 ("x"): the path leaves the base URL' });
    expect(received).toHaveLength(0);
  });

  it("never follows a redirect", async () => {
    const res = await sendWith([{ name: "x", path: "/redirect" }]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'attachment error: attachment 1 ("x"): a redirect (HTTP 302); redirects are not followed',
    });
    expect(received.map((r) => r.url)).toEqual(["/p/redirect"]);
  });

  it("gives up when the call's downloads outlast the timeout", async () => {
    const started = Date.now();
    const res = await sendWith([{ name: "x", path: "/hang" }]);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^attachment error: attachment 1 \("x"\): network error: /);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(send).not.toHaveBeenCalled();
  });

  it("checks descriptors with the webhook's rules: a name Discord can't take is refused", async () => {
    const res = await sendWith([{ name: "../x.png", path: "/files/a.png" }]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "attachment error: attachment 1: name has a slash, a backslash or a control character",
    });
    expect(received).toHaveLength(0);
  });

  it("refuses a descriptor that is not a { name, path } of strings", async () => {
    const notAnArray = await sendWith({ name: "x", path: "/files/a.png" });
    expect(notAnArray.json()).toEqual({ error: "attachment error: attachments must be an array" });
    const notAnObject = await sendWith(["x"]);
    expect(notAnObject.json()).toEqual({ error: "attachment error: attachment 1: must be an object" });
    const numberPath = await sendWith([{ name: "x", path: 1 }]);
    expect(numberPath.json()).toEqual({ error: "attachment error: attachment 1: name and path must be strings" });
    expect(received).toHaveLength(0);
  });

  it("downloads one batch per plugin at a time; another plugin still gets a turn", async () => {
    const first = sendWith([{ name: "x", path: "/hold?who=a1" }], "token-a");
    await untilHeld(1);
    // the same plugin's second call waits on its own turn ...
    const second = sendWith([{ name: "x", path: "/hold?who=a2" }], "token-a");
    // ... so another plugin gets the second process-wide turn
    const other = sendWith([{ name: "x", path: "/hold?who=b" }], "token-b");
    await untilHeld(2);
    expect(held.map((h) => h.who).sort()).toEqual(["a1", "b"]);

    releaseHeld();
    await untilHeld(1);
    expect(held.map((h) => h.who)).toEqual(["a2"]);
    releaseHeld();
    expect((await Promise.all([first, second, other])).map((r) => r.statusCode)).toEqual([200, 200, 200]);
  });
});
