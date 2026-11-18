/**
 * WebSocket half of the `/plugin/<pluginKey>/` reverse proxy (#271 / #272).
 *
 * Fastify never routes an HTTP Upgrade: Node emits it as the server's
 * `upgrade` event with the raw socket, so this module listens there and
 * does every check itself — none of the onRequest hooks run.
 *
 * Flow for one upgrade request:
 *   1. path must be `/plugin/<key>/…` with a valid key, else 404;
 *   2. per-IP attempt rate (60/min) → 429;
 *   3. Origin, when present, must be the WEB_BASE_URL origin or the
 *      request Host's own origin → else 403 (absent Origin is allowed:
 *      the cookie is stripped, so a non-browser client gains nothing);
 *   4. plugin row must be `status === 'active'` AND `enabled` → else 404.
 *      This differs from the HTTP proxy on purpose (#271): a disabled
 *      plugin's WebUI still loads, but it gets no WebSocket;
 *   5. concurrent caps per IP (32) and per plugin (512) → 429;
 *   6. service discovery picks the endpoint and host policy vets it; the
 *      upstream connection goes to the vetted addresses only (pinned
 *      lookup, no second DNS answer) → policy refusal 502;
 *   7. the upgrade is forwarded with the `/plugin/<key>` prefix removed and
 *      the same header hygiene as the HTTP proxy. A 101 reply is relayed
 *      (set-cookie rewritten) and the two sockets are piped raw — the bot
 *      never parses frames. Any other reply is relayed and the socket
 *      closed. No reply within the handshake timeout → 504.
 *
 * After the handshake there is no timeout (TCP keepalive on both sides).
 * A Plugin Change that unregisters, deactivates or disables a plugin
 * destroys its connections; because frames are not parsed the bot cannot
 * send a close frame, so the browser sees 1006 and reconnects.
 *
 * Caps are per bot process. Each open / close / refusal is logged on the
 * module logger; `getPluginWsConnectionCounts` feeds the metrics gauge.
 */

import type { FastifyInstance } from "fastify";
import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type Socket } from "node:net";
import { effectivePort, pinnedLookup } from "@karyl-chan/voice/net";
import { config } from "../../config.js";
import { moduleLogger } from "../../logger.js";
import { RateLimiter } from "../../utils/rate-limiter.js";
import {
  HostPolicyError,
  resolvePluginTarget,
} from "../../utils/host-policy.js";
import { getServiceDiscovery } from "../../adapters/registry.js";
import { findPluginByKey } from "./models/plugin.model.js";
import { getCachedPluginByKey } from "./plugin-lookup-cache.js";
import { onPluginChange, type PluginChange } from "./plugin-changes.js";
import {
  PLUGIN_KEY_RE,
  PROXY_STRIPPED_REQUEST_HEADERS,
  pickEndpoint,
  rewritePluginSetCookie,
} from "./plugin-proxy.js";

const log = moduleLogger("plugin-ws-proxy");

export interface PluginWsLimits {
  /** Upgrade attempts per client IP per rolling minute. */
  attemptsPerIpPerMinute: number;
  /** Open (or handshaking) connections per client IP. */
  concurrentPerIp: number;
  /** Open (or handshaking) connections per plugin. */
  concurrentPerPlugin: number;
}

/** Connection caps, per bot process. */
export const PLUGIN_WS_LIMITS: Readonly<PluginWsLimits> = {
  /** Upgrade attempts per client IP per rolling minute. */
  attemptsPerIpPerMinute: 60,
  concurrentPerIp: 32,
  concurrentPerPlugin: 512,
};

/** Connect to the plugin and get its handshake reply within this, else 504. */
export const PLUGIN_WS_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface PluginWsProxyOptions {
  /** Trusted proxy CIDRs (as `resolveTrustProxy` returns); false = none. */
  trustProxy?: false | string[];
  /** Public base URL whose origin is allowed; defaults to WEB_BASE_URL. */
  baseUrl?: string | null;
  handshakeTimeoutMs?: number;
  limits?: Partial<PluginWsLimits>;
}

interface WsConnection {
  pluginKey: string;
  pluginId: number;
  ip: string;
  client: Socket;
  upstream: Socket | null;
  /** Destroys both sides; the first call's reason is the one logged. */
  close(reason: string): void;
}

// ── connection registry (module-level: one per process, like the caps) ─────

const connectionsByPlugin = new Map<string, Set<WsConnection>>();
const connectionsByIp = new Map<string, number>();

function track(conn: WsConnection): void {
  let set = connectionsByPlugin.get(conn.pluginKey);
  if (!set) {
    set = new Set();
    connectionsByPlugin.set(conn.pluginKey, set);
  }
  set.add(conn);
  connectionsByIp.set(conn.ip, (connectionsByIp.get(conn.ip) ?? 0) + 1);
}

function untrack(conn: WsConnection): void {
  const set = connectionsByPlugin.get(conn.pluginKey);
  if (set?.delete(conn)) {
    if (set.size === 0) connectionsByPlugin.delete(conn.pluginKey);
    const n = (connectionsByIp.get(conn.ip) ?? 1) - 1;
    if (n <= 0) connectionsByIp.delete(conn.ip);
    else connectionsByIp.set(conn.ip, n);
  }
}

/** Open (or handshaking) WebSocket connections per plugin key. */
export function getPluginWsConnectionCounts(): Array<{
  pluginKey: string;
  connections: number;
}> {
  return [...connectionsByPlugin].map(([pluginKey, set]) => ({
    pluginKey,
    connections: set.size,
  }));
}

function closePluginConnections(pluginId: number, reason: string): void {
  for (const set of connectionsByPlugin.values()) {
    for (const conn of [...set]) {
      if (conn.pluginId === pluginId) conn.close(reason);
    }
  }
}

/** Plugin Change → drop the connections of a plugin that may no longer have them. */
function onChange(change: PluginChange): void {
  if (change.guildId !== undefined || change.row === undefined) return;
  if (change.row === null) {
    closePluginConnections(change.pluginId, "plugin_removed");
  } else if (change.row.status !== "active") {
    closePluginConnections(change.pluginId, "plugin_inactive");
  } else if (!change.row.enabled) {
    closePluginConnections(change.pluginId, "plugin_disabled");
  }
}

// ── request helpers ─────────────────────────────────────────────────────────

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function unmapIPv4(addr: string): string {
  return addr.startsWith("::ffff:") && isIP(addr.slice(7)) === 4
    ? addr.slice(7)
    : addr;
}

/** proxy-addr semantics (what Fastify's `trustProxy: string[]` uses). */
function compileTrust(cidrs: false | string[]): (addr: string) => boolean {
  if (!cidrs || cidrs.length === 0) return () => false;
  const list = new BlockList();
  for (const entry of cidrs) {
    const [net, prefix] = entry.trim().split("/");
    const ip = unmapIPv4(net);
    const family = isIP(ip);
    if (!family) continue;
    const type = family === 6 ? "ipv6" : "ipv4";
    if (prefix === undefined) list.addAddress(ip, type);
    else list.addSubnet(ip, Number(prefix), type);
  }
  return (addr) => {
    const ip = unmapIPv4(addr);
    const family = isIP(ip);
    return family !== 0 && list.check(ip, family === 6 ? "ipv6" : "ipv4");
  };
}

interface ClientView {
  ip: string;
  /** Protocol and host the client addressed, as Fastify's request.protocol/host. */
  protocol: "http" | "https";
  host: string;
}

function clientView(
  req: IncomingMessage,
  trusted: (a: string) => boolean,
): ClientView {
  const peer = req.socket.remoteAddress ?? "unknown";
  const peerTrusted = trusted(peer);
  // Walk X-Forwarded-For right to left while the hop is trusted.
  const chain = [
    peer,
    ...String(firstHeader(req.headers["x-forwarded-for"]) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .reverse(),
  ];
  let ip = chain[0];
  for (let i = 0; i < chain.length; i++) {
    ip = chain[i];
    if (!trusted(chain[i])) break;
  }
  const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
  let protocol: "http" | "https" = encrypted ? "https" : "http";
  let host = firstHeader(req.headers.host) ?? "";
  if (peerTrusted) {
    const fwdProto = firstHeader(req.headers["x-forwarded-proto"])
      ?.split(",")[0]
      ?.trim()
      .toLowerCase();
    if (fwdProto === "http" || fwdProto === "https") protocol = fwdProto;
    const fwdHost = firstHeader(req.headers["x-forwarded-host"])
      ?.split(",")[0]
      ?.trim();
    if (fwdHost) host = fwdHost;
  }
  return { ip: unmapIPv4(ip), protocol, host };
}

function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

/** Write a plain HTTP response on the raw socket and close it. */
function refuse(socket: Socket, status: number, error: string): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error });
  const reason =
    {
      403: "Forbidden",
      404: "Not Found",
      429: "Too Many Requests",
      502: "Bad Gateway",
      504: "Gateway Timeout",
    }[status] ?? "Error";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" +
      body,
  );
}

/** Serialize upstream raw headers, rewriting set-cookie and dropping `drop`. */
function headerLines(
  rawHeaders: string[],
  pluginKey: string,
  drop: ReadonlySet<string> = new Set(),
): string {
  let out = "";
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const lower = name.toLowerCase();
    if (drop.has(lower)) continue;
    const value =
      lower === "set-cookie"
        ? rewritePluginSetCookie(rawHeaders[i + 1], pluginKey)
        : rawHeaders[i + 1];
    out += `${name}: ${value}\r\n`;
  }
  return out;
}

const NON_101_DROPPED = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "upgrade",
]);

// ── the upgrade handler ─────────────────────────────────────────────────────

/**
 * Attach the WebSocket proxy to `server`'s underlying Node server. Call
 * before `listen`; closing the Fastify instance destroys its connections.
 */
export function attachPluginWsProxy(
  server: FastifyInstance,
  options: PluginWsProxyOptions = {},
): void {
  const limits = { ...PLUGIN_WS_LIMITS, ...options.limits };
  const handshakeTimeoutMs =
    options.handshakeTimeoutMs ?? PLUGIN_WS_HANDSHAKE_TIMEOUT_MS;
  const trusted = compileTrust(options.trustProxy ?? false);
  const baseOrigin = (() => {
    const base =
      options.baseUrl === undefined ? config.web.baseUrl : options.baseUrl;
    return base ? originOf(base) : null;
  })();
  const attempts = new RateLimiter({
    windowMs: 60_000,
    max: limits.attemptsPerIpPerMinute,
  });
  const mine = new Set<WsConnection>();

  const unsubscribe = onPluginChange(onChange);
  // preClose: before Fastify closes the Node server, which would otherwise
  // wait on the upgraded sockets it still counts.
  server.addHook("preClose", async () => {
    unsubscribe();
    for (const conn of [...mine]) conn.close("server_closing");
  });

  server.server.on(
    "upgrade",
    (req: IncomingMessage, socket: Socket, head: Buffer) => {
      socket.on("error", () => {});
      handleUpgrade(req, socket, head).catch((err) => {
        log.error({ err }, "plugin ws upgrade failed");
        refuse(socket, 502, "plugin unreachable");
      });
    },
  );

  async function handleUpgrade(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    const rawUrl = req.url ?? "/";
    const m = /^\/plugin\/([^/?#]*)(\/[^]*)$/.exec(rawUrl);
    const view = clientView(req, trusted);
    const reject = (
      status: number,
      error: string,
      reason: string,
      pluginKey?: string,
    ) => {
      log.warn(
        { pluginKey, ip: view.ip, reason, status },
        "plugin ws upgrade refused",
      );
      refuse(socket, status, error);
    };

    if (!m || !PLUGIN_KEY_RE.test(m[1])) {
      reject(404, "unknown plugin", "not_plugin_path");
      return;
    }
    const pluginKey = m[1];
    const rest = m[2];

    if (attempts.isRateLimited(view.ip)) {
      reject(429, "too many websocket attempts", "rate_limited", pluginKey);
      return;
    }

    const origin = firstHeader(req.headers.origin);
    if (origin !== undefined) {
      const hostOrigin = view.host
        ? originOf(`${view.protocol}://${view.host}`)
        : null;
      const ok = origin === baseOrigin || origin === hostOrigin;
      if (!ok) {
        reject(403, "origin not allowed", "origin_mismatch", pluginKey);
        return;
      }
    }

    const plugin = await getCachedPluginByKey(pluginKey, findPluginByKey);
    if (!plugin || plugin.status !== "active" || !plugin.enabled) {
      reject(
        404,
        "unknown plugin",
        plugin ? "plugin_not_enabled" : "unknown_plugin",
        pluginKey,
      );
      return;
    }

    if ((connectionsByIp.get(view.ip) ?? 0) >= limits.concurrentPerIp) {
      reject(429, "too many websocket connections", "ip_cap", pluginKey);
      return;
    }
    if (
      (connectionsByPlugin.get(pluginKey)?.size ?? 0) >=
      limits.concurrentPerPlugin
    ) {
      reject(429, "too many websocket connections", "plugin_cap", pluginKey);
      return;
    }

    // Reserve the slot now so concurrent handshakes count against the caps.
    const openedAt = Date.now();
    let closed = false;
    let upstreamReq: ReturnType<typeof httpRequest> | null = null;
    const conn: WsConnection = {
      pluginKey,
      pluginId: plugin.id,
      ip: view.ip,
      client: socket,
      upstream: null,
      close(reason) {
        if (closed) return;
        closed = true;
        untrack(conn);
        mine.delete(conn);
        upstreamReq?.destroy();
        conn.upstream?.destroy();
        socket.destroy();
        if (conn.upstream) {
          log.info(
            {
              pluginKey,
              ip: view.ip,
              reason,
              durationMs: Date.now() - openedAt,
              bytesIn: socket.bytesRead,
              bytesOut: socket.bytesWritten,
            },
            "plugin ws closed",
          );
        }
      },
    };
    track(conn);
    mine.add(conn);
    const fail = (status: number, error: string, reason: string) => {
      reject(status, error, reason, pluginKey);
      // Untrack without destroying first so the refusal can flush.
      closed = true;
      untrack(conn);
      mine.delete(conn);
      upstreamReq?.destroy();
    };
    socket.once("close", () => conn.close("client_closed"));
    // HTTP server sockets are half-open capable: a client FIN alone never
    // fires "close", so treat it as the end of the connection.
    socket.once("end", () => {
      if (!conn.upstream) conn.close("client_closed");
    });

    let base: URL;
    try {
      const endpoints = await getServiceDiscovery().resolve(
        pluginKey,
        plugin.url,
      );
      base = new URL(pickEndpoint(pluginKey, endpoints));
    } catch (err) {
      log.warn({ err, pluginKey }, "plugin ws service discovery failed");
      if (!closed) fail(502, "plugin unreachable", "discovery_failed");
      return;
    }
    if (closed) return;
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      fail(502, "plugin target not allowed", "bad_scheme");
      return;
    }

    let addresses;
    try {
      addresses = await resolvePluginTarget(base.hostname, effectivePort(base));
    } catch (err) {
      if (closed) return;
      if (err instanceof HostPolicyError) {
        fail(502, "plugin target not allowed", "host_policy");
      } else {
        log.error({ err, pluginKey }, "plugin ws target check failed");
        fail(502, "plugin unreachable", "target_check_failed");
      }
      return;
    }
    if (closed) return;

    const headers: OutgoingHttpHeaders = { ...req.headers };
    for (const name of PROXY_STRIPPED_REQUEST_HEADERS) delete headers[name];
    headers["x-forwarded-for"] = view.ip;
    headers["x-forwarded-proto"] = view.protocol;
    headers["x-forwarded-host"] = firstHeader(req.headers.host) ?? "";
    headers.host = base.host;

    const isHttps = base.protocol === "https:";
    const upstreamPath = base.pathname.replace(/\/+$/, "") + rest;
    const doRequest = isHttps ? httpsRequest : httpRequest;
    const ureq = doRequest({
      host: base.hostname.replace(/^\[|\]$/g, ""),
      port: effectivePort(base),
      path: upstreamPath,
      method: "GET",
      headers,
      lookup: pinnedLookup(addresses),
      agent: false,
      ...(isHttps && isIP(base.hostname.replace(/^\[|\]$/g, "")) === 0
        ? { servername: base.hostname }
        : {}),
    });
    upstreamReq = ureq;

    const timer = setTimeout(() => {
      if (!closed) fail(504, "plugin handshake timed out", "handshake_timeout");
    }, handshakeTimeoutMs);
    timer.unref?.();

    ureq.on("error", (err) => {
      clearTimeout(timer);
      if (closed || conn.upstream) return;
      log.warn({ err, pluginKey }, "plugin ws upstream error");
      fail(502, "plugin unreachable", "upstream_error");
    });

    ureq.on("response", (res: IncomingMessage) => {
      clearTimeout(timer);
      if (closed) {
        res.destroy();
        return;
      }
      // Not a 101: relay the plugin's refusal as-is, then close.
      closed = true;
      untrack(conn);
      mine.delete(conn);
      log.warn(
        {
          pluginKey,
          ip: view.ip,
          reason: "upstream_refused",
          status: res.statusCode,
        },
        "plugin ws upgrade refused",
      );
      socket.write(
        `HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ""}\r\n` +
          headerLines(res.rawHeaders, pluginKey, NON_101_DROPPED) +
          "Connection: close\r\n\r\n",
      );
      res.pipe(socket);
      res.on("error", () => socket.destroy());
    });

    ureq.on(
      "upgrade",
      (res: IncomingMessage, upSocket: Socket, upHead: Buffer) => {
        clearTimeout(timer);
        if (closed) {
          upSocket.destroy();
          return;
        }
        conn.upstream = upSocket;
        upSocket.on("error", () => {});
        for (const s of [socket, upSocket]) {
          s.setTimeout(0);
          s.setNoDelay(true);
          s.setKeepAlive(true, 30_000);
        }
        socket.write(
          `HTTP/1.1 101 ${res.statusMessage || "Switching Protocols"}\r\n` +
            headerLines(res.rawHeaders, pluginKey) +
            "\r\n",
        );
        if (upHead.length > 0) socket.write(upHead);
        if (head.length > 0) upSocket.write(head);
        upSocket.pipe(socket);
        socket.pipe(upSocket);
        // A FIN from either side ends the pair: the pipe forwards it, and once
        // the other side has flushed (or failed to), both are destroyed —
        // WebSocket has no use for a half-open TCP connection.
        const endPair = (from: Socket, to: Socket, reason: string) => {
          from.once("end", () => {
            if (to.writableFinished || to.destroyed) conn.close(reason);
            else {
              to.once("finish", () => conn.close(reason));
              to.once("close", () => conn.close(reason));
            }
          });
        };
        endPair(socket, upSocket, "client_closed");
        endPair(upSocket, socket, "plugin_closed");
        // A graceful FIN is endPair's (it waits for the client side to
        // flush); a reset or error closes at once.
        upSocket.once("close", () => {
          if (!upSocket.readableEnded) conn.close("plugin_closed");
        });
        log.info({ pluginKey, ip: view.ip }, "plugin ws opened");
      },
    );

    ureq.end();
  }
}
