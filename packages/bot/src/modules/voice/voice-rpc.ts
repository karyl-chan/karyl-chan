/**
 * Plugin RPC for voice control.
 *
 * Plugins call these to make the bot join/leave a guild voice channel
 * and stream an audio URL. Mounted by plugin-rpc-routes alongside its
 * other endpoints — a thin auth wrapper checks the plugin's scope set.
 *
 * Required scopes (manifest.scopes / token.scopes):
 *   voice.join     — joinVoiceChannel
 *   voice.leave    — leave
 *   voice.play     — play a URL
 *   voice.pause    — pause / resume the current track
 *   voice.stop     — stop playback
 *   voice.status   — read connection status
 *   voice.locate   — find which VC a user is currently in (no guild needed)
 *
 * The plugin must already know the channel id (it gets one via the
 * Discord events bridge or its own discovery). We don't auto-join from
 * the message author's voice state because that requires guild member
 * intent and a richer body shape; plugins that want that pattern can
 * implement it themselves and just hand us a channel_id.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Client, Guild } from "discord.js";
import { ChannelType } from "discord.js";
import { getVoiceBackend, VoiceCapacityError } from "./voice-backend.js";
import { findPluginById } from "../plugin-system/models/plugin.model.js";
import {
  assertExternalTarget,
  assertPluginTarget,
  HostPolicyError,
} from "../../utils/host-policy.js";
import { RateLimiter } from "../../utils/rate-limiter.js";

interface VoiceRpcOptions {
  bot?: Client;
}

/** Throttle voice.play per (plugin, guild) — caps `/radio play`+skip spam
 *  / a runaway advance loop. Generous (≈2/s) so a burst of skips is fine. */
const voicePlayLimiter = new RateLimiter({ max: 20, windowMs: 10_000 });

/** Throttle voice.locate per (plugin, user) — each call scans the guild
 *  cache, and an external control channel (browser extension) may poll it.
 *  ≈1/s. */
const voiceLocateLimiter = new RateLimiter({ max: 10, windowMs: 10_000 });

async function requireScope(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: string,
): Promise<{ pluginId: number; pluginUrl: string } | null> {
  const auth = request.pluginAuth;
  if (!auth) {
    reply.code(401).send({ error: "plugin auth missing" });
    return null;
  }
  if (!auth.scopes.has(scope)) {
    reply.code(403).send({ error: `plugin token missing scope '${scope}'` });
    return null;
  }
  const plugin = await findPluginById(auth.pluginId);
  if (!plugin || !plugin.enabled || plugin.status !== "active") {
    reply
      .code(403)
      .send({ error: "plugin is disabled or inactive on the bot" });
    return null;
  }
  return { pluginId: auth.pluginId, pluginUrl: plugin.url };
}

export async function registerVoiceRpcRoutes(
  server: FastifyInstance,
  options: VoiceRpcOptions,
): Promise<void> {
  const bot = options.bot;

  // POST /api/plugin/voice.join
  // Body: { guild_id: string, channel_id?: string, user_id?: string,
  //         self_deaf?: boolean, self_mute?: boolean }
  //
  // Provide `channel_id` to join a specific voice channel, OR `user_id`
  // to join whatever voice channel that member is currently in (needs
  // the GuildVoiceStates intent — which the bot has). At least one is
  // required; `channel_id` wins if both are given.
  server.post<{
    Body: {
      guild_id?: unknown;
      channel_id?: unknown;
      user_id?: unknown;
      self_deaf?: unknown;
      self_mute?: unknown;
    };
  }>("/api/plugin/voice.join", async (request, reply) => {
    const ctx = await requireScope(request, reply, "voice.join");
    if (!ctx) return;
    if (!bot) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (typeof body.guild_id !== "string") {
      reply.code(400).send({ error: "guild_id required" });
      return;
    }
    const hasChannel = typeof body.channel_id === "string";
    const hasUser = typeof body.user_id === "string";
    if (!hasChannel && !hasUser) {
      reply.code(400).send({ error: "channel_id or user_id required" });
      return;
    }
    const guild = await bot.guilds.fetch(body.guild_id).catch(() => null);
    if (!guild) {
      reply.code(404).send({ error: "guild not found or bot not in it" });
      return;
    }
    let channelId: string | null = hasChannel
      ? (body.channel_id as string)
      : null;
    if (!channelId && hasUser) {
      const member = await guild.members
        .fetch(body.user_id as string)
        .catch(() => null);
      channelId = member?.voice.channelId ?? null;
      if (!channelId) {
        reply.code(404).send({ error: "that user is not in a voice channel" });
        return;
      }
    }
    const channel = channelId
      ? await guild.channels.fetch(channelId).catch(() => null)
      : null;
    if (
      !channel ||
      (channel.type !== ChannelType.GuildVoice &&
        channel.type !== ChannelType.GuildStageVoice)
    ) {
      reply.code(404).send({ error: "voice channel not found" });
      return;
    }
    try {
      // The backend obtains the gateway adapter itself (in-process: from
      // guild.voiceAdapterCreator; remote: a bridge adapter) — see
      // voice-backend.ts. We've already validated guild + channel above.
      const status = await getVoiceBackend().join({
        guildId: body.guild_id,
        channelId: channel.id,
        selfDeaf: typeof body.self_deaf === "boolean" ? body.self_deaf : true,
        selfMute: typeof body.self_mute === "boolean" ? body.self_mute : false,
      });
      return status;
    } catch (err) {
      // Voice capacity cap; surface as 429 so plugins (radio queue,
      // voice-using plugins) can back off.
      if (err instanceof VoiceCapacityError) {
        reply.code(429).send({
          error: "voice capacity reached",
          message: err.message,
        });
        return;
      }
      throw err;
    }
  });

  server.post<{ Body: { guild_id?: unknown } }>(
    "/api/plugin/voice.leave",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "voice.leave");
      if (!ctx) return;
      const body = request.body ?? {};
      if (typeof body.guild_id !== "string") {
        reply.code(400).send({ error: "guild_id required" });
        return;
      }
      return getVoiceBackend().leave(body.guild_id);
    },
  );

  server.post<{ Body: { guild_id?: unknown; url?: unknown } }>(
    "/api/plugin/voice.play",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "voice.play");
      if (!ctx) return;
      const body = request.body ?? {};
      if (typeof body.guild_id !== "string") {
        reply.code(400).send({ error: "guild_id required" });
        return;
      }
      if (typeof body.url !== "string" || body.url.length === 0) {
        reply.code(400).send({ error: "url required" });
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(body.url);
      } catch {
        reply.code(400).send({ error: "url not a valid URL" });
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        reply.code(400).send({ error: "only http(s) URLs accepted" });
        return;
      }
      if (
        voicePlayLimiter.isRateLimited(
          `voice.play:${ctx.pluginId}:${body.guild_id}`,
        )
      ) {
        reply
          .code(429)
          .header("Retry-After", "1")
          .send({ error: "voice.play rate limited for this guild" });
        return;
      }
      // SSRF guard: a URL pointing at the *calling* plugin's own HTTP
      // surface is fine (e.g. how the radio plugin serves a downloaded
      // library track from `/internal/audio/…`) — that's the permissive
      // plugin-target policy. Anything else is treated as an arbitrary
      // user-supplied media URL and gets the strict external policy
      // (blocks RFC1918 / loopback / link-local / cloud metadata).
      const port = parsed.port
        ? Number(parsed.port)
        : parsed.protocol === "https:"
          ? 443
          : 80;
      let pluginOrigin: string | null = null;
      try {
        pluginOrigin = new URL(ctx.pluginUrl).origin;
      } catch {
        /* malformed plugin url — fall through to the strict check */
      }
      try {
        if (pluginOrigin && parsed.origin === pluginOrigin) {
          await assertPluginTarget(parsed.hostname, port);
        } else {
          await assertExternalTarget(parsed.hostname, port);
        }
      } catch (err) {
        if (err instanceof HostPolicyError) {
          reply.code(403).send({ error: err.message });
          return;
        }
        reply
          .code(400)
          .send({ error: "could not resolve the audio URL's host" });
        return;
      }
      try {
        return await getVoiceBackend().play(body.guild_id, body.url);
      } catch (err) {
        if (err instanceof Error && err.message === "not_joined") {
          reply
            .code(409)
            .send({ error: "bot not joined to a voice channel in that guild" });
          return;
        }
        if (err instanceof Error && err.message === "ffmpeg_not_available") {
          reply.code(503).send({ error: "ffmpeg unavailable" });
          return;
        }
        throw err;
      }
    },
  );

  // POST /api/plugin/voice.pause
  // Body: { guild_id: string, paused?: boolean }  (omit `paused` to toggle)
  // Returns the resulting VoiceStatus (`.paused` reflects the new state).
  server.post<{ Body: { guild_id?: unknown; paused?: unknown } }>(
    "/api/plugin/voice.pause",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "voice.pause");
      if (!ctx) return;
      const body = request.body ?? {};
      if (typeof body.guild_id !== "string") {
        reply.code(400).send({ error: "guild_id required" });
        return;
      }
      const paused =
        typeof body.paused === "boolean" ? body.paused : undefined;
      return getVoiceBackend().pause(body.guild_id, paused);
    },
  );

  server.post<{ Body: { guild_id?: unknown } }>(
    "/api/plugin/voice.stop",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "voice.stop");
      if (!ctx) return;
      const body = request.body ?? {};
      if (typeof body.guild_id !== "string") {
        reply.code(400).send({ error: "guild_id required" });
        return;
      }
      return getVoiceBackend().stop(body.guild_id);
    },
  );

  server.post<{ Body: { guild_id?: unknown } }>(
    "/api/plugin/voice.status",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "voice.status");
      if (!ctx) return;
      const body = request.body ?? {};
      if (typeof body.guild_id !== "string") {
        reply.code(400).send({ error: "guild_id required" });
        return;
      }
      const status = await getVoiceBackend().status(body.guild_id);
      // Augment with the non-bot listener count when connected — this
      // service has no Discord client, the RPC layer does. Best-effort:
      // any hiccup leaves `listeners` undefined (callers treat that as
      // "unknown", not "empty").
      if (bot && status.connected && status.channelId) {
        try {
          const ch =
            bot.channels.cache.get(status.channelId) ??
            (await bot.channels.fetch(status.channelId).catch(() => null));
          if (ch && ch.isVoiceBased()) {
            // Extract once so listeners count + ids stay consistent.
            // `listenerIds` lets a plugin (e.g. a DJ controller) render
            // which users are in voice without a separate members.get
            // round-trip — both the count and the ids come from the same
            // membership snapshot. `channelName` / `guildName` come from
            // the same fetched channel so a status panel can label the
            // connection ("Playing in 🔊 General") without an extra lookup.
            const nonBot = ch.members.filter((m) => !m.user.bot);
            return {
              ...status,
              channelName: ch.name,
              guildName: ch.guild?.name ?? null,
              listeners: nonBot.size,
              listenerIds: [...nonBot.keys()],
            };
          }
        } catch {
          /* leave listeners / listenerIds undefined */
        }
      }
      return status;
    },
  );

  // POST /api/plugin/voice.locate
  // Body: { user_id: string }
  //
  // Reverse-lookup: "which voice channel(s) is this user currently in?" —
  // without the caller knowing the guild. Scans the guilds this (shard's)
  // bot shares with the user and reads each guild's cached voice state.
  // Powers an external control channel (e.g. a browser extension) that
  // says "play wherever I am" with no guild configured.
  //
  // Always 200 with a (possibly empty) match list — the caller decides:
  // 0 = not in a reachable VC, 1 = act there, >1 = ambiguous (let the user
  // pick). A structured body (rather than 404/409 status codes) lets a
  // status panel render each candidate's guild / channel name directly.
  //
  //   200 { matches: [{ guildId, guildName, channelId, channelName }] }
  //
  // Multi-shard caveat: `bot.guilds.cache` only holds guilds owned by this
  // shard, so a user in a VC on another shard won't appear here. Matches
  // the per-shard scope of the voice-state store; fine for single-process.
  server.post<{ Body: { user_id?: unknown } }>(
    "/api/plugin/voice.locate",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "voice.locate");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body ?? {};
      if (typeof body.user_id !== "string" || body.user_id.length === 0) {
        reply.code(400).send({ error: "user_id required" });
        return;
      }
      const userId = body.user_id;
      if (voiceLocateLimiter.isRateLimited(`voice.locate:${ctx.pluginId}:${userId}`)) {
        reply.code(429).header("Retry-After", "1").send({
          error: "voice.locate rate limited for this user",
        });
        return;
      }
      interface Match {
        guildId: string;
        guildName: string;
        channelId: string;
        channelName: string | null;
      }
      const toMatch = (guild: Guild, channelId: string): Match => ({
        guildId: guild.id,
        guildName: guild.name,
        channelId,
        channelName: guild.channels.cache.get(channelId)?.name ?? null,
      });

      // Fast path: read the gateway voice-state cache per shared guild.
      const matches: Match[] = [];
      for (const guild of bot.guilds.cache.values()) {
        const channelId = guild.voiceStates.cache.get(userId)?.channelId;
        if (channelId) matches.push(toMatch(guild, channelId));
      }

      // Cache-miss recovery. The gateway voice-state cache can drift: a
      // VOICE_STATE_UPDATE missed across a resume gap isn't replayed, so a
      // user who joined voice during that window stays absent from the
      // cache until the next full GUILD_CREATE (bot restart). When the
      // fast scan finds nothing, confirm against the REST voice-state
      // endpoint (GET /guilds/{id}/voice-states/{user}) before reporting
      // "not in voice". Only runs on a miss; the panel polls only while
      // its popup is open, so the extra REST calls stay bounded.
      let recovered = false;
      if (matches.length === 0) {
        for (const guild of bot.guilds.cache.values()) {
          // Only probe guilds the user belongs to — skips REST 404s across
          // unrelated guilds when the user simply isn't in voice anywhere.
          // An active user (who can drive this RPC) is reliably member-cached
          // in their guild, so this keeps recovery cheap without losing them.
          if (!guild.members.cache.has(userId)) continue;
          const vs = await guild.voiceStates
            .fetch(userId, { force: true })
            .catch(() => null);
          const channelId = vs?.channelId;
          if (channelId) {
            recovered = true;
            matches.push(toMatch(guild, channelId));
          }
        }
        if (recovered) {
          request.log.info(
            { userId, matches: matches.length },
            "voice.locate recovered via REST after cache miss",
          );
        }
      }
      return { matches };
    },
  );
}
