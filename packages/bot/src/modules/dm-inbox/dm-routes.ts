import type { FastifyInstance } from "fastify";
import type { Client } from "discord.js";
import { config } from "../../config.js";
import type {
  DMChannel,
  EmojiIdentifierResolvable,
  Message as DjsMessage,
} from "discord.js";
import { ChannelType } from "discord.js";
import {
  dmInboxService,
  type DmChannelSummary,
  type DmInboxStore,
} from "./dm-inbox.service.js";
import { dmEventBus, type DmEventBus } from "./dm-event-bus.js";
import { avatarUrlFor, toApiMessage } from "../web-core/message-mapper.js";
import type { MessageEmoji } from "../web-core/message-types.js";
import { requireCapability } from "../web-core/route-guards.js";
import { DISCORD_MESSAGE_MAX, isSnowflake } from "../web-core/validators.js";
import { discordErrorStatus } from "../web-core/discord-error.js";
import { safeWriteSseEvent } from "../web-core/sse-helper.js";

export interface DmRoutesOptions {
  bot: Client;
  inbox?: DmInboxStore;
  eventBus?: DmEventBus;
}

interface ReactionBody {
  emoji?: { id?: string | null; name?: string; animated?: boolean };
}

interface StartBody {
  recipientUserId?: string;
}

function emojiResolvable(
  emoji: MessageEmoji,
): EmojiIdentifierResolvable | null {
  if (!emoji.id && !emoji.name) return null;
  if (emoji.id) {
    const safeName = emoji.name || "_";
    return emoji.animated
      ? `a:${safeName}:${emoji.id}`
      : `${safeName}:${emoji.id}`;
  }
  return emoji.name;
}

function emojiCacheKey(emoji: MessageEmoji): string | null {
  if (emoji.id) return emoji.id;
  return emoji.name || null;
}

async function fetchDmChannel(
  bot: Client,
  channelId: string,
): Promise<DMChannel | null> {
  const channel = await bot.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.DM) return null;
  return channel as DMChannel;
}

export async function registerDmRoutes(
  server: FastifyInstance,
  options: DmRoutesOptions,
): Promise<void> {
  const { bot } = options;
  const inbox = options.inbox ?? dmInboxService;
  const events = options.eventBus ?? dmEventBus;

  server.get("/api/dm/channels", async (request, reply) => {
    if (!requireCapability(request, reply, "dm.message")) return;
    return { channels: await inbox.listChannels() };
  });

  server.post<{ Body: { lastSeen?: Record<string, string | null> } }>(
    "/api/dm/unread",
    async (request, reply) => {
      if (!requireCapability(request, reply, "dm.message")) return;
      const lastSeen =
        request.body?.lastSeen && typeof request.body.lastSeen === "object"
          ? request.body.lastSeen
          : {};
      const channels = await inbox.listChannels();
      const botUserId = bot.user?.id ?? "";

      // Snowflakes are monotonically increasing — string compare
      // works when both sides are the same length. `lastMessageId`
      // null means we never recorded a message; treat every message
      // after the oldest possible id as unread (equivalent to passing
      // a zero snowflake).
      function isNewer(
        latest: string | null,
        seen: string | null | undefined,
      ): boolean {
        if (!latest) return false;
        if (!seen) return true;
        if (latest.length !== seen.length) return latest.length > seen.length;
        return latest > seen;
      }

      const stale = channels.filter((c) =>
        isNewer(c.lastMessageId, lastSeen[c.id] ?? null),
      );

      const MAX_COUNT = config.dm.maxFetchCount;
      const PAGE_SIZE = 100;
      const CONCURRENCY = 5;

      async function countFor(
        c: DmChannelSummary,
      ): Promise<[string, { count: number; hasMore: boolean }]> {
        const seen = lastSeen[c.id] ?? null;
        try {
          const channel = await fetchDmChannel(bot, c.id);
          if (!channel) return [c.id, { count: 0, hasMore: false }];
          let cursor = seen ?? "0";
          let count = 0;
          while (count < MAX_COUNT) {
            const fetched = await channel.messages.fetch({
              limit: PAGE_SIZE,
              after: cursor,
            });
            if (fetched.size === 0) break;
            let maxId = cursor;
            for (const m of fetched.values()) {
              if (m.author.id !== botUserId) count++;
              if (m.id > maxId || m.id.length > maxId.length) maxId = m.id;
            }
            if (fetched.size < PAGE_SIZE) break;
            if (maxId === cursor) break;
            cursor = maxId;
          }
          return [
            c.id,
            { count: Math.min(count, MAX_COUNT), hasMore: count >= MAX_COUNT },
          ];
        } catch (err) {
          request.log.warn({ err, channelId: c.id }, "dm unread fetch failed");
          return [c.id, { count: 0, hasMore: false }];
        }
      }

      // Chunked fan-out: unbounded Promise.all over 200+ DM channels
      // bursts Discord's REST queue and stalls unrelated requests.
      const channelsOut: Record<string, { count: number; hasMore: boolean }> =
        {};
      for (let i = 0; i < stale.length; i += CONCURRENCY) {
        const slice = stale.slice(i, i + CONCURRENCY);
        const results = await Promise.all(slice.map(countFor));
        for (const [id, data] of results) channelsOut[id] = data;
      }
      reply.send({ channels: channelsOut });
    },
  );

  server.get<{
    Params: { channelId: string };
    Querystring: { limit?: string; before?: string; around?: string };
  }>("/api/dm/channels/:channelId/messages", async (request, reply) => {
    if (!requireCapability(request, reply, "dm.message")) return;
    const { channelId } = request.params;
    const limit = Math.min(
      Math.max(Number(request.query.limit ?? 10) || 10, 1),
      50,
    );
    const before =
      typeof request.query.before === "string" &&
      request.query.before.length > 0
        ? request.query.before
        : undefined;
    const around =
      typeof request.query.around === "string" &&
      request.query.around.length > 0
        ? request.query.around
        : undefined;

    const summary = await inbox.getChannel(channelId);
    if (!summary) {
      reply.code(404).send({ error: "Unknown channel" });
      return;
    }

    const channel = await fetchDmChannel(bot, channelId);
    if (!channel) {
      reply.code(404).send({ error: "Unknown DM channel" });
      return;
    }

    try {
      // `around` (anchor pagination) takes precedence over `before`
      // so a link click can grab the window that contains the
      // target in one shot instead of trickling older pages.
      const fetched = around
        ? await channel.messages.fetch({ limit, around })
        : await channel.messages.fetch({ limit, before });
      const messages = [...fetched.values()]
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map(toApiMessage);
      return {
        channel: summary,
        messages,
        hasMore: messages.length === limit && !around,
      };
    } catch (err) {
      request.log.error({ err }, "failed to fetch DM messages");
      reply.code(502).send({ error: "Failed to fetch messages" });
    }
  });

  server.post<{ Params: { channelId: string } }>(
    "/api/dm/channels/:channelId/messages",
    async (request, reply) => {
      if (!requireCapability(request, reply, "dm.message")) return;
      const channel = await fetchDmChannel(bot, request.params.channelId);
      if (!channel) {
        reply.code(404).send({ error: "Unknown DM channel" });
        return;
      }

      let content = "";
      let replyToMessageId: string | undefined;
      // Discord defaults to pinging the replied-to author. We default
      // to NOT pinging because the admin client favours quiet replies;
      // composer is responsible for opting back in via this flag.
      let replyPingAuthor = false;
      let stickerIds: string[] = [];
      const files: Array<{ attachment: Buffer; name: string }> = [];

      if (request.isMultipart()) {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            const buffer = await part.toBuffer();
            files.push({ attachment: buffer, name: part.filename });
          } else if (part.fieldname === "content") {
            content = String(part.value ?? "");
          } else if (part.fieldname === "replyToMessageId") {
            const value = String(part.value ?? "").trim();
            if (value) replyToMessageId = value;
          } else if (part.fieldname === "replyPingAuthor") {
            replyPingAuthor = String(part.value ?? "") === "1";
          } else if (
            part.fieldname === "stickerIds" ||
            part.fieldname === "stickerIds[]"
          ) {
            const value = String(part.value ?? "").trim();
            if (value) stickerIds.push(value);
          }
        }
      } else {
        const body = (request.body ?? {}) as {
          content?: unknown;
          replyToMessageId?: unknown;
          replyPingAuthor?: unknown;
          stickerIds?: unknown;
        };
        content = typeof body.content === "string" ? body.content : "";
        if (
          typeof body.replyToMessageId === "string" &&
          body.replyToMessageId.length > 0
        ) {
          replyToMessageId = body.replyToMessageId;
        }
        if (typeof body.replyPingAuthor === "boolean") {
          replyPingAuthor = body.replyPingAuthor;
        }
        if (Array.isArray(body.stickerIds)) {
          stickerIds = body.stickerIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          );
        }
      }

      stickerIds = stickerIds.slice(0, 3);
      if (!stickerIds.every(isSnowflake)) {
        reply.code(400).send({ error: "invalid sticker id" });
        return;
      }
      if (replyToMessageId !== undefined && !isSnowflake(replyToMessageId)) {
        reply.code(400).send({ error: "invalid replyToMessageId" });
        return;
      }
      if (content.length > DISCORD_MESSAGE_MAX) {
        reply
          .code(400)
          .send({ error: `content must be ≤${DISCORD_MESSAGE_MAX} chars` });
        return;
      }

      if (!content.trim() && files.length === 0 && stickerIds.length === 0) {
        reply
          .code(400)
          .send({ error: "content, attachment, or sticker required" });
        return;
      }

      try {
        const sent: DjsMessage = await channel.send({
          content: content || undefined,
          files: files.length > 0 ? files : undefined,
          stickers: stickerIds.length > 0 ? stickerIds : undefined,
          reply: replyToMessageId
            ? { messageReference: replyToMessageId, failIfNotExists: false }
            : undefined,
          // Only set allowedMentions when actually replying; for
          // non-reply messages Discord's defaults are fine.
          allowedMentions: replyToMessageId
            ? {
                repliedUser: replyPingAuthor,
                parse: ["users", "roles", "everyone"],
              }
            : undefined,
        });
        return { message: toApiMessage(sent) };
      } catch (err) {
        request.log.error({ err }, "failed to send DM");
        reply.code(502).send({ error: "Failed to send DM" });
      }
    },
  );

  server.post<{ Body: StartBody }>(
    "/api/dm/channels",
    async (request, reply) => {
      if (!requireCapability(request, reply, "dm.message")) return;
      const recipientUserId =
        typeof request.body?.recipientUserId === "string"
          ? request.body.recipientUserId
          : "";
      if (!isSnowflake(recipientUserId)) {
        reply.code(400).send({ error: "recipientUserId must be a snowflake" });
        return;
      }
      try {
        const user = await bot.users.fetch(recipientUserId);
        const channel = await user.createDM();
        const summary = await inbox.upsertChannel(channel.id, {
          id: user.id,
          username: user.username,
          globalName: user.globalName ?? null,
          avatarUrl: avatarUrlFor(user.id, user.avatar),
        });
        events.publish({ type: "channel-touched", channel: summary });
        return { channel: summary };
      } catch (err) {
        request.log.error({ err }, "failed to start DM");
        reply.code(404).send({ error: "User not found or DMs unavailable" });
      }
    },
  );

  server.patch<{
    Params: { channelId: string; messageId: string };
    Body: { content?: unknown };
  }>(
    "/api/dm/channels/:channelId/messages/:messageId",
    async (request, reply) => {
      if (!requireCapability(request, reply, "dm.message")) return;
      if (!isSnowflake(request.params.messageId)) {
        reply.code(400).send({ error: "invalid messageId" });
        return;
      }
      const channel = await fetchDmChannel(bot, request.params.channelId);
      if (!channel) {
        reply.code(404).send({ error: "Unknown DM channel" });
        return;
      }
      const content =
        typeof request.body?.content === "string" ? request.body.content : "";
      if (!content.trim()) {
        reply.code(400).send({ error: "content required" });
        return;
      }
      if (content.length > DISCORD_MESSAGE_MAX) {
        reply
          .code(400)
          .send({ error: `content must be ≤${DISCORD_MESSAGE_MAX} chars` });
        return;
      }
      try {
        const message = await channel.messages.fetch(request.params.messageId);
        if (message.author.id !== bot.user?.id) {
          reply
            .code(403)
            .send({ error: "Can only edit messages sent by the bot" });
          return;
        }
        const edited = await message.edit({ content });
        events.publish({
          type: "message-updated",
          channelId: channel.id,
          message: toApiMessage(edited),
        });
        return { message: toApiMessage(edited) };
      } catch (err) {
        request.log.error({ err }, "failed to edit message");
        reply.code(502).send({ error: "Failed to edit message" });
      }
    },
  );

  server.delete<{ Params: { channelId: string; messageId: string } }>(
    "/api/dm/channels/:channelId/messages/:messageId",
    async (request, reply) => {
      if (!requireCapability(request, reply, "dm.message")) return;
      if (!isSnowflake(request.params.messageId)) {
        reply.code(400).send({ error: "invalid messageId" });
        return;
      }
      const channel = await fetchDmChannel(bot, request.params.channelId);
      if (!channel) {
        reply.code(404).send({ error: "Unknown DM channel" });
        return;
      }
      try {
        const message = await channel.messages.fetch(request.params.messageId);
        if (message.author.id !== bot.user?.id) {
          reply
            .code(403)
            .send({ error: "Can only delete messages sent by the bot" });
          return;
        }
        await message.delete();
        events.publish({
          type: "message-deleted",
          channelId: channel.id,
          messageId: request.params.messageId,
        });
        reply.code(204).send();
      } catch (err) {
        request.log.error({ err }, "failed to delete message");
        reply.code(502).send({ error: "Failed to delete message" });
      }
    },
  );

  server.get<{
    Params: { channelId: string; messageId: string };
    Querystring: { emojiId?: string; emojiName?: string };
  }>(
    "/api/dm/channels/:channelId/messages/:messageId/reactions/users",
    async (request, reply) => {
      if (!requireCapability(request, reply, "dm.message")) return;
      if (!isSnowflake(request.params.messageId)) {
        reply.code(400).send({ error: "invalid messageId" });
        return;
      }
      const channel = await fetchDmChannel(bot, request.params.channelId);
      if (!channel) {
        reply.code(404).send({ error: "Unknown DM channel" });
        return;
      }
      const key = request.query.emojiId ?? request.query.emojiName;
      if (!key) {
        reply.code(400).send({ error: "emoji required" });
        return;
      }
      try {
        const message = await channel.messages.fetch(request.params.messageId);
        const reaction = message.reactions.cache.get(key);
        if (!reaction) return { users: [] };
        const users = await reaction.users.fetch();
        return {
          users: [...users.values()].map((u) => ({
            id: u.id,
            username: u.username,
            globalName: u.globalName ?? null,
            avatarUrl: avatarUrlFor(u.id, u.avatar),
          })),
        };
      } catch (err) {
        request.log.error({ err }, "failed to fetch DM reaction users");
        reply.code(502).send({ error: "Failed to fetch reaction users" });
      }
    },
  );

  server.post<{
    Params: { channelId: string; messageId: string };
    Body: ReactionBody;
  }>(
    "/api/dm/channels/:channelId/messages/:messageId/reactions",
    async (request, reply) => {
      if (!requireCapability(request, reply, "dm.message")) return;
      if (!isSnowflake(request.params.messageId)) {
        reply.code(400).send({ error: "invalid messageId" });
        return;
      }
      const channel = await fetchDmChannel(bot, request.params.channelId);
      if (!channel) {
        reply.code(404).send({ error: "Unknown DM channel" });
        return;
      }
      const emoji = request.body?.emoji;
      if (!emoji) {
        reply.code(400).send({ error: "emoji required" });
        return;
      }
      const resolvable = emojiResolvable({
        id: emoji.id ?? null,
        name: emoji.name ?? "",
        animated: !!emoji.animated,
      });
      if (!resolvable) {
        reply.code(400).send({ error: "emoji.id or emoji.name required" });
        return;
      }
      try {
        const message = await channel.messages.fetch(request.params.messageId);
        await message.react(resolvable);
        // The gateway-driven messageReactionAdd listener publishes the
        // authoritative state once the change propagates; doing it here
        // races with Discord's eventual consistency and produces stale
        // counts.
        reply.code(204).send();
      } catch (err) {
        request.log.error({ err }, "failed to add reaction");
        const msg = err instanceof Error ? err.message : String(err);
        reply
          .code(discordErrorStatus(err))
          .send({ error: `Failed to add reaction: ${msg}` });
      }
    },
  );

  server.delete<{
    Params: { channelId: string; messageId: string };
    Body: ReactionBody;
  }>(
    "/api/dm/channels/:channelId/messages/:messageId/reactions",
    async (request, reply) => {
      if (!requireCapability(request, reply, "dm.message")) return;
      if (!isSnowflake(request.params.messageId)) {
        reply.code(400).send({ error: "invalid messageId" });
        return;
      }
      const channel = await fetchDmChannel(bot, request.params.channelId);
      if (!channel) {
        reply.code(404).send({ error: "Unknown DM channel" });
        return;
      }
      const emoji = request.body?.emoji;
      if (!emoji) {
        reply.code(400).send({ error: "emoji required" });
        return;
      }
      const key = emojiCacheKey({
        id: emoji.id ?? null,
        name: emoji.name ?? "",
      });
      if (!key) {
        reply.code(400).send({ error: "emoji.id or emoji.name required" });
        return;
      }
      try {
        const message = await channel.messages.fetch(request.params.messageId);
        const reaction = message.reactions.cache.get(key);
        if (reaction && bot.user) await reaction.users.remove(bot.user.id);
        // gateway listener handles the SSE publish — see add route note.
        reply.code(204).send();
      } catch (err) {
        request.log.error({ err }, "failed to remove reaction");
        const msg = err instanceof Error ? err.message : String(err);
        reply
          .code(discordErrorStatus(err))
          .send({ error: `Failed to remove reaction: ${msg}` });
      }
    },
  );

  server.get<{ Params: { channelId: string } }>(
    "/api/dm/channels/:channelId/pins",
    async (request, reply) => {
      if (!requireCapability(request, reply, "dm.message")) return;
      const channel = await fetchDmChannel(bot, request.params.channelId);
      if (!channel) {
        reply.code(404).send({ error: "Unknown DM channel" });
        return;
      }
      try {
        // Discord caps pinned messages at 50, so this is always a
        // single round-trip — no pagination needed.
        const pinned = await channel.messages.fetchPinned();
        const messages = [...pinned.values()]
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
          .map(toApiMessage);
        return { messages };
      } catch (err) {
        request.log.error({ err }, "failed to fetch DM pins");
        reply.code(502).send({ error: "Failed to fetch pins" });
      }
    },
  );

  server.get<{ Querystring: { lastEventId?: string } }>(
    "/api/dm/events",
    async (request, reply) => {
      if (!requireCapability(request, reply, "dm.message")) return;

      // Reject before hijacking the socket so we can still send a normal
      // HTTP 503 response. Once hijack() is called + writeHead(200) is sent,
      // we can no longer change the status code.
      if (events.isAtLimit()) {
        reply
          .code(503)
          .send({ error: "Too many SSE connections, try again later" });
        return;
      }

      // Hand the socket to us — without this fastify auto-sends a body once
      // the async handler returns, which races with our SSE writes and the
      // browser sees the connection close immediately.
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write(": connected\n\n");

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(": ping\n\n");
        } catch {
          /* ignore */
        }
      }, 25_000);
      heartbeat.unref();

      let unsubscribe: (() => void) | null = null;
      const teardown = () => {
        clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = null;
      };

      // Write one SSE frame, stamping it with the stream id so the client can
      // resume from it after a reconnect. Returns false (and tears down) when
      // the socket is closed or backpressured.
      const writeFrame = (id: string, name: string, data: unknown): boolean => {
        const payload = `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
        const result = safeWriteSseEvent(reply, payload, {
          path: "/api/dm/events",
        });
        if (!result.ok) teardown();
        return result.ok;
      };

      // Reconnect replay: if the client sent its last-seen id, deliver the gap
      // BEFORE subscribing to live events. publish() is synchronous and there
      // is no await between replay and subscribe(), so no event can slip in
      // unseen or be delivered twice.
      const lastEventId =
        request.query.lastEventId ??
        (request.headers["last-event-id"] as string | undefined);
      if (lastEventId) {
        const replay = events.replaySince(lastEventId);
        if (replay.kind === "resync") {
          // Gap exceeds the retained buffer, or the server restarted: tell the
          // client to do a full reload. Stamp with the head id so it resumes
          // cleanly from here on.
          if (!writeFrame(events.latestId(), "resync", {})) return;
        } else if (replay.kind === "replay") {
          for (const { id, event } of replay.events) {
            if (!writeFrame(id, event.type, event)) return;
          }
        }
      }

      unsubscribe = events.subscribe((event, id) => {
        writeFrame(id, event.type, event);
      });

      request.raw.on("close", teardown);
    },
  );
}
