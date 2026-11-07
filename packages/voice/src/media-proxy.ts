/**
 * media-proxy — the controlled HTTP proxy every ffmpeg media fetch goes
 * through (#158).
 *
 * ffmpeg fetches a voice media URL itself: it follows redirects and opens
 * whatever an HLS playlist names (variants, segments, keys, init maps). A
 * check on the first URL alone therefore cannot keep it off the LAN. So
 * ffmpeg runs with `-http_proxy` pointed here, and this proxy runs the
 * public-media policy on EVERY request, connects only to the addresses
 * the policy vetted (pinned — no second DNS answer), and never follows a
 * redirect itself: it hands the 3xx back so the next hop comes through
 * here again.
 *
 * ffmpeg only ever speaks plain http, and only to this proxy
 * (`-protocol_whitelist http,tcp,crypto,…` — no https / tls / httpproxy;
 * see ffmpeg-decoder.ts). https upstreams are therefore carried as plain
 * http URLs with a reserved marker in the authority (`toProxyUrl`) and
 * this proxy terminates TLS itself, verifying the certificate against
 * the real hostname (SNI = that hostname). The encoding survives relative
 * resolution, so a playlist's relative segment URIs keep the marker.
 *
 * Why not CONNECT tunnels with TLS end to end in ffmpeg: ffmpeg's tls
 * layer reaches a proxy through the `httpproxy` protocol, which then has
 * to be whitelisted — and the hls demuxer accepts any segment scheme
 * starting with "http", so a playlist line `httpproxy://10.0.0.5:22/x`
 * makes ffmpeg dial that host directly (verified on 8.1, same check in
 * 4.3's hls.c).
 *
 * Rewrites, so https keeps working:
 *   - a 3xx `Location` resolving to https is re-encoded;
 *   - an HLS playlist body (sniffed: optional UTF-8 BOM, then `#EXTM3U`,
 *     which is what ffmpeg's hls probe / parse_playlist require) is
 *     buffered (capped) and every absolute https URI in it — bare URI
 *     lines and `URI="…"` attributes — is re-encoded. Anything else
 *     streams through untouched (radio streams never end).
 *
 * FAIL-CLOSED: the rewrites are for functionality only. A URI they miss
 * stays `https://…`, which ffmpeg cannot open (https is not whitelisted),
 * so a miss makes playback fail; it never opens a path around this
 * proxy. Every `http://` URL ffmpeg opens on its own comes here anyway.
 *
 * Not an open relay: it listens on 127.0.0.1 only (ephemeral port),
 * serves GET / HEAD in absolute form only, answers CONNECT with 405, and
 * every target must pass the injected policy (default
 * `resolvePublicMediaTarget`: public addresses only).
 */

import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { isIP } from "node:net";
import { pipeline, type Duplex, type Readable } from "node:stream";
import zlib from "node:zlib";
import { resolvePublicMediaTarget } from "./net/media-target.js";
import { pinnedLookup, type PinnedAddress } from "./net/pinned-lookup.js";
import type { VoiceLogger } from "./voice-manager.js";

/**
 * Reserved authority suffix marking "this http URL is really https". The
 * `.invalid` TLD (RFC 6761) never resolves, so the marker cannot collide
 * with a real host.
 */
export const TLS_MARKER_SUFFIX = ".karyl-tls.invalid";

/**
 * The URL ffmpeg should open for a real media URL:
 *   - `http://…` unchanged;
 *   - `https://host[:port]/path?q` → `http://host.karyl-tls.invalid[:port]/path?q`
 *     — a non-default port is carried explicitly (`https://h:80/` keeps
 *     `:80`; the proxy reads the authority verbatim, so an encoded URL
 *     without a port means 443). Userinfo is kept; the fragment dropped.
 *
 * Returns null for what cannot be encoded (another scheme, an IPv6
 * literal host): such a URL is left as is by the playlist / Location
 * rewrites, and ffmpeg then refuses it (fail-closed).
 */
export function toProxyUrl(url: URL | string): string | null {
  let u: URL;
  try {
    u = typeof url === "string" ? new URL(url) : url;
  } catch {
    return null;
  }
  const auth = u.username
    ? `${u.username}${u.password ? `:${u.password}` : ""}@`
    : "";
  if (u.protocol === "http:") return u.href.replace(/#.*$/, "");
  if (u.protocol !== "https:") return null;
  if (u.hostname.startsWith("[")) return null;
  const port = u.port ? `:${u.port}` : "";
  return `http://${auth}${u.hostname}${TLS_MARKER_SUFFIX}${port}${u.pathname}${u.search}`;
}

/** Where a proxied request really goes. */
interface UpstreamTarget {
  tls: boolean;
  /** Real hostname (bracket-free for IPv6), lowercased. */
  host: string;
  port: number;
  /** Origin-form path + query to send upstream. */
  path: string;
  /** The real URL — the base for Location / playlist resolution. */
  url: URL;
}

/**
 * Decode an absolute-form request target (`http://authority/path`).
 * The authority is read verbatim (not through WHATWG URL, which would
 * drop a `:80` that means "https on port 80" for a marker host). Null
 * for anything else: origin-form, another scheme, userinfo (ffmpeg
 * never puts userinfo in the request line — it rebuilds it from host
 * and port and sends credentials as an Authorization header, which is
 * why `toProxyUrl` may keep them).
 */
function decodeTarget(target: string): UpstreamTarget | null {
  const m = /^http:\/\/([^/?#]*)([^#]*)/i.exec(target);
  if (!m) return null;
  const [, authority, rest] = m;
  if (authority.includes("@")) return null;
  const am = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+)(?::(\d*))?$/.exec(authority);
  if (!am) return null;
  let host = am[1].toLowerCase();
  const explicitPort = am[2] ? Number(am[2]) : null;
  const tls = host.endsWith(TLS_MARKER_SUFFIX);
  if (tls) {
    host = host.slice(0, -TLS_MARKER_SUFFIX.length);
    if (!host) return null;
  }
  const port = explicitPort ?? (tls ? 443 : 80);
  const path = rest === "" ? "/" : rest.startsWith("/") ? rest : `/${rest}`;
  let url: URL;
  try {
    url = new URL(`${tls ? "https" : "http"}://${host}:${port}${path}`);
  } catch {
    return null;
  }
  return {
    tls,
    host: host.startsWith("[") ? host.slice(1, -1) : host,
    port,
    path,
    url,
  };
}

/** An absolute (or scheme-relative) reference resolving to https → encoded; else unchanged. */
function rewriteRef(ref: string, base: URL): string {
  if (!/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) return ref; // relative: keeps the marker
  let resolved: URL;
  try {
    resolved = new URL(ref, base);
  } catch {
    return ref;
  }
  if (resolved.protocol !== "https:") return ref;
  return toProxyUrl(resolved) ?? ref;
}

/**
 * Re-encode every absolute https URI in an HLS playlist: bare URI lines
 * and `URI="…"` attributes on tag lines (EXT-X-KEY, EXT-X-MAP,
 * EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF, EXT-X-SESSION-KEY, …). Line
 * endings and everything else are kept byte for byte.
 */
export function rewritePlaylist(text: string, base: URL): string {
  return text
    .split(/(\r?\n)/)
    .map((line, i) => {
      if (i % 2 === 1) return line; // a captured line separator
      const trimmed = line.trim();
      if (trimmed === "") return line;
      if (trimmed.startsWith("#")) {
        return line.replace(
          /URI="([^"]*)"/g,
          (_m, uri: string) => `URI="${rewriteRef(uri, base)}"`,
        );
      }
      const out = rewriteRef(trimmed, base);
      return out === trimmed ? line : out;
    })
    .join("");
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const EXTM3U = Buffer.from("#EXTM3U");
/** Bytes needed to decide whether a body is a playlist. */
const SNIFF_BYTES = UTF8_BOM.length + EXTM3U.length;

function looksLikePlaylist(head: Buffer): boolean {
  const body = head.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
    ? head.subarray(UTF8_BOM.length)
    : head;
  return body.subarray(0, EXTM3U.length).equals(EXTM3U);
}

/** Hop-by-hop headers (RFC 9110 §7.6.1) plus the proxy-only ones. */
const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function endToEndHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | string[]> {
  const listed = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name) || listed.has(name)) continue;
    out[name] = value;
  }
  return out;
}

export type MediaProxyLogger = Pick<VoiceLogger, "warn">;

export interface MediaProxyOptions {
  /**
   * The policy: vet `host:port` and return the addresses to connect to,
   * or throw to refuse. Default `resolvePublicMediaTarget`.
   */
  resolveTarget?: (host: string, port: number) => Promise<PinnedAddress[]>;
  /** Upstream TLS trust (test seam: a test CA). Default: Node's roots. */
  tls?: { ca?: string | Buffer | Array<string | Buffer> };
  /** Largest HLS playlist the proxy buffers to rewrite. Default 2 MiB. */
  maxPlaylistBytes?: number;
  /** Idle timeout on an upstream connection, ms. Default 30 s. */
  upstreamIdleMs?: number;
  log?: MediaProxyLogger;
}

export interface MediaProxy {
  /** `http://127.0.0.1:<port>` — what ffmpeg's `-http_proxy` gets. */
  readonly url: string;
  readonly port: number;
  address(): AddressInfo;
  close(): Promise<void>;
}

const DEFAULT_MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;

const consoleLog: MediaProxyLogger = {
  warn: (obj, msg) =>
    console.warn(JSON.stringify({ level: "warn", msg, ...(obj as object) })),
};

function sendStatus(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    connection: "close",
  });
  res.end(text);
}

/**
 * Undo a Content-Encoding so the playlist sniff sees the real bytes.
 * pipeline(), not pipe(): an upstream error mid-body must reach the
 * decoder (whose error the caller handles), not crash the process.
 */
function decodedBody(
  upstream: IncomingMessage,
  encoding: string,
): Readable | null {
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? zlib.createGunzip()
      : encoding === "deflate"
        ? zlib.createInflate()
        : encoding === "br"
          ? zlib.createBrotliDecompress()
          : null;
  if (encoding === "" || encoding === "identity") return upstream;
  if (!decoder) return null;
  return pipeline(upstream, decoder, () => {});
}

/**
 * Start the proxy on 127.0.0.1, ephemeral port. One per process is
 * enough (voice-manager starts it lazily and reuses it).
 */
export async function startMediaProxy(
  options: MediaProxyOptions = {},
): Promise<MediaProxy> {
  const resolveTarget = options.resolveTarget ?? resolvePublicMediaTarget;
  const maxPlaylistBytes = options.maxPlaylistBytes ?? DEFAULT_MAX_PLAYLIST_BYTES;
  const upstreamIdleMs = options.upstreamIdleMs ?? 30_000;
  const log = options.log ?? consoleLog;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendStatus(res, 405, "method not allowed");
      return;
    }
    const target = decodeTarget(req.url ?? "");
    if (!target) {
      sendStatus(res, 400, "absolute http URL required");
      return;
    }
    let pinned: PinnedAddress[];
    try {
      pinned = await resolveTarget(target.host, target.port);
      if (pinned.length === 0) throw new Error("no vetted address");
    } catch (err) {
      log.warn(
        {
          host: target.host,
          port: target.port,
          tls: target.tls,
          reason: err instanceof Error ? err.message : String(err),
        },
        "media-proxy: target refused",
      );
      sendStatus(res, 403, "media target refused");
      return;
    }
    if (res.destroyed) return;

    const defaultPort = target.tls ? 443 : 80;
    const hostHeader =
      (isIP(target.host) === 6 ? `[${target.host}]` : target.host) +
      (target.port === defaultPort ? "" : `:${target.port}`);
    const headers: OutgoingHttpHeaders = {
      ...endToEndHeaders(req.headers),
      host: hostHeader,
      "accept-encoding": "identity",
    };
    const common = {
      host: target.host,
      port: target.port,
      method: req.method,
      path: target.path,
      headers,
      agent: false as const,
      lookup: pinnedLookup(pinned),
    };
    const upstreamReq = target.tls
      ? https.request({
          ...common,
          servername: isIP(target.host) === 0 ? target.host : undefined,
          ca: options.tls?.ca,
          rejectUnauthorized: true,
        })
      : http.request(common);
    upstreamReq.setTimeout(upstreamIdleMs, () =>
      upstreamReq.destroy(new Error("upstream idle timeout")),
    );
    res.on("close", () => upstreamReq.destroy());
    upstreamReq.on("error", (err) => {
      log.warn(
        {
          host: target.host,
          port: target.port,
          tls: target.tls,
          err: (err as NodeJS.ErrnoException).code ?? err.message,
        },
        "media-proxy: upstream error",
      );
      sendStatus(res, 502, "upstream error");
    });
    upstreamReq.on("response", (upstream) => {
      relayResponse(req, res, upstream, target, () => upstreamReq.destroy());
    });
    upstreamReq.end();
  }

  function relayResponse(
    req: IncomingMessage,
    res: ServerResponse,
    upstream: IncomingMessage,
    target: UpstreamTarget,
    abort: () => void,
  ): void {
    const status = upstream.statusCode ?? 502;
    const headers = endToEndHeaders(upstream.headers);
    // Never follow: hand the hop back so it comes through the proxy again.
    const location = upstream.headers.location;
    if (status >= 300 && status < 400 && location) {
      headers.location = rewriteLocation(location, target.url);
    }
    if (req.method === "HEAD" || status === 204 || status === 304) {
      res.writeHead(status, headers);
      res.end();
      upstream.resume();
      return;
    }
    const encoding = String(upstream.headers["content-encoding"] ?? "")
      .trim()
      .toLowerCase();
    const body = decodedBody(upstream, encoding);
    if (!body) {
      log.warn(
        { host: target.host, port: target.port, encoding },
        "media-proxy: unsupported content-encoding",
      );
      abort();
      sendStatus(res, 502, "unsupported content-encoding");
      return;
    }
    if (body !== upstream) {
      delete headers["content-encoding"];
      delete headers["content-length"];
    }
    body.on("error", () => {
      abort();
      res.destroy();
    });

    let head = Buffer.alloc(0);
    let decided = false;
    const decide = (ended: boolean): void => {
      if (decided) return;
      decided = true;
      body.removeListener("data", onSniff);
      body.removeListener("end", onSniffEnd);
      if (looksLikePlaylist(head)) {
        bufferPlaylist(head, ended);
      } else {
        res.writeHead(status, headers);
        res.write(head);
        if (ended) res.end();
        else body.pipe(res);
      }
    };
    const onSniff = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      if (head.length >= SNIFF_BYTES) {
        body.pause();
        decide(false);
      }
    };
    const onSniffEnd = (): void => decide(true);
    body.on("data", onSniff);
    body.on("end", onSniffEnd);

    const bufferPlaylist = (first: Buffer, ended: boolean): void => {
      const chunks = [first];
      let size = first.length;
      const tooBig = (): boolean => {
        if (size <= maxPlaylistBytes) return false;
        log.warn(
          { host: target.host, port: target.port, maxPlaylistBytes },
          "media-proxy: playlist too large",
        );
        abort();
        sendStatus(res, 502, "playlist too large");
        return true;
      };
      const finish = (): void => {
        const text = Buffer.concat(chunks).toString("utf8");
        const out = Buffer.from(rewritePlaylist(text, target.url), "utf8");
        // The body changed length: a 206 slice of it is meaningless now,
        // so answer the whole (rewritten) playlist as a plain 200.
        delete headers["content-range"];
        delete headers["accept-ranges"];
        headers["content-length"] = String(out.length);
        res.writeHead(status === 206 ? 200 : status, headers);
        res.end(out);
      };
      if (tooBig()) return;
      if (ended) {
        finish();
        return;
      }
      body.on("data", (chunk: Buffer) => {
        if (res.destroyed) return;
        chunks.push(chunk);
        size += chunk.length;
        if (tooBig()) body.destroy();
      });
      body.on("end", () => {
        if (!res.destroyed && !res.headersSent) finish();
      });
      body.resume();
    };
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.warn({ err: String(err) }, "media-proxy: handler failed");
      sendStatus(res, 500, "proxy error");
    });
  });
  // No tunnels: a CONNECT would carry bytes the policy never sees.
  const refuseTunnel = (req: IncomingMessage, socket: Duplex): void => {
    log.warn({ target: req.url, method: req.method }, "media-proxy: tunnel refused");
    socket.end(
      "HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  };
  server.on("connect", refuseTunnel);
  server.on("upgrade", refuseTunnel);
  server.on("clientError", (_err, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    address: () => server.address() as AddressInfo,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** A redirect target, absolute, with https re-encoded (unencodable → as resolved). */
function rewriteLocation(location: string, base: URL): string {
  let resolved: URL;
  try {
    resolved = new URL(location, base);
  } catch {
    return location;
  }
  if (resolved.protocol === "https:") return toProxyUrl(resolved) ?? resolved.href;
  return resolved.href;
}
