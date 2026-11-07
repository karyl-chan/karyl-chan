/**
 * End to end with a real ffmpeg (#158): the decoder playback spawns,
 * through the media proxy, against loopback upstreams. Skipped when no
 * `ffmpeg` is on PATH.
 *
 * How the test tells "went through the proxy" from "went around it":
 *   - every REFUSED target is spelled `127.0.0.1:<port of a raw TCP
 *     counter>`. If ffmpeg ever dialled it itself — directly, by
 *     httpproxy://, or by TLS — the counter records a connection. The
 *     stub policy refuses 127.0.0.1, so via the proxy it never connects.
 *     Each case asserts zero connections.
 *   - every ALLOWED target is spelled with a name ffmpeg cannot resolve
 *     (`allowed.test`, `other.test`); only the proxy's stub policy maps
 *     them to 127.0.0.1. A decode that succeeds therefore went through
 *     the proxy.
 *   - the child gets `no_proxy=*` and an `http_proxy` naming the refused
 *     counter in its base env, which would send ffmpeg around the media
 *     proxy if the decoder did not strip / replace them.
 */
import { strict as assert } from "node:assert";
import { spawnSync, type ChildProcess } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ffmpegChildEnv, spawnFfmpegDecoder } from "../src/ffmpeg-decoder.js";
import { startMediaProxy, type MediaProxy } from "../src/media-proxy.js";
import { mediaPolicyFor, type PinnedAddress } from "../src/net/index.js";
import { id3Tag } from "./helpers/id3-tag.js";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { windowsHide: true }).error;
// Skip locally without ffmpeg; in CI (which installs it) a missing ffmpeg
// must fail loudly rather than skip the end-to-end proof.
const skipWithoutFfmpeg = !hasFfmpeg && process.env.CI !== "true" && "ffmpeg not on PATH";

const fixture = (name: string): Buffer =>
  readFileSync(
    fileURLToPath(new URL(`../../tests/fixtures/tls/${name}`, import.meta.url)),
  );

/** 1 s of 440 Hz, 44.1 kHz mono s16le, as a WAV file. */
function toneWav(): Buffer {
  const rate = 44_100;
  const samples = rate;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** PCM bytes per second of the decoder's output (48 kHz, stereo, s16). */
const PCM_PER_SECOND = 48_000 * 2 * 2;

describe("ffmpegChildEnv", () => {
  it("drops every proxy variable and points http_proxy at the media proxy", () => {
    const env = ffmpegChildEnv("http://127.0.0.1:9", {
      PATH: "/bin",
      no_proxy: "*",
      NO_PROXY: "*",
      HTTP_PROXY: "http://evil:1",
      https_proxy: "http://evil:2",
      All_Proxy: "socks5://evil:3",
    });
    assert.deepEqual(env, { PATH: "/bin", http_proxy: "http://127.0.0.1:9" });
  });
});

interface Decoded {
  code: number | null;
  pcmBytes: number;
  stderr: string;
}

describe("decoder lifetime", () => {
  it("refuses to start against a closed proxy", async () => {
    const proxy = await startMediaProxy({ log: { warn: () => {} } });
    await proxy.close();
    assert.throws(
      () => spawnFfmpegDecoder({ url: "http://example.com/a.mp3", proxy }),
      /media_proxy_closed/,
    );
  });
});

describe("ffmpeg through the media proxy", { skip: skipWithoutFfmpeg }, () => {
  let proxy: MediaProxy;
  let refusedPort: number;
  let refusedConnections = 0;
  let refusedServer: net.Server;
  let plain: http.Server;
  let plainPort: number;
  let secure: https.Server;
  let tlsPort: number;
  let plugin: http.Server;
  let pluginPort: number;
  let pluginProxy: MediaProxy;
  const pluginHits: string[] = [];
  const endless = new Set<http.ServerResponse>();
  const plainHits: string[] = [];
  const secureHits: string[] = [];
  let wav: Buffer;
  let segment: Buffer;
  const aesKey = randomBytes(16);
  const aesIv = randomBytes(16);
  let encryptedSegment: Buffer;

  const playlist = (...uris: string[]): string =>
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n" +
    uris.map((u) => `#EXTINF:1.0,\n${u}\n`).join("") +
    "#EXT-X-ENDLIST\n";

  function decode(url: string, via: MediaProxy = proxy): Promise<Decoded> {
    return new Promise((resolve) => {
      const child = spawnFfmpegDecoder({
        url,
        proxy: via,
        env: {
          ...process.env,
          no_proxy: "*",
          NO_PROXY: "*",
          http_proxy: `http://127.0.0.1:${refusedPort}`,
        },
      });
      let pcmBytes = 0;
      let stderr = "";
      child.stdout!.on("data", (b: Buffer) => (pcmBytes += b.length));
      child.stderr!.on("data", (b: Buffer) => (stderr += b.toString()));
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, pcmBytes, stderr });
      });
    });
  }

  before(async () => {
    wav = toneWav();
    const ts = spawnSync(
      "ffmpeg",
      ["-loglevel", "error", "-f", "wav", "-i", "pipe:0", "-c:a", "aac", "-f", "mpegts", "pipe:1"],
      { input: wav, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(ts.status, 0, ts.stderr?.toString());
    segment = ts.stdout;
    const cipher = createCipheriv("aes-128-cbc", aesKey, aesIv); // PKCS7, as HLS
    encryptedSegment = Buffer.concat([cipher.update(segment), cipher.final()]);

    refusedServer = net.createServer((socket) => {
      refusedConnections++;
      socket.on("error", () => {});
      socket.destroy();
    });
    await new Promise<void>((r) => refusedServer.listen(0, "127.0.0.1", r));
    refusedPort = (refusedServer.address() as AddressInfo).port;
    const refused = `127.0.0.1:${refusedPort}`;

    plain = http.createServer((req, res) => {
      const url = req.url ?? "";
      plainHits.push(url);
      if (url === "/tone.wav") {
        res.writeHead(200, { "content-type": "audio/wav" });
        res.end(wav);
      } else if (url === "/seg.ts") {
        res.end(segment);
      } else if (url === "/redirect-lan.wav") {
        res.writeHead(302, { location: `http://${refused}/tone.wav` });
        res.end();
      } else if (url === "/hls-lan-http.m3u8") {
        res.end(playlist(`http://${refused}/seg.ts`));
      } else if (url === "/hls-httpproxy.m3u8") {
        res.end(playlist(`httpproxy://${refused}/seg.ts`));
      } else if (url === "/hls-lan-https.m3u8") {
        res.end(playlist(`https://${refused}/seg.ts`));
      } else if (url === "/endless.wav") {
        // A radio-like stream: a WAV header, then PCM trickling forever.
        const header = wav.subarray(0, 44);
        header.writeUInt32LE(0xffffffff - 8, 4);
        header.writeUInt32LE(0xffffffff - 44, 40);
        res.writeHead(200, { "content-type": "audio/wav" });
        res.write(header);
        endless.add(res);
        const timer = setInterval(() => res.write(wav.subarray(44, 44 + 8820)), 100);
        res.on("close", () => {
          clearInterval(timer);
          endless.delete(res);
        });
      } else if (url === "/manifest.mpd") {
        res.writeHead(200, { "content-type": "application/dash+xml" });
        res.end(
          `<?xml version="1.0"?>\n` +
            `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1S" minBufferTime="PT1S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">` +
            `<Period><AdaptationSet mimeType="audio/mp2t"><Representation id="a" bandwidth="64000">` +
            `<BaseURL>http://allowed.test:${plainPort}/dash-seg.ts</BaseURL>` +
            `</Representation></AdaptationSet></Period></MPD>\n`,
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
    plainPort = (plain.address() as AddressInfo).port;

    secure = https.createServer(
      { key: fixture("server.key"), cert: fixture("server.pem") },
      (req, res) => {
        const url = req.url ?? "";
        secureHits.push(url);
        if (url === "/tone.wav") {
          res.end(wav);
        } else if (url === "/seg-enc.ts") {
          res.end(encryptedSegment);
        } else if (url.startsWith("/seg")) {
          res.end(segment);
        } else if (url === "/list.m3u8") {
          res.end(playlist("seg0.ts", `https://other.test:${tlsPort}/seg1.ts`));
        } else if (url === "/key.bin") {
          res.end(aesKey);
        } else if (url === "/aes.m3u8" || url === "/aes-lan-key.m3u8") {
          const keyUri =
            url === "/aes.m3u8"
              ? `https://other.test:${tlsPort}/key.bin`
              : `http://127.0.0.1:${refusedPort}/key.bin`;
          res.end(
            playlist("seg-enc.ts").replace(
              "#EXTINF",
              `#EXT-X-KEY:METHOD=AES-128,URI="${keyUri}",IV=0x${aesIv.toString("hex")}
#EXTINF`,
            ),
          );
        } else if (url === "/id3.m3u8") {
          res.end(
            Buffer.concat([
              id3Tag(300, true),
              Buffer.from(playlist(`https://127.0.0.1:${refusedPort}/seg1.ts`)),
            ]),
          );
        } else if (url === "/hop.wav") {
          res.writeHead(302, { location: `https://other.test:${tlsPort}/tone.wav` });
          res.end();
        } else {
          res.writeHead(404);
          res.end();
        }
      },
    );
    await new Promise<void>((r) => secure.listen(0, "127.0.0.1", r));
    tlsPort = (secure.address() as AddressInfo).port;

    // A "plugin" on loopback; plays from it carry it as trustedOrigin.
    plugin = http.createServer((req, res) => {
      const url = req.url ?? "";
      pluginHits.push(url);
      if (url === "/internal/audio/tone.wav") {
        res.end(wav);
      } else if (url === "/internal/list.m3u8") {
        res.end(playlist(`http://${refused}/seg.ts`));
      } else if (url === "/internal/redirect.wav") {
        res.writeHead(302, { location: `http://${refused}/tone.wav` });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => plugin.listen(0, "127.0.0.1", r));
    pluginPort = (plugin.address() as AddressInfo).port;
    // The real per-play policy (loopback counts as a plugin target outside
    // production): only 127.0.0.1:<pluginPort> is trusted.
    pluginProxy = await startMediaProxy({
      resolveTarget: mediaPolicyFor(`http://127.0.0.1:${pluginPort}`),
      log: { warn: () => {} },
    });

    proxy = await startMediaProxy({
      resolveTarget: async (host: string): Promise<PinnedAddress[]> => {
        if (host === "allowed.test" || host === "other.test") {
          return [{ address: "127.0.0.1", family: 4 }];
        }
        throw new Error("refused by stub policy");
      },
      tls: { ca: fixture("ca.pem") },
      log: { warn: () => {} },
    });
  });

  after(async () => {
    await proxy?.close();
    await pluginProxy?.close();
    for (const res of endless) res.destroy();
    for (const s of [plain, secure, plugin]) {
      s?.closeAllConnections();
      await new Promise((r) => s?.close(r));
    }
    await new Promise((r) => refusedServer?.close(r));
  });

  it("(a) a 302 to a refused host never reaches it", async () => {
    const before = refusedConnections;
    const r = await decode(`http://allowed.test:${plainPort}/redirect-lan.wav`);
    assert.notEqual(r.code, 0);
    assert.equal(r.pcmBytes, 0);
    assert.equal(refusedConnections, before);
    assert.ok(plainHits.includes("/redirect-lan.wav"), "the allowed hop was fetched");
  });

  it("(b) an HLS segment on a refused host (http://) never reaches it", async () => {
    const before = refusedConnections;
    const r = await decode(`http://allowed.test:${plainPort}/hls-lan-http.m3u8`);
    assert.equal(r.pcmBytes, 0);
    assert.equal(refusedConnections, before);
    assert.ok(plainHits.includes("/hls-lan-http.m3u8"));
  });

  it("(c) an HLS segment httpproxy://refused never reaches it", async () => {
    const before = refusedConnections;
    const r = await decode(`http://allowed.test:${plainPort}/hls-httpproxy.m3u8`);
    assert.equal(r.pcmBytes, 0);
    assert.equal(refusedConnections, before);
    assert.match(r.stderr, /not on whitelist|Invalid data|Failed/i);
  });

  it("(d) an HLS segment https://refused is rewritten, vetted and refused", async () => {
    const before = refusedConnections;
    const r = await decode(`http://allowed.test:${plainPort}/hls-lan-https.m3u8`);
    assert.equal(r.pcmBytes, 0);
    assert.equal(refusedConnections, before);
  });

  it("(e) an allowed https file decodes through the TLS-terminating proxy", async () => {
    const r = await decode(`https://allowed.test:${tlsPort}/tone.wav`);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.pcmBytes >= PCM_PER_SECOND * 0.9, `pcm ${r.pcmBytes}`);
  });

  it("(e') an allowed plain http file still decodes", async () => {
    const r = await decode(`http://allowed.test:${plainPort}/tone.wav`);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.pcmBytes >= PCM_PER_SECOND * 0.9, `pcm ${r.pcmBytes}`);
  });

  it("(f) https HLS with relative and absolute-https segments decodes", async () => {
    secureHits.length = 0;
    const r = await decode(`https://allowed.test:${tlsPort}/list.m3u8`);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.pcmBytes >= PCM_PER_SECOND * 1.5, `pcm ${r.pcmBytes}`);
    assert.ok(secureHits.includes("/seg0.ts"), "relative segment fetched");
    assert.ok(secureHits.includes("/seg1.ts"), "absolute https segment fetched");
  });

  it("(g) https → 302 → https still plays", async () => {
    secureHits.length = 0;
    const r = await decode(`https://allowed.test:${tlsPort}/hop.wav`);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.pcmBytes >= PCM_PER_SECOND * 0.9, `pcm ${r.pcmBytes}`);
    assert.deepEqual(secureHits, ["/hop.wav", "/tone.wav"]);
  });

  it("(h) AES-128 HLS with an https key decodes (crypto over the proxy)", async () => {
    secureHits.length = 0;
    const r = await decode(`https://allowed.test:${tlsPort}/aes.m3u8`);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.pcmBytes >= PCM_PER_SECOND * 0.9, `pcm ${r.pcmBytes}`);
    assert.ok(secureHits.includes("/key.bin"), "key fetched");
    assert.ok(secureHits.includes("/seg-enc.ts"), "encrypted segment fetched");
  });

  it("(i) an AES-128 key on a refused host never reaches it", async () => {
    const before = refusedConnections;
    const r = await decode(`https://allowed.test:${tlsPort}/aes-lan-key.m3u8`);
    assert.equal(r.pcmBytes, 0);
    assert.equal(refusedConnections, before);
  });

  it("(j) an ID3-prefixed playlist naming a refused https segment never reaches it", async () => {
    // The proxy skips the ID3 tag and rewrites the playlist (see the
    // sniffBody unit tests). ffmpeg 8.1 itself refuses an ID3-prefixed
    // playlist even from a local file (its hls probe skips the tag, but
    // parse_playlist does not), so this can only prove the refused host
    // stays unreached, not that such a playlist plays.
    const before = refusedConnections;
    secureHits.length = 0;
    const r = await decode(`https://allowed.test:${tlsPort}/id3.m3u8`);
    assert.equal(r.pcmBytes, 0);
    assert.equal(refusedConnections, before);
    assert.ok(secureHits.includes("/id3.m3u8"));
  });

  it("(k) trustedOrigin: a file on the plugin's own loopback origin decodes", async () => {
    const r = await decode(
      `http://127.0.0.1:${pluginPort}/internal/audio/tone.wav`,
      pluginProxy,
    );
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.pcmBytes >= PCM_PER_SECOND * 0.9, `pcm ${r.pcmBytes}`);
  });

  it("(l) trustedOrigin: its playlist naming another loopback port never reaches it", async () => {
    const before = refusedConnections;
    const r = await decode(`http://127.0.0.1:${pluginPort}/internal/list.m3u8`, pluginProxy);
    assert.equal(r.pcmBytes, 0);
    assert.equal(refusedConnections, before);
    assert.ok(pluginHits.includes("/internal/list.m3u8"));
  });

  it("(m) trustedOrigin: its redirect to another loopback port never reaches it", async () => {
    const before = refusedConnections;
    const r = await decode(
      `http://127.0.0.1:${pluginPort}/internal/redirect.wav`,
      pluginProxy,
    );
    assert.equal(r.pcmBytes, 0);
    assert.equal(refusedConnections, before);
    assert.ok(pluginHits.includes("/internal/redirect.wav"));
  });

  it("(n) closing a proxy kills the decoder streaming through it", async () => {
    const own = await startMediaProxy({
      resolveTarget: async () => [{ address: "127.0.0.1", family: 4 }],
      log: { warn: () => {} },
    });
    const child: ChildProcess = spawnFfmpegDecoder({
      url: `http://allowed.test:${plainPort}/endless.wav`,
      proxy: own,
    });
    let pcm = 0;
    child.stderr!.resume();
    const exited = new Promise<number>((resolve) => {
      child.on("close", () => resolve(Date.now()));
    });
    await new Promise<void>((resolve) => {
      child.stdout!.on("data", (b: Buffer) => {
        pcm += b.length;
        if (pcm > PCM_PER_SECOND / 4) resolve();
      });
    });
    const closedAt = Date.now();
    await own.close();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("decoder outlived its proxy")), 5_000),
    );
    const exitedAt = await Promise.race([exited, timeout]);
    assert.ok(exitedAt - closedAt < 2_000, `exited ${exitedAt - closedAt} ms after close`);
    assert.equal(child.exitCode === 0, false, "killed, not a clean end");
  });

  it("a DASH manifest is refused by the format whitelist", async () => {
    const r = await decode(`http://allowed.test:${plainPort}/manifest.mpd`);
    assert.notEqual(r.code, 0);
    assert.equal(r.pcmBytes, 0);
    assert.ok(!plainHits.includes("/dash-seg.ts"), "dash never opened its segment");
  });
});
