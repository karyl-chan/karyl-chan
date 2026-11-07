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
 *   - the child gets `no_proxy=*` in its base env, which would send
 *     ffmpeg around the proxy if the decoder did not strip it.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnFfmpegDecoder } from "../src/ffmpeg-decoder.js";
import { startMediaProxy, type MediaProxy } from "../src/media-proxy.js";
import type { PinnedAddress } from "../src/net/index.js";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { windowsHide: true }).error;

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

interface Decoded {
  code: number | null;
  pcmBytes: number;
  stderr: string;
}

describe("ffmpeg through the media proxy", { skip: !hasFfmpeg && "ffmpeg not on PATH" }, () => {
  let proxy: MediaProxy;
  let refusedPort: number;
  let refusedConnections = 0;
  let refusedServer: net.Server;
  let plain: http.Server;
  let plainPort: number;
  let secure: https.Server;
  let tlsPort: number;
  const plainHits: string[] = [];
  const secureHits: string[] = [];
  let wav: Buffer;
  let segment: Buffer;

  const playlist = (...uris: string[]): string =>
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n" +
    uris.map((u) => `#EXTINF:1.0,\n${u}\n`).join("") +
    "#EXT-X-ENDLIST\n";

  function decode(url: string): Promise<Decoded> {
    return new Promise((resolve) => {
      const child = spawnFfmpegDecoder({
        url,
        proxyUrl: proxy.url,
        env: { ...process.env, no_proxy: "*", NO_PROXY: "*" },
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
        } else if (url.startsWith("/seg")) {
          res.end(segment);
        } else if (url === "/list.m3u8") {
          res.end(playlist("seg0.ts", `https://other.test:${tlsPort}/seg1.ts`));
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
    for (const s of [plain, secure]) {
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

  it("a DASH manifest is refused by the format whitelist", async () => {
    const r = await decode(`http://allowed.test:${plainPort}/manifest.mpd`);
    assert.notEqual(r.code, 0);
    assert.equal(r.pcmBytes, 0);
    assert.ok(!plainHits.includes("/dash-seg.ts"), "dash never opened its segment");
  });
});
