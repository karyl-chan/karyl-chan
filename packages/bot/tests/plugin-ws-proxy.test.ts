/**
 * #272 — the plugin proxy forwards WebSocket Upgrade under /plugin/<key>/.
 *
 * Everything goes over real TCP: a Fastify instance with the WS proxy
 * attached listens on loopback, and an in-test node:http server stands in
 * for the plugin with a minimal RFC 6455 handshake + text-frame echo. The
 * client is Node's global `WebSocket` (echo round trip) or a raw
 * `http.request` upgrade (status codes, forwarded headers). Host policy is
 * mocked to vet loopback, like the HTTP proxy tests.
 */
import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
});

const hostPolicy = vi.hoisted(() => ({ refuse: false }));

vi.mock("../src/utils/host-policy.js", () => {
  class HostPolicyError extends Error {}
  return {
    assertPluginTarget: vi.fn().mockResolvedValue(undefined),
    resolvePluginTarget: vi.fn(async () => {
      if (hostPolicy.refuse) throw new HostPolicyError("Plugin 目標不被允許");
      return [{ address: "127.0.0.1", family: 4 }];
    }),
    HostPolicyError,
  };
});

import { sequelize } from "../src/db.js";
import {
  Plugin,
  findPluginByKey,
} from "../src/modules/plugin-system/models/plugin.model.js";
import { invalidateAllPluginCache } from "../src/modules/plugin-system/plugin-lookup-cache.js";
import { emitPluginChange } from "../src/modules/plugin-system/plugin-changes.js";
import {
  attachPluginWsProxy,
  getPluginWsConnectionCounts,
  type PluginWsProxyOptions,
} from "../src/modules/plugin-system/plugin-ws-proxy.js";

// ── plugin test double: RFC 6455 handshake + text echo ─────────────────────

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface UpstreamUpgrade {
  url: string;
  headers: IncomingHttpHeaders;
}

/** Encode one unmasked (server → client) text frame. */
function serverTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const head = Buffer.alloc(4);
  head[0] = 0x81;
  head[1] = 126;
  head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

/** Decode masked client frames from `buf`; returns frames + leftover. */
function readClientFrames(buf: Buffer): {
  frames: { opcode: number; payload: Buffer }[];
  rest: Buffer;
} {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const opcode = buf[off] & 0x0f;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    }
    if (buf.length - p < 4 + len) break;
    const mask = buf.subarray(p, p + 4);
    p += 4;
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buf[p + i] ^ mask[i % 4];
    frames.push({ opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

function startPluginDouble(): Promise<{
  server: Server;
  port: number;
  upgrades: UpstreamUpgrade[];
  sockets: Set<Socket>;
}> {
  const upgrades: UpstreamUpgrade[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => {
    res.writeHead(200).end("http-ok");
  });
  server.on("upgrade", (req, socket: Socket) => {
    upgrades.push({ url: req.url ?? "", headers: req.headers });
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const path = (req.url ?? "").split("?")[0];
    if (path === "/deny") {
      const body = "go away";
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\n" +
          "Content-Type: text/plain\r\n" +
          `Content-Length: ${body.length}\r\n` +
          "Set-Cookie: s=1; Path=/; Domain=evil.example\r\n" +
          "\r\n" +
          body,
      );
      return;
    }
    if (path === "/hang") return; // never answers the handshake
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        "Set-Cookie: ws=1; Path=/; Domain=evil.example\r\n" +
        "\r\n",
    );
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      const { frames, rest } = readClientFrames(
        Buffer.concat([pending, chunk]),
      );
      pending = rest;
      for (const f of frames) {
        if (f.opcode === 0x1) {
          socket.write(serverTextFrame("echo:" + f.payload.toString("utf8")));
        } else if (f.opcode === 0x8) {
          socket.end(Buffer.from([0x88, 0x00]));
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        upgrades,
        sockets,
      }),
    );
  });
}

// ── raw upgrade client ──────────────────────────────────────────────────────

type RawResult =
  | {
      status: 101;
      headers: IncomingHttpHeaders;
      socket: Socket;
    }
  | { status: number; headers: IncomingHttpHeaders; body: string }
  | { status: "closed" };

function rawUpgrade(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<RawResult> {
  return new Promise((resolve) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.on("error", () => {});
      resolve({ status: 101, headers: res.headers, socket });
    });
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
      );
      res.on("error", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
      );
    });
    req.on("error", () => resolve({ status: "closed" }));
    req.end();
  });
}

function waitClose(socket: Socket, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    socket.once("close", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

/** Masked client text frame for a raw socket. */
function clientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([
    Buffer.from([0x81, 0x80 | payload.length]),
    mask,
    masked,
  ]);
}

function readOneServerText(socket: Socket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("data", (buf: Buffer) => {
      const len = buf[1] & 0x7f;
      resolve(buf.subarray(2, 2 + len).toString("utf8"));
    });
  });
}

// ── fixtures ────────────────────────────────────────────────────────────────

let upstream: Awaited<ReturnType<typeof startPluginDouble>>;
let bot: import("fastify").FastifyInstance | null = null;
let botPort = 0;

async function startBot(opts: PluginWsProxyOptions = {}): Promise<void> {
  const fastify = (await import("fastify")).default;
  const s = fastify({ logger: false });
  attachPluginWsProxy(s, opts);
  await s.listen({ port: 0, host: "127.0.0.1" });
  bot = s;
  botPort = (s.server.address() as AddressInfo).port;
}

async function createPlugin(
  pluginKey: string,
  overrides: { status?: "active" | "inactive"; enabled?: boolean } = {},
) {
  const row = await Plugin.create({
    pluginKey,
    name: pluginKey,
    version: "1.0.0",
    url: `http://127.0.0.1:${upstream.port}`,
    manifestJson: "{}",
    tokenHash: "x",
    status: overrides.status ?? "active",
    enabled: overrides.enabled ?? true,
  });
  invalidateAllPluginCache();
  return row as unknown as { id: number };
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
  upstream = await startPluginDouble();
});

beforeEach(async () => {
  hostPolicy.refuse = false;
  upstream.upgrades.length = 0;
  await Plugin.destroy({ where: {} });
  invalidateAllPluginCache();
});

afterEach(async () => {
  if (bot) await bot.close();
  bot = null;
});

afterAll(async () => {
  for (const s of upstream.sockets) s.destroy();
  await new Promise<void>((r) => upstream.server.close(() => r()));
  await sequelize.close();
});

// ── tests ───────────────────────────────────────────────────────────────────

describe("plugin WebSocket proxy", () => {
  it("round-trips an echo WebSocket at /plugin/<key>/ws through the bot", async () => {
    await createPlugin("echo-plugin");
    await startBot();

    const ws = new WebSocket(
      `ws://127.0.0.1:${botPort}/plugin/echo-plugin/ws?token=abc`,
    );
    const reply = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send("hello");
      ws.onmessage = (ev) => resolve(String(ev.data));
      ws.onerror = () => reject(new Error("ws error"));
    });
    ws.close();

    expect(reply).toBe("echo:hello");
    expect(upstream.upgrades[0].url).toBe("/ws?token=abc");
  });
});

describe("which plugins get a WebSocket", () => {
  it("refuses an unknown plugin with 404 before contacting anything", async () => {
    await startBot();
    const r = await rawUpgrade(botPort, "/plugin/nope/ws");
    expect(r.status).toBe(404);
    expect(upstream.upgrades).toHaveLength(0);
  });

  it("refuses a registered but disabled plugin with 404", async () => {
    await createPlugin("off-plugin", { enabled: false });
    await startBot();
    const r = await rawUpgrade(botPort, "/plugin/off-plugin/ws");
    expect(r.status).toBe(404);
    expect(upstream.upgrades).toHaveLength(0);
  });

  it("refuses an inactive plugin with 404", async () => {
    await createPlugin("gone-plugin", { status: "inactive" });
    await startBot();
    const r = await rawUpgrade(botPort, "/plugin/gone-plugin/ws");
    expect(r.status).toBe(404);
  });

  it("refuses upgrades outside /plugin/<key>/", async () => {
    await createPlugin("echo-plugin");
    await startBot();
    expect((await rawUpgrade(botPort, "/api/dm/events")).status).toBe(404);
    expect((await rawUpgrade(botPort, "/plugin/echo-plugin")).status).toBe(404);
    expect((await rawUpgrade(botPort, "/plugin/Bad_Key/ws")).status).toBe(404);
    expect(upstream.upgrades).toHaveLength(0);
  });

  it("answers 502 when host policy refuses the plugin's target", async () => {
    await createPlugin("echo-plugin");
    await startBot();
    hostPolicy.refuse = true;
    const r = await rawUpgrade(botPort, "/plugin/echo-plugin/ws");
    expect(r.status).toBe(502);
    expect(upstream.upgrades).toHaveLength(0);
  });
});

describe("Origin check", () => {
  it("refuses a cross-site Origin with 403", async () => {
    await createPlugin("echo-plugin");
    await startBot({ baseUrl: "https://bot.example" });
    const r = await rawUpgrade(botPort, "/plugin/echo-plugin/ws", {
      Origin: "https://evil.example",
    });
    expect(r.status).toBe(403);
    expect(upstream.upgrades).toHaveLength(0);
  });

  it("allows the WEB_BASE_URL origin, the request Host's origin, and no Origin", async () => {
    await createPlugin("echo-plugin");
    await startBot({ baseUrl: "https://bot.example/" });
    const fromBase = await rawUpgrade(botPort, "/plugin/echo-plugin/ws", {
      Origin: "https://bot.example",
    });
    const fromHost = await rawUpgrade(botPort, "/plugin/echo-plugin/ws", {
      Origin: `http://127.0.0.1:${botPort}`,
    });
    const none = await rawUpgrade(botPort, "/plugin/echo-plugin/ws");
    for (const r of [fromBase, fromHost, none]) {
      expect(r.status).toBe(101);
      if (r.status === 101 && "socket" in r) r.socket.destroy();
    }
  });
});

describe("what the plugin receives and returns", () => {
  it("strips the cookie and the client's forwarding chain, keeps authorization", async () => {
    await createPlugin("echo-plugin");
    await startBot();
    const r = await rawUpgrade(botPort, "/plugin/echo-plugin/ws", {
      Cookie: "karyl_session=secret",
      "X-Forwarded-For": "6.6.6.6",
      "X-Real-IP": "6.6.6.6",
      Forwarded: "for=6.6.6.6",
      Authorization: "Bearer plugin-token",
    });
    expect(r.status).toBe(101);
    if ("socket" in r) r.socket.destroy();
    const seen = upstream.upgrades[0].headers;
    expect(seen.cookie).toBeUndefined();
    expect(seen["x-real-ip"]).toBeUndefined();
    expect(seen.forwarded).toBeUndefined();
    expect(seen["x-forwarded-for"]).toBe("127.0.0.1");
    expect(seen.authorization).toBe("Bearer plugin-token");
  });

  it("scopes a set-cookie on the 101 to the plugin prefix", async () => {
    await createPlugin("echo-plugin");
    await startBot();
    const r = await rawUpgrade(botPort, "/plugin/echo-plugin/ws");
    expect(r.status).toBe(101);
    if ("socket" in r) r.socket.destroy();
    expect(r.status === 101 && r.headers["set-cookie"]).toEqual([
      "ws=1; Path=/plugin/echo-plugin/",
    ]);
  });

  it("relays a non-101 reply (status, headers, body) and closes", async () => {
    await createPlugin("echo-plugin");
    await startBot();
    const r = await rawUpgrade(botPort, "/plugin/echo-plugin/deny");
    expect(r.status).toBe(401);
    expect("body" in r && r.body).toBe("go away");
    expect(r.status === 401 && r.headers["set-cookie"]).toEqual([
      "s=1; Path=/plugin/echo-plugin/",
    ]);
  });
});

describe("connection caps", () => {
  it("refuses with 429 once an IP has its concurrent connections open", async () => {
    await createPlugin("echo-plugin");
    await startBot({ limits: { concurrentPerIp: 2 } });
    const a = await rawUpgrade(botPort, "/plugin/echo-plugin/ws");
    const b = await rawUpgrade(botPort, "/plugin/echo-plugin/ws");
    const c = await rawUpgrade(botPort, "/plugin/echo-plugin/ws");
    expect([a.status, b.status, c.status]).toEqual([101, 101, 429]);
    // Closing one frees its slot.
    if ("socket" in a) {
      a.socket.destroy();
      await waitClose(a.socket);
    }
    await new Promise((r) => setTimeout(r, 50));
    const d = await rawUpgrade(botPort, "/plugin/echo-plugin/ws");
    expect(d.status).toBe(101);
    for (const r of [b, d]) if ("socket" in r) r.socket.destroy();
  });

  it("refuses with 429 once a plugin has its concurrent connections open", async () => {
    await createPlugin("echo-plugin");
    await startBot({ limits: { concurrentPerPlugin: 1 } });
    const a = await rawUpgrade(botPort, "/plugin/echo-plugin/ws");
    const b = await rawUpgrade(botPort, "/plugin/echo-plugin/ws");
    expect([a.status, b.status]).toEqual([101, 429]);
    if ("socket" in a) a.socket.destroy();
  });

  it("refuses with 429 past the per-IP attempt rate", async () => {
    await startBot({ limits: { attemptsPerIpPerMinute: 2 } });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await rawUpgrade(botPort, "/plugin/nope/ws")).status);
    }
    expect(statuses).toEqual([404, 404, 429]);
  });

  it("reports open connections per plugin for the metrics gauge", async () => {
    await createPlugin("echo-plugin");
    await startBot();
    const a = await rawUpgrade(botPort, "/plugin/echo-plugin/ws");
    expect(getPluginWsConnectionCounts()).toEqual([
      { pluginKey: "echo-plugin", connections: 1 },
    ]);
    const { metricsRegistry } =
      await import("../src/modules/web-core/metrics.js");
    expect(
      await metricsRegistry.getSingleMetricAsString(
        "karyl_plugin_ws_connections",
      ),
    ).toMatch(
      /karyl_plugin_ws_connections\{[^}]*plugin_id="echo-plugin"[^}]*\} 1/,
    );
    if ("socket" in a) {
      a.socket.destroy();
      await waitClose(a.socket);
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(getPluginWsConnectionCounts()).toEqual([]);
  });
});

describe("connection lifetime", () => {
  it.each([
    [
      "disabled",
      (row: Awaited<ReturnType<typeof findPluginByKey>>) => ({
        pluginId: row!.id,
        row: { ...row!, enabled: false },
      }),
    ],
    [
      "deactivated",
      (row: Awaited<ReturnType<typeof findPluginByKey>>) => ({
        pluginId: row!.id,
        row: { ...row!, status: "inactive" as const },
      }),
    ],
    [
      "unregistered",
      (row: Awaited<ReturnType<typeof findPluginByKey>>) => ({
        pluginId: row!.id,
        row: null,
      }),
    ],
  ])(
    "closes open connections when the plugin is %s",
    async (_label, change) => {
      await createPlugin("echo-plugin");
      await createPlugin("other-plugin");
      await startBot();
      const r = await rawUpgrade(botPort, "/plugin/echo-plugin/ws");
      const other = await rawUpgrade(botPort, "/plugin/other-plugin/ws");
      expect(r.status).toBe(101);
      if (!("socket" in r) || !("socket" in other)) return;

      emitPluginChange(change(await findPluginByKey("echo-plugin")));

      expect(await waitClose(r.socket)).toBe(true);
      // Another plugin's connection is untouched and still echoes.
      other.socket.write(clientTextFrame("still"));
      expect(await readOneServerText(other.socket)).toBe("echo:still");
      other.socket.destroy();
    },
  );

  it("ignores Plugin Changes that keep the plugin active and enabled", async () => {
    const row = await createPlugin("echo-plugin");
    await startBot();
    const r = await rawUpgrade(botPort, "/plugin/echo-plugin/ws");
    if (!("socket" in r)) throw new Error("no upgrade");
    emitPluginChange({ pluginId: row.id, guildId: "123" });
    emitPluginChange({ pluginId: row.id });
    emitPluginChange({
      pluginId: row.id,
      row: (await findPluginByKey("echo-plugin"))!,
    });
    r.socket.write(clientTextFrame("ping"));
    expect(await readOneServerText(r.socket)).toBe("echo:ping");
    r.socket.destroy();
  });

  it("answers 504 when the plugin does not complete the handshake in time", async () => {
    await createPlugin("echo-plugin");
    await startBot({ handshakeTimeoutMs: 200 });
    const r = await rawUpgrade(botPort, "/plugin/echo-plugin/hang");
    expect(r.status).toBe(504);
  });

  it("keeps an established connection past the handshake timeout", async () => {
    await createPlugin("echo-plugin");
    await startBot({ handshakeTimeoutMs: 200 });
    const r = await rawUpgrade(botPort, "/plugin/echo-plugin/ws");
    if (!("socket" in r)) throw new Error("no upgrade");
    await new Promise((res) => setTimeout(res, 500));
    r.socket.write(clientTextFrame("later"));
    expect(await readOneServerText(r.socket)).toBe("echo:later");
    r.socket.destroy();
  });

  it("destroys open connections when the bot's server closes", async () => {
    await createPlugin("echo-plugin");
    await startBot();
    const r = await rawUpgrade(botPort, "/plugin/echo-plugin/ws");
    if (!("socket" in r)) throw new Error("no upgrade");
    await bot!.close();
    bot = null;
    expect(await waitClose(r.socket)).toBe(true);
  });
});

describe("graceful close", () => {
  it("delivers the plugin's close frame before the connection ends", async () => {
    await createPlugin("echo-plugin");
    await startBot();
    const ws = new WebSocket(`ws://127.0.0.1:${botPort}/plugin/echo-plugin/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("ws error"));
    });
    const code = await new Promise<number>((resolve) => {
      ws.onclose = (ev) => resolve(ev.code);
      ws.close(1000);
    });
    // 1005 = the plugin's empty close frame arrived; 1006 would mean it was lost.
    expect(code).toBe(1005);
    await new Promise((r) => setTimeout(r, 50));
    expect(getPluginWsConnectionCounts()).toEqual([]);
  });
});
