/**
 * media-proxy (#158): the policy runs on every request, nothing is
 * followed, https is terminated here with verification, playlists are
 * rewritten so https keeps working, and the proxy is no open relay.
 *
 * Upstreams are loopback servers; a stub policy maps "allowed" names to
 * 127.0.0.1 and refuses the rest, so "refused" upstreams can count hits.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
  sniffBody,
  startMediaProxy,
  toProxyUrl,
  type MediaProxy,
} from "../src/media-proxy.js";
import type { PinnedAddress } from "../src/net/index.js";
import { id3Tag } from "./helpers/id3-tag.js";

const fixture = (name: string): Buffer =>
  readFileSync(
    fileURLToPath(new URL(`../../tests/fixtures/tls/${name}`, import.meta.url)),
  );
const CA = fixture("ca.pem");

const ALLOWED = new Set(["allowed.test", "other.test"]);
const policyCalls: string[] = [];
async function stubPolicy(host: string, port: number): Promise<PinnedAddress[]> {
  policyCalls.push(`${host}:${port}`);
  if (!ALLOWED.has(host)) throw new Error("refused by stub policy");
  return [{ address: "127.0.0.1", family: 4 }];
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface Upstream {
  port: number;
  hits: http.IncomingMessage[];
  close(): Promise<void>;
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

async function httpUpstream(handler: Handler): Promise<Upstream> {
  const hits: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req);
    handler(req, res);
  });
  const port = await listen(server);
  return {
    port,
    hits,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function httpsUpstream(
  handler: Handler,
  cert = "server",
): Promise<Upstream & { servernames: Array<string | false | null> }> {
  const hits: http.IncomingMessage[] = [];
  const servernames: Array<string | false | null> = [];
  const server = https.createServer(
    { key: fixture(`${cert}.key`), cert: fixture(`${cert}.pem`) },
    (req, res) => {
      hits.push(req);
      servernames.push((req.socket as TLSSocket).servername);
      handler(req, res);
    },
  );
  const port = await listen(server);
  return {
    port,
    hits,
    servernames,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function viaProxy(
  proxy: MediaProxy,
  target: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxy.port,
        method: opts.method ?? "GET",
        path: target,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("toProxyUrl", () => {
  it("encodes https into the TLS marker, keeping a non-default port", () => {
    assert.equal(
      toProxyUrl("https://cdn.example.com/live/a.m3u8?t=1#frag"),
      "http://cdn.example.com.karyl-tls.invalid/live/a.m3u8?t=1",
    );
    assert.equal(
      toProxyUrl("https://cdn.example.com:8443/a.mp3"),
      "http://cdn.example.com.karyl-tls.invalid:8443/a.mp3",
    );
    assert.equal(
      toProxyUrl("https://cdn.example.com:80/a.mp3"),
      "http://cdn.example.com.karyl-tls.invalid:80/a.mp3",
    );
    assert.equal(
      toProxyUrl("https://1.2.3.4/a.mp3"),
      "http://1.2.3.4.karyl-tls.invalid/a.mp3",
    );
  });

  it("leaves http as is and refuses what it cannot encode", () => {
    assert.equal(toProxyUrl("http://radio.example.com:8000/s"), "http://radio.example.com:8000/s");
    assert.equal(toProxyUrl("https://[2606:4700::1]/a.mp3"), null);
    assert.equal(toProxyUrl("ftp://example.com/a.mp3"), null);
    assert.equal(toProxyUrl("not a url"), null);
  });
});

describe("sniffBody", () => {
  const LIST = Buffer.from("#EXTM3U\nseg.ts\n");

  it("recognises a playlist, with or without a BOM", () => {
    assert.deepEqual(sniffBody(LIST, false, 1024), { kind: "playlist", prefix: 0 });
    assert.deepEqual(
      sniffBody(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), LIST]), false, 1024),
      { kind: "playlist", prefix: 0 },
    );
    assert.deepEqual(sniffBody(Buffer.from("ID3-ish audio..."), false, 1024), {
      kind: "stream",
    });
  });

  it("skips ID3v2 tags (synchsafe size, footer flag) before #EXTM3U", () => {
    const tag = id3Tag(200);
    assert.deepEqual(sniffBody(Buffer.concat([tag, LIST]), false, 1024), {
      kind: "playlist",
      prefix: 210,
    });
    const withFooter = id3Tag(200, true);
    assert.deepEqual(sniffBody(Buffer.concat([withFooter, LIST]), false, 1024), {
      kind: "playlist",
      prefix: 220,
    });
    // Two tags back to back (ffmpeg's ID3 reader loops too).
    assert.deepEqual(sniffBody(Buffer.concat([tag, tag, LIST]), false, 1024), {
      kind: "playlist",
      prefix: 420,
    });
    // A synchsafe size of 0x81 (bytes 00 00 01 01) is 129, not 257.
    const t = id3Tag(129);
    assert.deepEqual([...t.subarray(6, 10)], [0, 0, 1, 1]);
    assert.deepEqual(sniffBody(Buffer.concat([t, LIST]), false, 1024), {
      kind: "playlist",
      prefix: 139,
    });
  });

  it("waits for a whole tag, but not past the cap", () => {
    const tag = id3Tag(500);
    assert.deepEqual(sniffBody(tag.subarray(0, 100), false, 1024), { kind: "more" });
    assert.deepEqual(sniffBody(tag.subarray(0, 4), false, 1024), { kind: "more" });
    assert.deepEqual(sniffBody(Buffer.from("#EX"), false, 1024), { kind: "more" });
    assert.deepEqual(sniffBody(tag.subarray(0, 100), true, 1024), { kind: "stream" });
    // A tag bigger than the cap (an MP3's cover art) streams at once.
    assert.deepEqual(sniffBody(id3Tag(5000).subarray(0, 10), false, 1024), {
      kind: "stream",
    });
  });
});

describe("media proxy lifecycle", () => {
  it("reports closed and runs close listeners once, even late ones", async () => {
    const proxy = await startMediaProxy({ log: { warn: () => {} } });
    let early = 0;
    let late = 0;
    let unsubscribed = 0;
    proxy.onClose(() => early++);
    const off = proxy.onClose(() => unsubscribed++);
    off();
    assert.equal(proxy.closed, false);
    await proxy.close();
    await proxy.close();
    assert.equal(proxy.closed, true);
    proxy.onClose(() => late++);
    assert.deepEqual([early, late, unsubscribed], [1, 1, 0]);
  });
});

describe("media proxy", () => {
  let proxy: MediaProxy;
  let allowed: Upstream;
  let refused: Upstream;
  let tlsUp: Awaited<ReturnType<typeof httpsUpstream>>;
  let untrusted: Awaited<ReturnType<typeof httpsUpstream>>;

  before(async () => {
    refused = await httpUpstream((_req, res) => res.end("secret"));
    allowed = await httpUpstream((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/redirect-lan")) {
        res.writeHead(302, { location: `http://refused.test:${refused.port}/x` });
        res.end();
      } else if (url.startsWith("/redirect-https")) {
        res.writeHead(301, { location: `https://other.test:${tlsUp.port}/y` });
        res.end();
      } else if (url.startsWith("/playlist")) {
        res.writeHead(206, {
          "content-type": "application/vnd.apple.mpegurl",
          "content-range": "bytes 0-999/1000",
        });
        res.end(
          "﻿#EXTM3U\r\n" +
            `#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k?id=1",IV=0x1\r\n` +
            `#EXT-X-MAP:URI="init.mp4"\r\n` +
            "#EXTINF:2.0,\r\n" +
            "https://cdn.example.com:8443/seg1.ts\r\n" +
            "#EXTINF:2.0,\r\n" +
            "seg2.ts\r\n" +
            "#EXTINF:2.0,\r\n" +
            "http://plain.example.com/seg3.ts\r\n" +
            "#EXTINF:2.0,\r\n" +
            "httpproxy://10.0.0.5:22/seg4.ts\r\n",
        );
      } else if (url.startsWith("/gzip-playlist")) {
        res.writeHead(200, { "content-encoding": "gzip" });
        res.end(zlib.gzipSync("#EXTM3U\n//cdn.example.com/a.ts\n"));
      } else if (url.startsWith("/weird-encoding")) {
        res.writeHead(200, { "content-encoding": "zstd" });
        res.end("#EXTM3U\n");
      } else if (url.startsWith("/big-playlist")) {
        res.end("#EXTM3U\n" + "#EXTINF:1,\nseg.ts\n".repeat(200));
      } else if (url.startsWith("/id3-playlist")) {
        res.end(
          Buffer.concat([
            id3Tag(64, true),
            Buffer.from("#EXTM3U\nhttps://cdn.example.com/a.ts\n"),
          ]),
        );
      } else if (url.startsWith("/big-stream")) {
        res.end("ID3".padEnd(5000, "x"));
      } else {
        res.writeHead(200, { "x-up": "1" });
        res.end(
          JSON.stringify({
            path: url,
            host: req.headers.host,
            ae: req.headers["accept-encoding"],
            pc: req.headers["proxy-connection"] ?? null,
          }),
        );
      }
    });
    tlsUp = await httpsUpstream((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/hop")) {
        res.writeHead(302, { location: "/landed" });
        res.end();
      } else if (url.startsWith("/list.m3u8")) {
        res.end(`#EXTM3U\nseg.ts\nhttps://other.test:${tlsUp.port}/abs.ts\n`);
      } else {
        res.end(`tls ${url}`);
      }
    });
    untrusted = await httpsUpstream((_req, res) => res.end("mitm"), "untrusted");
    proxy = await startMediaProxy({
      resolveTarget: stubPolicy,
      tls: { ca: CA },
      maxPlaylistBytes: 1024,
      log: { warn: (o, m) => process.env.PROXY_DEBUG && console.error(m, o) },
    });
  });

  after(async () => {
    await proxy.close();
    await Promise.all([allowed, refused, tlsUp, untrusted].map((u) => u.close()));
  });

  it("listens on loopback only", () => {
    assert.equal(proxy.address().address, "127.0.0.1");
    assert.equal(proxy.url, `http://127.0.0.1:${proxy.port}`);
  });

  it("forwards an allowed GET with the real Host and identity encoding", async () => {
    const r = await viaProxy(proxy, `http://allowed.test:${allowed.port}/a?b=1`, {
      headers: { "proxy-connection": "keep-alive", "accept-encoding": "gzip" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers["x-up"], "1");
    assert.deepEqual(JSON.parse(r.body), {
      path: "/a?b=1",
      host: `allowed.test:${allowed.port}`,
      ae: "identity",
      pc: null,
    });
  });

  it("answers 403 for a refused host and never connects to it", async () => {
    const before = refused.hits.length;
    const r = await viaProxy(proxy, `http://refused.test:${refused.port}/x`);
    assert.equal(r.status, 403);
    assert.equal(refused.hits.length, before);
    assert.ok(policyCalls.includes(`refused.test:${refused.port}`));
  });

  it("passes a 302 back unfollowed", async () => {
    const before = refused.hits.length;
    const r = await viaProxy(proxy, `http://allowed.test:${allowed.port}/redirect-lan`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, `http://refused.test:${refused.port}/x`);
    assert.equal(refused.hits.length, before);
  });

  it("re-encodes an https Location", async () => {
    const r = await viaProxy(proxy, `http://allowed.test:${allowed.port}/redirect-https`);
    assert.equal(r.status, 301);
    assert.equal(
      r.headers.location,
      `http://other.test.karyl-tls.invalid:${tlsUp.port}/y`,
    );
  });

  it("terminates TLS for a marker host, with SNI = the real hostname", async () => {
    const r = await viaProxy(
      proxy,
      `http://allowed.test.karyl-tls.invalid:${tlsUp.port}/file.mp3`,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body, "tls /file.mp3");
    assert.equal(tlsUp.servernames.at(-1), "allowed.test");
    assert.equal(tlsUp.hits.at(-1)?.headers.host, `allowed.test:${tlsUp.port}`);
  });

  it("resolves a relative Location from a TLS upstream to the encoded form", async () => {
    const r = await viaProxy(
      proxy,
      `http://allowed.test.karyl-tls.invalid:${tlsUp.port}/hop`,
    );
    assert.equal(r.status, 302);
    assert.equal(
      r.headers.location,
      `http://allowed.test.karyl-tls.invalid:${tlsUp.port}/landed`,
    );
  });

  it("verifies the upstream certificate", async () => {
    const r = await viaProxy(
      proxy,
      `http://allowed.test.karyl-tls.invalid:${untrusted.port}/x`,
    );
    assert.equal(r.status, 502);
    assert.equal(untrusted.hits.length, 0);
  });

  it("vets the real host of a marker URL", async () => {
    const r = await viaProxy(
      proxy,
      `http://refused.test.karyl-tls.invalid:${tlsUp.port}/x`,
    );
    assert.equal(r.status, 403);
    assert.ok(policyCalls.includes(`refused.test:${tlsUp.port}`));
  });

  it("rewrites absolute https URIs in a playlist, nothing else", async () => {
    const r = await viaProxy(proxy, `http://allowed.test:${allowed.port}/playlist.m3u8`);
    assert.equal(r.status, 200, "a rewritten 206 becomes a whole 200");
    assert.equal(r.headers["content-range"], undefined);
    assert.equal(r.headers["content-length"], String(Buffer.byteLength(r.body)));
    assert.equal(
      r.body,
      "﻿#EXTM3U\r\n" +
        `#EXT-X-KEY:METHOD=AES-128,URI="http://keys.example.com.karyl-tls.invalid/k?id=1",IV=0x1\r\n` +
        `#EXT-X-MAP:URI="init.mp4"\r\n` +
        "#EXTINF:2.0,\r\n" +
        "http://cdn.example.com.karyl-tls.invalid:8443/seg1.ts\r\n" +
        "#EXTINF:2.0,\r\n" +
        "seg2.ts\r\n" +
        "#EXTINF:2.0,\r\n" +
        "http://plain.example.com/seg3.ts\r\n" +
        "#EXTINF:2.0,\r\n" +
        "httpproxy://10.0.0.5:22/seg4.ts\r\n",
    );
  });

  it("rewrites an ID3-prefixed playlist, keeping the tag bytes", async () => {
    const res = await new Promise<Buffer>((resolve, reject) => {
      http
        .request(
          {
            host: "127.0.0.1",
            port: proxy.port,
            path: `http://allowed.test:${allowed.port}/id3-playlist.m3u8`,
          },
          (r) => {
            const chunks: Buffer[] = [];
            r.on("data", (c: Buffer) => chunks.push(c));
            r.on("end", () => resolve(Buffer.concat(chunks)));
          },
        )
        .on("error", reject)
        .end();
    });
    assert.deepEqual(res.subarray(0, 84), id3Tag(64, true));
    assert.equal(
      res.subarray(84).toString("utf8"),
      "#EXTM3U\nhttp://cdn.example.com.karyl-tls.invalid/a.ts\n",
    );
  });

  it("rewrites scheme-relative URIs against an https playlist", async () => {
    const r = await viaProxy(
      proxy,
      `http://allowed.test.karyl-tls.invalid:${tlsUp.port}/list.m3u8`,
    );
    assert.equal(
      r.body,
      `#EXTM3U\nseg.ts\nhttp://other.test.karyl-tls.invalid:${tlsUp.port}/abs.ts\n`,
    );
  });

  it("decodes a gzip body before sniffing it", async () => {
    const r = await viaProxy(proxy, `http://allowed.test:${allowed.port}/gzip-playlist`);
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-encoding"], undefined);
    // Scheme-relative under an http base stays http — left as is.
    assert.equal(r.body, "#EXTM3U\n//cdn.example.com/a.ts\n");
  });

  it("refuses an unknown content-encoding", async () => {
    const r = await viaProxy(proxy, `http://allowed.test:${allowed.port}/weird-encoding`);
    assert.equal(r.status, 502);
  });

  it("refuses a playlist above the size cap but streams other large bodies", async () => {
    const big = await viaProxy(proxy, `http://allowed.test:${allowed.port}/big-playlist`);
    assert.equal(big.status, 502);
    const stream = await viaProxy(proxy, `http://allowed.test:${allowed.port}/big-stream`);
    assert.equal(stream.status, 200);
    assert.equal(stream.body.length, 5000);
  });

  it("refuses CONNECT with 405 and opens no tunnel", async () => {
    const before = tlsUp.hits.length;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        method: "CONNECT",
        path: `allowed.test:${tlsUp.port}`,
      });
      req.on("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 405);
    assert.equal(tlsUp.hits.length, before);
  });

  it("refuses origin-form requests and non-GET methods", async () => {
    assert.equal((await viaProxy(proxy, "/a")).status, 400);
    assert.equal(
      (await viaProxy(proxy, `http://allowed.test:${allowed.port}/a`, { method: "POST" }))
        .status,
      405,
    );
    assert.equal(
      (await viaProxy(proxy, `http://user@allowed.test:${allowed.port}/a`)).status,
      400,
    );
  });
});
