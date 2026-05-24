import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  hasPluginCapability,
  verifyPluginSession,
  type PluginSessionClaims,
} from "@karyl-chan/plugin-sdk";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  issueManagePair,
  verifyManageToken,
  type ManageClaims,
} from "./manage-tokens.js";
import {
  publish,
  subscribe,
  getHistory,
  type ChatEvent,
} from "./chat-state.js";
import { mintTicket, consumeTicket } from "./sse-tickets.js";
import {
  getSticky,
  setSticky,
  deleteSticky,
  listStickies,
} from "./sticky-state.js";

// ── Deferred wiring from plugin.ts ───────────────────────────────────────
// The lifecycle client only exists once plugin.start() resolves, so we
// expose setters here that index.ts calls after start() returns.

type BotRpc = (path: string, body?: unknown) => Promise<unknown | null>;
let _botRpc: BotRpc | null = null;
export function setBotRpc(fn: BotRpc): void {
  _botRpc = fn;
}

let _sessionVerifyKey: (() => string | null) | null = null;
export function setSessionVerifyKey(getter: () => string | null): void {
  _sessionVerifyKey = getter;
}

let _publicBaseUrlGetter: (() => string | undefined) | null = null;
export function setPublicBaseUrl(getter: () => string | undefined): void {
  _publicBaseUrlGetter = getter;
}

function effectiveBase(): string {
  const fromSdk = _publicBaseUrlGetter?.();
  if (fromSdk) return fromSdk.replace(/\/+$/, "");
  // Local dev fallback. In production the bot always provides the value.
  return "http://localhost:3004";
}

// ── Auth gates ───────────────────────────────────────────────────────────

/** Verify Bearer plugin-session JWT. Returns claims, or null after replying. */
function auth(
  request: FastifyRequest,
  reply: FastifyReply,
): PluginSessionClaims | null {
  const key = _sessionVerifyKey?.() ?? null;
  if (!key) {
    reply.code(503).send({
      error: "session verification unavailable — plugin not yet registered",
    });
    return null;
  }
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    reply.code(401).send({ error: "Missing authorization" });
    return null;
  }
  const claims = verifyPluginSession(token, key);
  if (!claims) {
    reply.code(401).send({ error: "Invalid or expired token" });
    return null;
  }
  return claims;
}

/** Gate /api/manage/exchange — bot manage JWT + manage capability. */
function authManageBootstrap(
  request: FastifyRequest,
  reply: FastifyReply,
  pluginKey: string,
  manageCap: string,
): PluginSessionClaims | null {
  const claims = auth(request, reply);
  if (!claims) return null;
  if (!hasPluginCapability(claims.capabilities, pluginKey, manageCap)) {
    reply.code(403).send({
      error: `Missing capability plugin:${pluginKey}:${manageCap} — ask an admin to grant it to your role.`,
    });
    return null;
  }
  return claims;
}

/** Gate /api/manage/* day-to-day routes — plugin-issued access token. */
function authManageAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  pluginKey: string,
  manageCap: string,
): ManageClaims | null {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    reply.code(401).send({ error: "Missing authorization" });
    return null;
  }
  const claims = verifyManageToken(token, "manage-access");
  if (!claims) {
    reply.code(401).send({ error: "Invalid or expired access token" });
    return null;
  }
  if (!hasPluginCapability(claims.capabilities, pluginKey, manageCap)) {
    reply.code(403).send({
      error: `Missing capability plugin:${pluginKey}:${manageCap}.`,
    });
    return null;
  }
  return claims;
}

/** Gate user-bound session routes — token must carry a guildId. */
function authSession(
  request: FastifyRequest,
  reply: FastifyReply,
): PluginSessionClaims | null {
  const claims = auth(request, reply);
  if (!claims) return null;
  if (!claims.guildId) {
    reply.code(403).send({ error: "Token is missing guild scope" });
    return null;
  }
  return claims;
}

// ── Routes ───────────────────────────────────────────────────────────────

export async function registerWebRoutes(
  server: FastifyInstance,
  pluginKey: string,
  manageCap: string,
): Promise<void> {
  // ── Manage bootstrap: bot JWT → plugin access+refresh pair ────────────
  server.post("/api/manage/exchange", async (request, reply) => {
    const claims = authManageBootstrap(request, reply, pluginKey, manageCap);
    if (!claims) return;
    return issueManagePair(claims.userId, claims.capabilities ?? []);
  });

  server.post<{ Body: { refreshToken?: unknown } }>(
    "/api/manage/refresh",
    async (request, reply) => {
      let body: { refreshToken?: unknown };
      try {
        body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : (request.body as { refreshToken?: unknown });
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }
      const refresh =
        typeof body?.refreshToken === "string" ? body.refreshToken : null;
      if (!refresh) {
        return reply.code(400).send({ error: "refreshToken required" });
      }
      const claims = verifyManageToken(refresh, "manage-refresh");
      if (!claims) {
        return reply
          .code(401)
          .send({ error: "Invalid or expired refresh token" });
      }
      return issueManagePair(claims.userId, claims.capabilities);
    },
  );

  // ── Manage UI ─────────────────────────────────────────────────────────
  server.get<{ Querystring: { guildId?: string } }>(
    "/api/manage/stickies",
    async (request, reply) => {
      const claims = authManageAccess(request, reply, pluginKey, manageCap);
      if (!claims) return;
      const guildId = request.query?.guildId;
      if (!guildId) {
        return reply.code(400).send({ error: "guildId required" });
      }
      return { stickies: listStickies(guildId) };
    },
  );

  // ── User-bound session: chat ──────────────────────────────────────────
  server.get<{ Querystring: { channelId?: string } }>(
    "/api/chat/history",
    async (request, reply) => {
      const claims = authSession(request, reply);
      if (!claims) return;
      const channelId = request.query?.channelId;
      if (!channelId) {
        return reply.code(400).send({ error: "channelId required" });
      }
      return { events: getHistory(channelId) };
    },
  );

  server.post<{ Body: { channelId?: string; content?: string } }>(
    "/api/chat/send",
    async (request, reply) => {
      const claims = authSession(request, reply);
      if (!claims) return;
      let body: { channelId?: string; content?: string };
      try {
        body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : (request.body as { channelId?: string; content?: string });
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }
      const channelId = body?.channelId;
      const content = (body?.content ?? "").trim();
      if (!channelId || !content) {
        return reply.code(400).send({ error: "channelId and content required" });
      }
      if (content.length > 1000) {
        return reply.code(400).send({ error: "Content too long (max 1000)" });
      }
      if (!_botRpc) {
        return reply.code(503).send({ error: "bot RPC unavailable" });
      }

      // Resolve the author's display name via members.get; on failure
      // fall back to the user id so the echo still has *some* label.
      let authorName = claims.userId;
      try {
        const r = (await _botRpc("/api/plugin/members.get", {
          guild_id: claims.guildId,
          user_ids: [claims.userId],
        })) as { members?: Array<{ id: string; displayName?: string }> } | null;
        const m = r?.members?.[0];
        if (m?.displayName) authorName = m.displayName;
      } catch {
        // ignore — fallback already set
      }

      // Send to Discord first. Only fan-out locally if the Discord
      // post succeeded — otherwise the SPA would show a "sent" message
      // that nobody on Discord actually saw.
      const sent = await _botRpc("/api/plugin/messages.send", {
        channel_id: channelId,
        content: `**${authorName}** (via WebUI): ${content}`,
        guild_id: claims.guildId,
      });
      if (!sent) {
        return reply.code(502).send({ error: "Discord send failed" });
      }

      const event: ChatEvent = {
        ts: Date.now(),
        source: "webui",
        authorId: claims.userId,
        authorName,
        content,
      };
      // Discord already received the message — if the local fan-out
      // throws (corrupted history state, etc.) we still want the SPA
      // to see a 2xx so its optimistic echo stays put. The downstream
      // MESSAGE_CREATE relay from the bot will rehydrate the channel
      // history on next reconnect.
      try {
        publish(channelId, event);
      } catch (err) {
        request.log.error(
          { err, channelId },
          "chat publish failed after Discord send",
        );
      }
      return { ok: true, event };
    },
  );

  // Mint a single-use SSE ticket. Authenticated.
  server.post<{ Body: { channelId?: string } }>(
    "/api/chat/sse-ticket",
    async (request, reply) => {
      const claims = authSession(request, reply);
      if (!claims) return;
      let body: { channelId?: string };
      try {
        body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : (request.body as { channelId?: string });
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }
      const channelId = body?.channelId;
      if (!channelId) {
        return reply.code(400).send({ error: "channelId required" });
      }
      const ticket = mintTicket({
        userId: claims.userId,
        guildId: claims.guildId ?? "",
        channelId,
      });
      return { ticket };
    },
  );

  // The actual SSE stream — anonymous (the ticket is the auth).
  server.get<{ Querystring: { ticket?: string } }>(
    "/api/chat/events",
    async (request, reply) => {
      const ticket = request.query?.ticket;
      if (!ticket) {
        return reply.code(400).send({ error: "ticket required" });
      }
      const payload = consumeTicket(ticket);
      if (!payload) {
        return reply.code(401).send({ error: "Invalid or expired ticket" });
      }
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const unsubscribe = subscribe(payload.channelId, reply);
      request.raw.on("close", () => {
        unsubscribe();
        try {
          reply.raw.end();
        } catch {
          // already closed
        }
      });
      // Returning undefined keeps the connection open; Fastify won't
      // try to serialize a body when the response has already been
      // written.
      return reply;
    },
  );

  // ── User-bound session: sticky note ───────────────────────────────────
  server.get("/api/sticky", async (request, reply) => {
    const claims = authSession(request, reply);
    if (!claims) return;
    return { sticky: getSticky(claims.guildId!, claims.userId) };
  });

  server.put<{ Body: { body?: unknown } }>(
    "/api/sticky",
    async (request, reply) => {
      const claims = authSession(request, reply);
      if (!claims) return;
      let body: { body?: unknown };
      try {
        body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : (request.body as { body?: unknown });
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }
      const text = typeof body?.body === "string" ? body.body : null;
      if (text === null) {
        return reply.code(400).send({ error: "body (string) required" });
      }
      if (text.length > 4000) {
        return reply.code(400).send({ error: "Note too long (max 4000 chars)" });
      }
      return { sticky: setSticky(claims.guildId!, claims.userId, text) };
    },
  );

  server.delete("/api/sticky", async (request, reply) => {
    const claims = authSession(request, reply);
    if (!claims) return;
    deleteSticky(claims.guildId!, claims.userId);
    return { ok: true };
  });

  // ── SPA ───────────────────────────────────────────────────────────────
  // Read the singlefile bundle once at boot; per-request we splice in
  // a `window.__PLUGIN_BASE__` script tag so the SPA knows its path
  // prefix when served through the bot proxy. Both the dist runtime
  // (where this module is `dist/web-routes.js`) and `tsx watch
  // src/web-routes.ts` resolve to the same `dist/ui/index.html`.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  let htmlContent: string;
  try {
    htmlContent = readFileSync(join(__dirname, "ui", "index.html"), "utf-8");
  } catch {
    htmlContent = readFileSync(
      join(__dirname, "..", "dist", "ui", "index.html"),
      "utf-8",
    );
  }
  server.get("/", async (_request, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; " +
        "script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");

    let basePath = "";
    try {
      basePath = new URL(effectiveBase()).pathname.replace(/\/+$/, "");
    } catch {
      // Malformed URL — leave empty; SPA falls back to same-origin.
    }
    const inject = `<script>window.__PLUGIN_BASE__=${JSON.stringify(basePath)}</script>`;
    return reply.send(htmlContent.replace("<head>", `<head>${inject}`));
  });
}
