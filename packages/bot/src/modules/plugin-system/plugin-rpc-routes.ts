import type { Client } from "discord.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config.js";
import { ChannelType, Routes, MessageFlags } from "discord.js";
import { RateLimiter } from "../../utils/rate-limiter.js";
import { findPluginById } from "./models/plugin.model.js";
import {
  deleteKv,
  getKv,
  incrementKv,
  listKvKeys,
  setKv,
  sumGuildBytes,
  withGuildKvLock,
} from "./models/plugin-kv.model.js";
import {
  deleteConfigKey,
  findConfigByPlugin,
  upsertConfigKey,
} from "./models/plugin-config.model.js";
import { decryptSecret } from "../../utils/crypto.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";
import {
  findEnabledFeaturesByPluginGuild,
  findFeatureRowsByPlugin,
} from "../feature-toggle/models/plugin-guild-feature.model.js";
import { findFeatureDefaultsByPlugin } from "../feature-toggle/models/plugin-feature-default.model.js";
import type { PluginManifest } from "./plugin-registry.service.js";
import { jwtService } from "../web-core/jwt.service.js";
import { resolveUserCapabilities } from "../admin/authorized-user.service.js";
import { makePluginCapabilityToken } from "../admin/admin-capabilities.js";
import { discordErrorStatus } from "../web-core/discord-error.js";
import { assertPluginTarget, HostPolicyError } from "../../utils/host-policy.js";
import {
  describeOwnershipFailure,
  findUnownedCustomId,
  findUnownedModalCustomId,
} from "./plugin-component-ownership.js";
import {
  clearPluginDeferState,
  readPluginDeferState,
} from "./plugin-defer-state.js";

/**
 * Strip dangerous `parse` entries from a plugin-supplied
 * `allowed_mentions` object so a `parse: ["everyone"]` field can't be
 * smuggled into `channel.send`. Only the explicit allowlists (users /
 * roles / repliedUser) survive — a plugin that wants to ping a role
 * must opt in by ID via `roles: ["<id>"]`, not by bulk-parsing every
 * `<@&id>` token in the content. Snowflake-shaped strings only on the
 * id lists (defence in depth against `everyone` smuggled into `roles`).
 */
const SNOWFLAKE_RE = /^[0-9]{17,20}$/;
/**
 * Subset of MessageFlags a plugin is allowed to set via
 * `interactions.respond` / `interactions.followup`. Ephemeral is
 * deliberately NOT included — that bit is controlled by the dedicated
 * `ephemeral` field which has follow-on routing behaviour (POST a
 * public webhook follow-up vs PATCH @original). Letting a plugin sneak
 * the Ephemeral bit in through `flags` would bypass that.
 *
 * SuppressEmbeds (1 << 2)         = 4
 * SuppressNotifications (1 << 12) = 4096
 */
const ALLOWED_MESSAGE_FLAGS_MASK =
  MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications;

function sanitizePluginFlags(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const n = Math.trunc(raw);
  if (n < 0) return 0;
  return n & ALLOWED_MESSAGE_FLAGS_MASK;
}

function safeAllowedMentions(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return { parse: [] };
  const m = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { parse: [] };
  if (Array.isArray(m.users)) {
    out.users = m.users.filter(
      (v): v is string => typeof v === "string" && SNOWFLAKE_RE.test(v),
    );
  }
  if (Array.isArray(m.roles)) {
    out.roles = m.roles.filter(
      (v): v is string => typeof v === "string" && SNOWFLAKE_RE.test(v),
    );
  }
  if (typeof m.repliedUser === "boolean") out.repliedUser = m.repliedUser;
  return out;
}

/**
 * Plugin RPC endpoints: the things plugins are allowed to ask the bot
 * to do on their behalf. Auth (bearer plugin token → request.pluginAuth)
 * is enforced by server.ts onRequest hook before any handler runs.
 *
 * Each handler additionally enforces:
 *   - the manifest's `rpc_methods_used` allowlist (least privilege)
 *   - the plugin must still be `enabled=true` and `status='active'`
 *     in the DB at call time (the in-memory token cache outlives a
 *     disable; we re-check on every call)
 *
 * Endpoints intentionally use a flat `/api/plugin/<verb>` shape
 * rather than nested resources because RPC verbs map cleanly to
 * Discord.js method calls and we want a 1:1 audit story.
 */

export interface PluginRpcOptions {
  bot?: Client;
  /** Injected for tests; production uses the module-level singleton. */
  dmLimiter?: { isRateLimited(key: string): boolean };
}

/** Module-level singleton — one limiter shared across all requests. */
const defaultDmLimiter = new RateLimiter({
  max: config.plugin.dmRatePerSec,
  windowMs: config.plugin.dmWindowMs,
});

const KV_KEY_MAX = 200;
const KV_VALUE_MAX_BYTES = config.plugin.kvValueMaxBytes; // hard ceiling regardless of manifest quota
const DEFAULT_KV_QUOTA_BYTES = 64 * 1024;

function rejectForbidden(reply: FastifyReply, scope: string): void {
  reply.code(403).send({ error: `plugin token missing scope '${scope}'` });
}

/** Max user ids resolvable in one members.get batch. */
const MEMBERS_GET_MAX = 25;

/** Max attachments per message, and per-file byte cap. */
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // Discord's non-boosted limit

/**
 * Resolve plugin-supplied attachment descriptors into Discord-ready
 * file buffers.
 *
 * Plugins describe an attachment as `{ name, path }` where `path` is
 * a path on the plugin's own HTTP surface (e.g. `/art/merlin.png`).
 * The bot fetches `<plugin.url><path>` server-side and forwards the
 * bytes to Discord as a real file. This lets a plugin embed images
 * (`attachment://<name>`) without needing a Discord-reachable public
 * URL — the fetch happens over the internal bot↔plugin network.
 *
 * SSRF is bounded: the fetch base is the plugin's own registered
 * `url`, run through the same `assertPluginTarget` host policy used
 * by the interaction dispatcher; `path` is forced to a leading-slash
 * relative path so it can't swap the host.
 *
 * Throws on any malformed descriptor / disallowed host / oversize
 * body so the caller can surface a 400.
 */
async function resolvePluginAttachments(
  pluginId: number,
  raw: unknown,
): Promise<Array<{ name: string; data: Buffer }>> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("attachments must be an array");
  if (raw.length === 0) return [];
  if (raw.length > MAX_ATTACHMENTS) {
    throw new Error(`at most ${MAX_ATTACHMENTS} attachments`);
  }
  const plugin = await findPluginById(pluginId);
  if (!plugin) throw new Error("plugin not found");
  const base = plugin.url.replace(/\/+$/, "");
  const parsedBase = new URL(base);
  const port = parsedBase.port
    ? Number(parsedBase.port)
    : parsedBase.protocol === "https:"
      ? 443
      : 80;
  await assertPluginTarget(parsedBase.hostname, port);

  const out: Array<{ name: string; data: Buffer }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      throw new Error("attachment entry must be an object");
    }
    const e = entry as { name?: unknown; path?: unknown };
    if (typeof e.name !== "string" || e.name.length === 0) {
      throw new Error("attachment.name required");
    }
    if (typeof e.path !== "string" || !e.path.startsWith("/")) {
      throw new Error("attachment.path must be a leading-slash path");
    }
    const res = await fetch(`${base}${e.path}`);
    if (!res.ok) {
      throw new Error(`attachment fetch ${e.path} → ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment ${e.name} exceeds size cap`);
    }
    out.push({ name: e.name, data: buf });
  }
  return out;
}

async function requireScope(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: string,
): Promise<{ pluginId: number; pluginKey: string } | null> {
  const auth = request.pluginAuth;
  if (!auth) {
    reply.code(401).send({ error: "plugin auth missing" });
    return null;
  }
  if (!auth.scopes.has(scope)) {
    rejectForbidden(reply, scope);
    return null;
  }
  // The token was minted with scopes baked in, but the plugin row may
  // have been admin-disabled or expired since then. Re-check liveness.
  const plugin = await findPluginById(auth.pluginId);
  if (!plugin || !plugin.enabled || plugin.status !== "active") {
    reply
      .code(403)
      .send({ error: "plugin is disabled or inactive on the bot" });
    return null;
  }
  return { pluginId: auth.pluginId, pluginKey: auth.pluginKey };
}

function getManifest(manifestJson: string): PluginManifest | null {
  try {
    return JSON.parse(manifestJson) as PluginManifest;
  } catch {
    return null;
  }
}

async function quotaForGuildKv(pluginId: number): Promise<number> {
  // Read quota from the plugin's stored manifest. Falls back to a
  // bot-wide default if the plugin didn't declare one.
  const plugin = await findPluginById(pluginId);
  if (!plugin) return DEFAULT_KV_QUOTA_BYTES;
  const manifest = getManifest(plugin.manifestJson);
  const declaredKb = manifest?.storage?.guildKvQuotaKb;
  if (typeof declaredKb === "number" && declaredKb > 0) {
    return Math.min(declaredKb * 1024, KV_VALUE_MAX_BYTES * 16);
  }
  return DEFAULT_KV_QUOTA_BYTES;
}

/**
 * Verify a channel actually belongs to the claimed guild. The
 * per-guild feature gate only knows which guild the plugin asked
 * about — Discord's `/channels/:id/*` routes are keyed on the
 * channel alone, so without this check a plugin enabled in guild A
 * could pass `channel_id` of any channel in guild B and read/write
 * across the boundary. Hits the in-memory cache when populated and
 * falls back to a single REST lookup. Returns false when the channel
 * is unknown or in a different guild.
 */
async function assertChannelInGuild(
  bot: Client,
  channelId: string,
  expectedGuildId: string,
): Promise<boolean> {
  const cached = bot.channels.cache.get(channelId);
  if (cached) {
    if (cached.isDMBased()) return false;
    return (
      "guildId" in cached &&
      (cached as { guildId?: string | null }).guildId === expectedGuildId
    );
  }
  try {
    const ch = (await bot.rest.get(Routes.channel(channelId))) as {
      guild_id?: string;
    };
    return ch.guild_id === expectedGuildId;
  } catch {
    return false;
  }
}

export async function registerPluginRpcRoutes(
  server: FastifyInstance,
  options: PluginRpcOptions,
): Promise<void> {
  const bot = options.bot;
  const dmLimiter = options.dmLimiter ?? defaultDmLimiter;

  // ─── messages.send ────────────────────────────────────────────────
  /**
   * POST /api/plugin/messages.send
   * Body: { channel_id: string, content?: string, embeds?: APIEmbed[],
   *         allowed_mentions?: { parse?: ('users'|'roles'|'everyone')[] } }
   * Returns: { id, channel_id }
   *
   * The plugin can target any text channel the bot has access to in
   * any guild it's in, plus DM channels of any user. A future revision
   * may narrow this to the plugin's own guild_features scope; today
   * we trust operator-installed plugins to behave.
   */
  server.post<{
    Body: {
      channel_id?: unknown;
      content?: unknown;
      embeds?: unknown;
      components?: unknown;
      allowed_mentions?: unknown;
      attachments?: unknown;
    };
  }>("/api/plugin/messages.send", async (request, reply) => {
    const ctx = await requireScope(request, reply, "messages.send");
    if (!ctx) return;
    if (!bot) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (typeof body.channel_id !== "string" || body.channel_id.length === 0) {
      reply.code(400).send({ error: "channel_id required" });
      return;
    }
    const content = typeof body.content === "string" ? body.content : undefined;
    const embeds = Array.isArray(body.embeds) ? body.embeds : undefined;
    const components = Array.isArray(body.components)
      ? body.components
      : undefined;
    if (!content && !embeds) {
      reply.code(400).send({ error: "content or embeds required" });
      return;
    }
    if (components) {
      const failure = findUnownedCustomId(ctx.pluginKey, components);
      if (failure) {
        reply.code(400).send({
          error: describeOwnershipFailure(ctx.pluginKey, failure),
        });
        return;
      }
    }
    let attachments: Array<{ name: string; data: Buffer }>;
    try {
      attachments = await resolvePluginAttachments(
        ctx.pluginId,
        body.attachments,
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(400).send({ error: `attachment error: ${m}` });
      return;
    }
    let channel;
    try {
      channel = await bot.channels.fetch(body.channel_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(404).send({ error: `channel fetch failed: ${msg}` });
      return;
    }
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      reply.code(400).send({ error: "channel is not text-sendable" });
      return;
    }
    // Per-guild feature gate: plugin must have at least one enabled
    // feature in the target guild. DM and group-DM channels are exempt
    // (no guildId). Threads inherit guildId from their parent and go
    // through the gate, which is the intended behaviour.
    const channelGuildId =
      "guildId" in channel && typeof channel.guildId === "string"
        ? channel.guildId
        : null;
    if (channelGuildId && !channel.isDMBased()) {
      const enabledFeatures = await findEnabledFeaturesByPluginGuild(
        ctx.pluginId,
        channelGuildId,
      );
      if (enabledFeatures.length === 0) {
        if (
          shouldRecord(
            `plugin-rpc-feature-block:${ctx.pluginId}:${channelGuildId}`,
          )
        ) {
          botEventLog.record(
            "warn",
            "feature",
            `plugin ${ctx.pluginKey} tried to send to guild ${channelGuildId} without enabled feature`,
            { pluginId: ctx.pluginId, guildId: channelGuildId },
          );
        }
        reply.code(403).send({ error: "plugin not enabled in this guild" });
        return;
      }
    }
    // Sanitize allowed_mentions — plugins must not be able to force
    // mass-ping behaviour. We strip `parse` entirely (the field that
    // toggles broad @everyone / @here / "every role mention in
    // content" parsing) and only forward the explicit `users` /
    // `roles` / `repliedUser` allowlists. A plugin wanting to ping
    // role X must list `<@&X>` in the content AND `roles: ["X"]`
    // explicitly — no bulk opt-in.
    const allowedMentions = safeAllowedMentions(body.allowed_mentions);
    try {
      const sent = await channel.send({
        content,
        // discord.js v14 accepts raw embed objects; if it's malformed
        // it'll throw, which we surface as a 400.
        embeds: embeds as never,
        // Discord component-v1 action rows passed through verbatim
        // (e.g. link buttons + action buttons on a "now playing" card).
        components: components as never,
        allowedMentions: allowedMentions as never,
        // Plugin-supplied files (bot fetched them from the plugin's
        // own HTTP surface). An embed can reference one via
        // `attachment://<name>`.
        ...(attachments.length > 0
          ? {
              files: attachments.map((a) => ({
                attachment: a.data,
                name: a.name,
              })),
            }
          : {}),
      });
      botEventLog.record(
        "info",
        "bot",
        `plugin ${ctx.pluginKey} sent message in channel ${body.channel_id}`,
        {
          pluginId: ctx.pluginId,
          channelId: body.channel_id,
          messageId: sent.id,
        },
      );
      return { id: sent.id, channel_id: sent.channelId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(discordErrorStatus(err)).send({ error: `send failed: ${msg}` });
      return;
    }
  });

  // ─── messages.send_dm ─────────────────────────────────────────────
  /**
   * POST /api/plugin/messages.send_dm
   * Body: { user_id: string, content?: string, embeds?: APIEmbed[],
   *         allowed_mentions?: { parse?: ('users'|'roles'|'everyone')[] } }
   * Returns: { id, channel_id }
   *
   * Higher-level than messages.send: the plugin gives a Discord user
   * id and we resolve / create the DM channel for them, then send.
   * Without this, the plugin would need a way to discover the user's
   * DM channel id (which Discord doesn't expose to bots), so DM
   * relay-style plugins were impossible to implement at all.
   *
   * Subject to the same allowed_mentions default-deny as messages.send.
   * 404 if the user_id doesn't resolve; 400 if the user has DMs
   * disabled (Discord raises CANNOT_SEND_MESSAGES_TO_THIS_USER).
   */
  server.post<{
    Body: {
      user_id?: unknown;
      content?: unknown;
      embeds?: unknown;
      allowed_mentions?: unknown;
    };
  }>("/api/plugin/messages.send_dm", async (request, reply) => {
    const ctx = await requireScope(request, reply, "messages.send_dm");
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
    const content = typeof body.content === "string" ? body.content : undefined;
    const embeds = Array.isArray(body.embeds) ? body.embeds : undefined;
    if (!content && !embeds) {
      reply.code(400).send({ error: "content or embeds required" });
      return;
    }
    // Per-plugin DM rate limit: enforced *before* bot.users.fetch() so
    // attackers can't spam invalid user_ids to hammer Discord's REST
    // (each fetch is a real GET /users/:id) without ever consuming the
    // bucket. Cost: every well-formed call consumes one slot even if
    // the user turns out not to exist — that's exactly what we want
    // because Discord doesn't care whether the id resolves.
    if (dmLimiter.isRateLimited(`plugin:${ctx.pluginId}:send_dm`)) {
      if (shouldRecord(`plugin-rpc-dm-rate:${ctx.pluginId}`)) {
        botEventLog.record(
          "warn",
          "bot",
          `plugin ${ctx.pluginKey} exceeded DM rate limit`,
          { pluginId: ctx.pluginId },
        );
      }
      reply
        .code(429)
        .header("Retry-After", "1")
        .send({ error: "rate limited" });
      return;
    }
    let user;
    try {
      user = await bot.users.fetch(body.user_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(404).send({ error: `user fetch failed: ${msg}` });
      return;
    }
    const allowedMentions = safeAllowedMentions(body.allowed_mentions);
    try {
      const sent = await user.send({
        content,
        embeds: embeds as never,
        allowedMentions: allowedMentions as never,
      });
      botEventLog.record(
        "info",
        "bot",
        `plugin ${ctx.pluginKey} DM'd user ${body.user_id}`,
        {
          pluginId: ctx.pluginId,
          userId: body.user_id,
          messageId: sent.id,
        },
      );
      return { id: sent.id, channel_id: sent.channelId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(discordErrorStatus(err)).send({ error: `send_dm failed: ${msg}` });
      return;
    }
  });

  // ─── messages.delete ──────────────────────────────────────────────
  server.post<{
    Body: { channel_id?: unknown; message_id?: unknown };
  }>("/api/plugin/messages.delete", async (request, reply) => {
    const ctx = await requireScope(request, reply, "messages.delete");
    if (!ctx) return;
    if (!bot) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (
      typeof body.channel_id !== "string" ||
      typeof body.message_id !== "string"
    ) {
      reply.code(400).send({ error: "channel_id + message_id required" });
      return;
    }
    let channel;
    try {
      channel = await bot.channels.fetch(body.channel_id);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(404).send({ error: `channel fetch failed: ${m}` });
      return;
    }
    if (
      !channel ||
      !channel.isTextBased() ||
      channel.type === ChannelType.GroupDM
    ) {
      reply.code(400).send({ error: "channel not text-based" });
      return;
    }
    // Per-guild feature gate — symmetric with messages.send/edit. A
    // plugin enabled in guild A cannot delete messages in guild B
    // even if it knows the channel/message id (e.g. logged elsewhere).
    const channelGuildId =
      "guildId" in channel && typeof channel.guildId === "string"
        ? channel.guildId
        : null;
    if (channelGuildId && !channel.isDMBased()) {
      const enabledFeatures = await findEnabledFeaturesByPluginGuild(
        ctx.pluginId,
        channelGuildId,
      );
      if (enabledFeatures.length === 0) {
        reply.code(403).send({ error: "plugin not enabled in this guild" });
        return;
      }
    }
    try {
      const msg = await channel.messages.fetch(body.message_id);
      await msg.delete();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(discordErrorStatus(err)).send({ error: `delete failed: ${msg}` });
    }
  });

  // ─── messages.edit ────────────────────────────────────────────────
  /**
   * POST /api/plugin/messages.edit
   * Body: { channel_id, message_id, content?, embeds?, components? }
   * Returns: { id, channel_id }
   *
   * Edit a message the bot sent (typically one it sent via
   * messages.send). `components: []` clears the buttons. Same per-guild
   * feature gate as messages.send — a plugin with no enabled feature in
   * the channel's guild can't edit messages there. Only fields that are
   * present are touched; pass `content: ""` to clear the text.
   */
  server.post<{
    Body: {
      channel_id?: unknown;
      message_id?: unknown;
      content?: unknown;
      embeds?: unknown;
      components?: unknown;
    };
  }>("/api/plugin/messages.edit", async (request, reply) => {
    const ctx = await requireScope(request, reply, "messages.edit");
    if (!ctx) return;
    if (!bot) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (
      typeof body.channel_id !== "string" ||
      typeof body.message_id !== "string"
    ) {
      reply.code(400).send({ error: "channel_id + message_id required" });
      return;
    }
    let channel;
    try {
      channel = await bot.channels.fetch(body.channel_id);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(404).send({ error: `channel fetch failed: ${m}` });
      return;
    }
    if (
      !channel ||
      !channel.isTextBased() ||
      channel.type === ChannelType.GroupDM
    ) {
      reply.code(400).send({ error: "channel not text-based" });
      return;
    }
    const channelGuildId =
      "guildId" in channel && typeof channel.guildId === "string"
        ? channel.guildId
        : null;
    if (channelGuildId && !channel.isDMBased()) {
      const enabledFeatures = await findEnabledFeaturesByPluginGuild(
        ctx.pluginId,
        channelGuildId,
      );
      if (enabledFeatures.length === 0) {
        reply.code(403).send({ error: "plugin not enabled in this guild" });
        return;
      }
    }
    if (Array.isArray(body.components)) {
      const failure = findUnownedCustomId(ctx.pluginKey, body.components);
      if (failure) {
        reply.code(400).send({
          error: describeOwnershipFailure(ctx.pluginKey, failure),
        });
        return;
      }
    }
    const editPayload: Record<string, unknown> = {
      allowed_mentions: { parse: [] },
    };
    if (typeof body.content === "string") editPayload.content = body.content;
    if (Array.isArray(body.embeds)) editPayload.embeds = body.embeds;
    if (Array.isArray(body.components)) editPayload.components = body.components;
    try {
      const msg = await channel.messages.fetch(body.message_id);
      await msg.edit(editPayload as never);
      return { id: msg.id, channel_id: msg.channelId };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(discordErrorStatus(err)).send({ error: `edit failed: ${m}` });
    }
  });

  // ─── messages.add_reaction ────────────────────────────────────────
  server.post<{
    Body: { channel_id?: unknown; message_id?: unknown; emoji?: unknown };
  }>("/api/plugin/messages.add_reaction", async (request, reply) => {
    const ctx = await requireScope(request, reply, "messages.add_reaction");
    if (!ctx) return;
    if (!bot) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (
      typeof body.channel_id !== "string" ||
      typeof body.message_id !== "string" ||
      typeof body.emoji !== "string"
    ) {
      reply
        .code(400)
        .send({ error: "channel_id + message_id + emoji required" });
      return;
    }
    let channel;
    try {
      channel = await bot.channels.fetch(body.channel_id);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(404).send({ error: `channel fetch failed: ${m}` });
      return;
    }
    if (!channel || !channel.isTextBased()) {
      reply.code(400).send({ error: "channel not text-based" });
      return;
    }
    // Per-guild feature gate — symmetric with messages.send/edit/delete.
    const channelGuildId =
      "guildId" in channel && typeof channel.guildId === "string"
        ? channel.guildId
        : null;
    if (channelGuildId && !channel.isDMBased()) {
      const enabledFeatures = await findEnabledFeaturesByPluginGuild(
        ctx.pluginId,
        channelGuildId,
      );
      if (enabledFeatures.length === 0) {
        reply.code(403).send({ error: "plugin not enabled in this guild" });
        return;
      }
    }
    try {
      const msg = await channel.messages.fetch(body.message_id);
      await msg.react(body.emoji);
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(discordErrorStatus(err)).send({ error: `add_reaction failed: ${m}` });
    }
  });

  // ─── config.get ────────────────────────────────────────────────────
  /**
   * POST /api/plugin/config.get
   * Body: {} (no params; plugin only sees its own config)
   * Returns:
   *   { values: Record<string, string>, schema: ManifestConfigField[] }
   *
   * Surfaces the plugin's combined config map. Values for `secret`-
   * typed admin fields are decrypted on the way out — the plugin
   * needs the real value to act on it. Plugin-self KV (config.set
   * source='plugin') is included alongside admin-edited fields so the
   * plugin sees one flat map.
   *
   * Rate-limit-friendly: rebuilding the full map per call is fine
   * (config rows are O(few-dozen) per plugin). Plugins that hot-loop
   * config.get on every event should cache locally and rely on
   * push-style update via re-poll on a known cadence.
   */
  server.post("/api/plugin/config.get", async (request, reply) => {
    const ctx = await requireScope(request, reply, "config.get");
    if (!ctx) return;
    const plugin = await findPluginById(ctx.pluginId);
    if (!plugin) {
      reply.code(404).send({ error: "plugin row vanished" });
      return;
    }
    const manifest = (() => {
      try {
        return JSON.parse(plugin.manifestJson) as PluginManifest;
      } catch {
        return null;
      }
    })();
    const schemaByKey = new Map(
      (manifest?.config_schema ?? []).map((f) => [f.key, f]),
    );
    const rows = await findConfigByPlugin(ctx.pluginId);
    const values: Record<string, string> = {};
    for (const row of rows) {
      if (row.source === "admin") {
        const field = schemaByKey.get(row.key);
        if (field?.type === "secret" && row.value.length > 0) {
          try {
            values[row.key] = decryptSecret(row.value);
          } catch (err) {
            // A decrypt failure means the row was written with a
            // different ENCRYPTION_KEY (rare; key rotation). Skip
            // rather than crash the RPC; the plugin will see the
            // missing key and can ask the operator to re-enter.
            const msg = err instanceof Error ? err.message : String(err);
            botEventLog.record(
              "warn",
              "bot",
              `config.get: decrypt failed for ${plugin.pluginKey}/${row.key}: ${msg}`,
              { pluginId: ctx.pluginId, key: row.key },
            );
          }
        } else {
          values[row.key] = row.value;
        }
      } else {
        values[row.key] = row.value;
      }
    }
    return { values, schema: manifest?.config_schema ?? [] };
  });

  // ─── config.set ────────────────────────────────────────────────────
  /**
   * POST /api/plugin/config.set
   * Body: { key: string, value: string | null }
   *
   * Plugin-self KV write. Stored under source='plugin' so it never
   * collides with admin-controlled config_schema rows. `null` deletes.
   *
   * For admin-controlled config_schema fields the plugin can READ
   * via config.get but CANNOT set — the plugin's value would be
   * silently overwritten by the next admin save and the source-
   * isolation rule in upsertConfigKey rejects the write outright.
   */
  server.post<{ Body: { key?: unknown; value?: unknown } }>(
    "/api/plugin/config.set",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "config.set");
      if (!ctx) return;
      const body = request.body ?? {};
      if (typeof body.key !== "string" || body.key.length === 0) {
        reply.code(400).send({ error: "key required" });
        return;
      }
      if (body.key.length > 200) {
        reply.code(400).send({ error: "key exceeds 200 chars" });
        return;
      }
      if (
        body.value !== null &&
        body.value !== undefined &&
        typeof body.value !== "string"
      ) {
        reply.code(400).send({ error: "value must be string or null" });
        return;
      }
      try {
        if (body.value === null || body.value === undefined) {
          const removed = await deleteConfigKey(
            ctx.pluginId,
            body.key,
            "plugin",
          );
          return { removed };
        }
        await upsertConfigKey(ctx.pluginId, body.key, body.value, "plugin");
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("cannot overwrite") || msg.includes("cannot delete")) {
          reply.code(409).send({ error: msg });
          return;
        }
        reply.code(500).send({ error: `config.set failed: ${msg}` });
      }
    },
  );

  // ─── storage.kv_get ───────────────────────────────────────────────
  server.post<{
    Body: { guild_id?: unknown; key?: unknown };
  }>("/api/plugin/storage.kv_get", async (request, reply) => {
    const ctx = await requireScope(request, reply, "storage.kv_get");
    if (!ctx) return;
    const body = request.body ?? {};
    if (typeof body.guild_id !== "string" || body.guild_id.length === 0) {
      reply.code(400).send({ error: "guild_id required" });
      return;
    }
    if (typeof body.key !== "string" || body.key.length === 0) {
      reply.code(400).send({ error: "key required" });
      return;
    }
    const row = await getKv(ctx.pluginId, body.guild_id, body.key);
    if (!row) {
      return { found: false, value: null };
    }
    return { found: true, value: row.value, bytes: row.bytes };
  });

  // ─── storage.kv_set ───────────────────────────────────────────────
  server.post<{
    Body: { guild_id?: unknown; key?: unknown; value?: unknown };
  }>("/api/plugin/storage.kv_set", async (request, reply) => {
    const ctx = await requireScope(request, reply, "storage.kv_set");
    if (!ctx) return;
    const body = request.body ?? {};
    if (typeof body.guild_id !== "string" || body.guild_id.length === 0) {
      reply.code(400).send({ error: "guild_id required" });
      return;
    }
    if (
      typeof body.key !== "string" ||
      body.key.length === 0 ||
      body.key.length > KV_KEY_MAX
    ) {
      reply.code(400).send({ error: `key required (max ${KV_KEY_MAX} chars)` });
      return;
    }
    if (typeof body.value !== "string") {
      reply.code(400).send({ error: "value must be a string" });
      return;
    }
    const incomingBytes = Buffer.byteLength(body.value, "utf8");
    if (incomingBytes > KV_VALUE_MAX_BYTES) {
      reply.code(413).send({
        error: `value exceeds per-row hard cap (${KV_VALUE_MAX_BYTES}B)`,
      });
      return;
    }
    // Quota check: sum existing bytes minus what this key already
    // holds (we're overwriting, so subtract it from the budget).
    // The read+write runs under a per-(plugin,guild) mutex so two
    // concurrent sets to different keys can't both observe a stale
    // total and slip past the quota — previously the lack of
    // serialisation let a plugin double-write past its quota.
    const guildId = body.guild_id;
    const key = body.key;
    const value = body.value;
    const reply413 = (msg: string): void => {
      reply.code(413).send({ error: msg });
    };
    const result = await withGuildKvLock<{
      ok: boolean;
      bytes?: number;
      total_bytes?: number;
      quota_bytes?: number;
      error?: string;
    }>(ctx.pluginId, guildId, async () => {
      const quota = await quotaForGuildKv(ctx.pluginId);
      const currentTotal = await sumGuildBytes(ctx.pluginId, guildId);
      const existing = await getKv(ctx.pluginId, guildId, key);
      const projected = currentTotal - (existing?.bytes ?? 0) + incomingBytes;
      if (projected > quota) {
        return {
          ok: false,
          error: `would exceed plugin guild_kv quota (${projected}B / ${quota}B)`,
        };
      }
      const row = await setKv(ctx.pluginId, guildId, key, value);
      return {
        ok: true,
        bytes: row.bytes,
        total_bytes: currentTotal - (existing?.bytes ?? 0) + row.bytes,
        quota_bytes: quota,
      };
    });
    if (!result.ok) {
      reply413(result.error!);
      return;
    }
    return result;
  });

  // ─── storage.kv_increment ─────────────────────────────────────────
  /**
   * POST /api/plugin/storage.kv_increment
   * Body: { guild_id: string, key: string, delta?: number = 1 }
   * Returns: { value: <new number after increment>, bytes, total_bytes, quota_bytes }
   *
   * Atomic counter: read-modify-write inside a single SQLite transaction
   * with row-level lock. Replaces the kv_get + kv_set sequence that
   * lost increments under concurrent calls. Existing value must parse
   * as a finite number; non-numeric existing values 422 (caller bug).
   *
   * Counts as a kv_set for quota purposes — the same per-guild byte
   * cap applies to the post-increment serialised value.
   */
  server.post<{
    Body: { guild_id?: unknown; key?: unknown; delta?: unknown };
  }>("/api/plugin/storage.kv_increment", async (request, reply) => {
    const ctx = await requireScope(request, reply, "storage.kv_increment");
    if (!ctx) return;
    const body = request.body ?? {};
    if (typeof body.guild_id !== "string" || body.guild_id.length === 0) {
      reply.code(400).send({ error: "guild_id required" });
      return;
    }
    if (typeof body.key !== "string" || body.key.length === 0) {
      reply.code(400).send({ error: "key required" });
      return;
    }
    if (body.key.length > KV_KEY_MAX) {
      reply.code(400).send({ error: `key exceeds ${KV_KEY_MAX} chars` });
      return;
    }
    const deltaRaw = body.delta ?? 1;
    if (typeof deltaRaw !== "number" || !Number.isFinite(deltaRaw)) {
      reply.code(400).send({ error: "delta must be a finite number" });
      return;
    }
    try {
      const result = await incrementKv(
        ctx.pluginId,
        body.guild_id,
        body.key,
        deltaRaw,
      );
      const totalBytes = await sumGuildBytes(ctx.pluginId, body.guild_id);
      const quotaBytes = await quotaForGuildKv(ctx.pluginId);
      return {
        value: result.value,
        bytes: result.row.bytes,
        total_bytes: totalBytes,
        quota_bytes: quotaBytes,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Existing-value-not-numeric is the caller's bug, not the bot's
      // — surface it as 422 so the plugin's logs blame the right side.
      if (msg.includes("not a finite number")) {
        reply.code(422).send({ error: msg });
        return;
      }
      reply.code(500).send({ error: `kv_increment failed: ${msg}` });
    }
  });

  // ─── storage.kv_delete ────────────────────────────────────────────
  server.post<{
    Body: { guild_id?: unknown; key?: unknown };
  }>("/api/plugin/storage.kv_delete", async (request, reply) => {
    const ctx = await requireScope(request, reply, "storage.kv_delete");
    if (!ctx) return;
    const body = request.body ?? {};
    if (typeof body.guild_id !== "string" || typeof body.key !== "string") {
      reply.code(400).send({ error: "guild_id + key required" });
      return;
    }
    const removed = await deleteKv(ctx.pluginId, body.guild_id, body.key);
    return { removed };
  });

  // ─── storage.kv_list ──────────────────────────────────────────────
  server.post<{
    Body: {
      guild_id?: unknown;
      prefix?: unknown;
      limit?: unknown;
      offset?: unknown;
    };
  }>("/api/plugin/storage.kv_list", async (request, reply) => {
    const ctx = await requireScope(request, reply, "storage.kv_list");
    if (!ctx) return;
    const body = request.body ?? {};
    if (typeof body.guild_id !== "string") {
      reply.code(400).send({ error: "guild_id required" });
      return;
    }
    const prefix = typeof body.prefix === "string" ? body.prefix : undefined;
    const limit = typeof body.limit === "number" ? body.limit : 100;
    const offset = typeof body.offset === "number" ? body.offset : 0;
    const result = await listKvKeys(ctx.pluginId, body.guild_id, {
      prefix,
      limit,
      offset,
    });
    return { keys: result.keys, total: result.total };
  });

  // ─── interactions.respond ─────────────────────────────────────────
  /**
   * POST /api/plugin/interactions.respond
   * Body: { interaction_token, content?, embeds?, ephemeral?, flags? }
   *
   * Completes a deferred interaction reply. The bot defers ephemerally
   * for every plugin command (modal-kind commands skip defer); the
   * plugin processes the command, then calls this to fill in the
   * placeholder reply within Discord's 15-minute window.
   *
   * Because the bot's defer locked the original reply to ephemeral,
   * `ephemeral: false` here can't change the ephemerality of @original.
   * Instead we treat `ephemeral: false` as "post this publicly":
   *   - POST a fresh public follow-up message with the content
   *   - PATCH the ephemeral @original placeholder with a brief notice
   *     so the user's "thinking…" message resolves
   * `ephemeral: true` (or unset — default true) PATCHes @original in
   * place, matching the original pre-refactor behaviour.
   *
   * `flags` (optional, integer bitmask) lets the plugin set additional
   * MessageFlags Discord supports on this surface (SuppressEmbeds,
   * SuppressNotifications). Ephemeral cannot be flipped this way — the
   * dedicated `ephemeral` field is the only path that affects message
   * visibility.
   */
  server.post<{
    Body: {
      interaction_token?: unknown;
      content?: unknown;
      embeds?: unknown;
      components?: unknown;
      ephemeral?: unknown;
      flags?: unknown;
      attachments?: unknown;
    };
  }>("/api/plugin/interactions.respond", async (request, reply) => {
    const ctx = await requireScope(request, reply, "interactions.respond");
    if (!ctx) return;
    if (!bot || !bot.application) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (
      typeof body.interaction_token !== "string" ||
      body.interaction_token.length === 0
    ) {
      reply.code(400).send({ error: "interaction_token required" });
      return;
    }
    const content = typeof body.content === "string" ? body.content : undefined;
    const embeds = Array.isArray(body.embeds) ? body.embeds : undefined;
    const components = Array.isArray(body.components)
      ? body.components
      : undefined;
    if (!content && !embeds && !components) {
      reply.code(400).send({ error: "content, embeds or components required" });
      return;
    }
    if (components) {
      const failure = findUnownedCustomId(ctx.pluginKey, components);
      if (failure) {
        reply.code(400).send({
          error: describeOwnershipFailure(ctx.pluginKey, failure),
        });
        return;
      }
    }
    let attachments: Array<{ name: string; data: Buffer }>;
    try {
      attachments = await resolvePluginAttachments(
        ctx.pluginId,
        body.attachments,
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(400).send({ error: `attachment error: ${m}` });
      return;
    }
    // Route on defer state.
    //
    // kind='update' (component clicks): the bot called deferUpdate — no
    // "thinking…" placeholder exists, @original IS the user's message
    // hosting the clicked component. Straight PATCH. Mismatch logic
    // would DELETE the user's own message; bug we explicitly guard
    // against here.
    //
    // kind='reply' (commands & modals, the only deferReply callers):
    // ephemerality is locked at defer time. Four cases:
    //
    //   defer=E, want=E  → PATCH @original                    (happy)
    //   defer=P, want=P  → PATCH @original                    (happy)
    //   defer=E, want=P  → POST public follow-up + DELETE @original
    //   defer=P, want=E  → POST ephemeral follow-up + DELETE @original
    //
    // null defer state (TTL eviction, restart, pre-tracker interactions)
    // falls back to {kind:'reply', ephemeral:true} — the dispatcher's
    // default. Matches old behaviour for commands; for components it
    // would force the wrong path, but the component dispatcher now
    // records state in the same tick as deferUpdate so the only path
    // to null-for-a-component is the bot restarting mid-interaction,
    // which is rare.
    const deferState = readPluginDeferState(body.interaction_token) ?? {
      kind: "reply" as const,
      ephemeral: true,
    };
    const extraFlags = sanitizePluginFlags(body.flags);

    try {
      // Components: straight PATCH. ephemeral / flags can't change the
      // parent message's visibility (it's a regular message in a
      // channel, not an interaction reply). SuppressEmbeds /
      // SuppressNotifications still honoured.
      if (deferState.kind === "update") {
        const editFlags = extraFlags || undefined;
        await bot.rest.patch(
          Routes.webhookMessage(
            bot.application.id,
            body.interaction_token,
            "@original",
          ),
          {
            body: {
              content,
              embeds,
              components,
              flags: editFlags,
              allowed_mentions: { parse: [] },
            },
            ...(attachments.length > 0
              ? {
                  files: attachments.map((a) => ({
                    name: a.name,
                    data: a.data,
                  })),
                }
              : {}),
          },
        );
        clearPluginDeferState(body.interaction_token);
        return { ok: true };
      }

      // kind='reply': handle defer/want match vs mismatch.
      const wantsEphemeral =
        body.ephemeral === undefined ? null : body.ephemeral !== false;
      const effectiveEphemeral = wantsEphemeral ?? deferState.ephemeral;
      const mismatch = effectiveEphemeral !== deferState.ephemeral;

      if (!mismatch) {
        // Happy path: PATCH @original. flags is read-only on edit so
        // Ephemeral (set at defer) stays. Discord still honours
        // SuppressEmbeds / SuppressNotifications when included here,
        // which is what the plugin actually wants to set.
        const editFlags = extraFlags || undefined;
        await bot.rest.patch(
          Routes.webhookMessage(
            bot.application.id,
            body.interaction_token,
            "@original",
          ),
          {
            body: {
              content,
              embeds,
              components,
              flags: editFlags,
              allowed_mentions: { parse: [] },
            },
            ...(attachments.length > 0
              ? {
                  files: attachments.map((a) => ({
                    name: a.name,
                    data: a.data,
                  })),
                }
              : {}),
          },
        );
        clearPluginDeferState(body.interaction_token);
        return { ok: true };
      }

      // Mismatch: POST follow-up with the desired ephemerality, then
      // DELETE @original so the user sees a single message of the
      // right kind. follow-up's `flags` field IS honoured (this is a
      // brand-new message, not an edit), so Ephemeral works here.
      const followupFlags =
        (effectiveEphemeral ? MessageFlags.Ephemeral : 0) | extraFlags;
      await bot.rest.post(
        Routes.webhook(bot.application.id, body.interaction_token),
        {
          body: {
            content,
            embeds,
            components,
            flags: followupFlags || undefined,
            allowed_mentions: { parse: [] },
          },
          ...(attachments.length > 0
            ? {
                files: attachments.map((a) => ({
                  name: a.name,
                  data: a.data,
                })),
              }
            : {}),
        },
      );
      // Best-effort delete — failure (5xx, race with token expiry) just
      // leaves a stale "thinking…" placeholder until Discord times it
      // out. The actual reply already landed.
      await bot.rest
        .delete(
          Routes.webhookMessage(
            bot.application.id,
            body.interaction_token,
            "@original",
          ),
        )
        .catch(() => {});
      clearPluginDeferState(body.interaction_token);
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(400).send({ error: `respond failed: ${m}` });
    }
  });

  // ─── interactions.followup ────────────────────────────────────────
  /**
   * POST /api/plugin/interactions.followup
   * Body: { interaction_token, content?, embeds?, ephemeral? }
   *
   * Append a follow-up message to an existing interaction. Plugins
   * use this for streaming output / multi-message replies. Discord
   * caps at 5 follow-ups per interaction.
   */
  server.post<{
    Body: {
      interaction_token?: unknown;
      content?: unknown;
      embeds?: unknown;
      components?: unknown;
      ephemeral?: unknown;
      flags?: unknown;
      attachments?: unknown;
    };
  }>("/api/plugin/interactions.followup", async (request, reply) => {
    const ctx = await requireScope(request, reply, "interactions.followup");
    if (!ctx) return;
    if (!bot || !bot.application) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (
      typeof body.interaction_token !== "string" ||
      body.interaction_token.length === 0
    ) {
      reply.code(400).send({ error: "interaction_token required" });
      return;
    }
    const content = typeof body.content === "string" ? body.content : undefined;
    const embeds = Array.isArray(body.embeds) ? body.embeds : undefined;
    const components = Array.isArray(body.components)
      ? body.components
      : undefined;
    if (!content && !embeds && !components) {
      reply.code(400).send({ error: "content, embeds or components required" });
      return;
    }
    if (components) {
      const failure = findUnownedCustomId(ctx.pluginKey, components);
      if (failure) {
        reply.code(400).send({
          error: describeOwnershipFailure(ctx.pluginKey, failure),
        });
        return;
      }
    }
    let attachments: Array<{ name: string; data: Buffer }>;
    try {
      attachments = await resolvePluginAttachments(
        ctx.pluginId,
        body.attachments,
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(400).send({ error: `attachment error: ${m}` });
      return;
    }
    const ephemeral = body.ephemeral === true;
    const followupExtraFlags = sanitizePluginFlags(body.flags);
    const followupFlags =
      (ephemeral ? MessageFlags.Ephemeral : 0) | followupExtraFlags;
    try {
      const created = (await bot.rest.post(
        Routes.webhook(bot.application.id, body.interaction_token),
        {
          body: {
            content,
            embeds,
            components,
            flags: followupFlags || undefined,
            allowed_mentions: { parse: [] },
          },
          ...(attachments.length > 0
            ? {
                files: attachments.map((a) => ({
                  name: a.name,
                  data: a.data,
                })),
              }
            : {}),
        },
      )) as { id?: string };
      return { ok: true, id: created.id ?? null };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(400).send({ error: `followup failed: ${m}` });
    }
  });

  // ─── interactions.delete_followup ─────────────────────────────────
  /**
   * POST /api/plugin/interactions.delete_followup
   * Body: { interaction_token, message_id }
   *
   * Delete a follow-up message (ephemeral or not) the plugin posted
   * via interactions.followup. `messages.delete` doesn't work for
   * ephemeral followups because they aren't fetchable through the
   * normal channel.messages API — Discord routes their lifecycle
   * through the interaction's webhook instead. Plugins use this to
   * auto-dismiss short-lived toast nudges (e.g. "已記錄你的投票").
   *
   * Within Discord's 15-minute interaction-token window. After that
   * the followup is unreachable and a delete returns 404.
   */
  server.post<{
    Body: {
      interaction_token?: unknown;
      message_id?: unknown;
    };
  }>("/api/plugin/interactions.delete_followup", async (request, reply) => {
    const ctx = await requireScope(
      request,
      reply,
      "interactions.delete_followup",
    );
    if (!ctx) return;
    if (!bot || !bot.application) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (
      typeof body.interaction_token !== "string" ||
      body.interaction_token.length === 0
    ) {
      reply.code(400).send({ error: "interaction_token required" });
      return;
    }
    if (
      typeof body.message_id !== "string" ||
      body.message_id.length === 0
    ) {
      reply.code(400).send({ error: "message_id required" });
      return;
    }
    try {
      await bot.rest.delete(
        Routes.webhookMessage(
          bot.application.id,
          body.interaction_token,
          body.message_id,
        ),
      );
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(400).send({ error: `delete followup failed: ${m}` });
    }
  });

  // ─── interactions.edit_followup ───────────────────────────────────
  /**
   * POST /api/plugin/interactions.edit_followup
   * Body: { interaction_token, message_id, content?, embeds?,
   *         components?, allowed_mentions? }
   *
   * PATCH an earlier followup message the plugin posted via
   * `interactions.followup`. Useful for progress indicators or
   * editable status messages — avoids the delete + re-post flicker.
   * Within Discord's 15-minute interaction-token window; after that
   * the followup is unreachable and the patch 404s.
   */
  server.post<{
    Body: {
      interaction_token?: unknown;
      message_id?: unknown;
      content?: unknown;
      embeds?: unknown;
      components?: unknown;
      allowed_mentions?: unknown;
    };
  }>("/api/plugin/interactions.edit_followup", async (request, reply) => {
    const ctx = await requireScope(
      request,
      reply,
      "interactions.edit_followup",
    );
    if (!ctx) return;
    if (!bot || !bot.application) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (
      typeof body.interaction_token !== "string" ||
      body.interaction_token.length === 0
    ) {
      reply.code(400).send({ error: "interaction_token required" });
      return;
    }
    if (
      typeof body.message_id !== "string" ||
      body.message_id.length === 0
    ) {
      reply.code(400).send({ error: "message_id required" });
      return;
    }
    const content =
      typeof body.content === "string" ? body.content : undefined;
    const embeds = Array.isArray(body.embeds) ? body.embeds : undefined;
    const components = Array.isArray(body.components)
      ? body.components
      : undefined;
    if (components) {
      const failure = findUnownedCustomId(ctx.pluginKey, components);
      if (failure) {
        reply.code(400).send({
          error: describeOwnershipFailure(ctx.pluginKey, failure),
        });
        return;
      }
    }
    // safeAllowedMentions always returns a non-null object — `{parse:[]}`
    // when the caller passed nothing or something invalid. So this is
    // unconditional rather than the dead ternary the first draft had.
    const allowedMentions = safeAllowedMentions(body.allowed_mentions);
    try {
      await bot.rest.patch(
        Routes.webhookMessage(
          bot.application.id,
          body.interaction_token,
          body.message_id,
        ),
        {
          body: {
            ...(content !== undefined ? { content } : {}),
            ...(embeds !== undefined ? { embeds } : {}),
            ...(components !== undefined ? { components } : {}),
            allowed_mentions: allowedMentions,
          },
        },
      );
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(400).send({ error: `edit followup failed: ${m}` });
    }
  });

  // ─── interactions.send_modal ──────────────────────────────────────
  /**
   * POST /api/plugin/interactions.send_modal
   * Body: { interaction_id, interaction_token, modal }
   *
   * Open a Discord modal as the initial response to a plugin command.
   * The command's manifest entry MUST declare `modal: true` so the bot
   * skips its own `deferReply` (Discord rejects modals after an ack of
   * any kind). Must be called within Discord's 3 s window from the
   * command dispatch — otherwise the interaction expires and the user
   * sees "interaction failed".
   *
   * `modal` is a discord-api-types `APIModalInteractionResponseCallbackData`
   * shape: `{ custom_id, title, components: [{ type: 1, components:
   * [{ type: 4, custom_id, label, style, ... }] }] }`. We forward it
   * to Discord verbatim — Discord rejects malformed shapes with a
   * helpful error message.
   *
   * `application_id` is taken from the dispatch payload too, but the
   * bot also has `bot.application.id` available; using the bot's own
   * value is the safe path (a plugin can't spoof another bot's id).
   */
  server.post<{
    Body: {
      interaction_id?: unknown;
      interaction_token?: unknown;
      modal?: unknown;
    };
  }>("/api/plugin/interactions.send_modal", async (request, reply) => {
    const ctx = await requireScope(request, reply, "interactions.send_modal");
    if (!ctx) return;
    if (!bot || !bot.application) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (
      typeof body.interaction_id !== "string" ||
      body.interaction_id.length === 0
    ) {
      reply.code(400).send({ error: "interaction_id required" });
      return;
    }
    if (
      typeof body.interaction_token !== "string" ||
      body.interaction_token.length === 0
    ) {
      reply.code(400).send({ error: "interaction_token required" });
      return;
    }
    if (!body.modal || typeof body.modal !== "object") {
      reply.code(400).send({ error: "modal required" });
      return;
    }
    {
      const failure = findUnownedModalCustomId(ctx.pluginKey, body.modal);
      if (failure) {
        // describeOwnershipFailure says "component custom_id …" but for
        // modals we override to "modal custom_id …" — the routing is on
        // the OUTER modal id, plugin authors expect that label.
        const msg =
          failure.kind === "too-deep"
            ? describeOwnershipFailure(ctx.pluginKey, failure)
            : `modal custom_id '${failure.customId}' must use the kc:${ctx.pluginKey}: namespace`;
        reply.code(400).send({ error: msg });
        return;
      }
    }
    try {
      // InteractionResponseType.Modal = 9. Discord's REST endpoint is
      // /interactions/<id>/<token>/callback. Bypass discord.js's
      // interaction.showModal because the original Interaction object
      // doesn't exist here — we only have the id+token forwarded by
      // the plugin.
      await bot.rest.post(
        Routes.interactionCallback(body.interaction_id, body.interaction_token),
        { body: { type: 9, data: body.modal } },
      );
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(400).send({ error: `send_modal failed: ${m}` });
    }
  });

  // ─── auth.session ─────────────────────────────────────────────────
  /**
   * POST /api/plugin/auth.session
   * Body: { user_id, kind?: 'manage' | 'session', guild_id?, ttl_ms? }
   *
   * Mint a `plugin-session` JWT for a Discord user so the plugin can
   * hand them a WebUI link. The bot is the authority on the user's
   * capabilities — the plugin must trust the bot's verdict:
   *   - kind='manage': requires the user to hold `admin` OR
   *     `plugin:<thisPluginKey>:manage`. Otherwise → { allowed:false }.
   *     Short-lived (default 15 min) — re-mint as needed.
   *   - kind='session': no capability gate (the slash command that
   *     produced the link is itself permission-gated). Default 6 h.
   *     `guild_id` is embedded in the token so the WebUI scopes to that
   *     playback session.
   *
   * The token always carries the user's `admin` + `plugin:*` capability
   * subset so the plugin can do its own offline authorization.
   */
  server.post<{
    Body: {
      user_id?: unknown;
      kind?: unknown;
      guild_id?: unknown;
      ttl_ms?: unknown;
    };
  }>("/api/plugin/auth.session", async (request, reply) => {
    const ctx = await requireScope(request, reply, "auth.session");
    if (!ctx) return;
    const body = request.body ?? {};
    const userId =
      typeof body.user_id === "string" && body.user_id.length > 0
        ? body.user_id
        : null;
    if (!userId) {
      reply.code(400).send({ error: "user_id required" });
      return;
    }
    const kind = body.kind === "manage" ? "manage" : "session";
    const guildId =
      typeof body.guild_id === "string" && body.guild_id.length > 0
        ? body.guild_id
        : null;
    const defaultTtl = kind === "manage" ? 15 * 60_000 : 6 * 60 * 60_000;
    let ttlMs =
      typeof body.ttl_ms === "number" && Number.isFinite(body.ttl_ms)
        ? body.ttl_ms
        : defaultTtl;
    ttlMs = Math.max(60_000, Math.min(ttlMs, 7 * 24 * 60 * 60_000));

    const allCaps = await resolveUserCapabilities(userId);
    const requiredCap = makePluginCapabilityToken(
      ctx.pluginKey,
      "manage",
    );
    const privileged = allCaps.has("admin") || allCaps.has(requiredCap);
    if (kind === "manage" && !privileged) {
      return { allowed: false };
    }
    // Only `manage` tokens carry capabilities (and only `admin` + this
    // plugin's own `plugin:<key>:*` — never another plugin's grants).
    // `session` tokens are authorized purely by the embedded guildId, so
    // they ship NO capabilities — they may end up in a link button the
    // invoker copies/shares, and a leaked token must not confer admin.
    const pluginCaps =
      kind === "manage"
        ? [...allCaps].filter(
            (c) => c === "admin" || c.startsWith(`plugin:${ctx.pluginKey}:`),
          )
        : [];
    const { token, expiresAt } = jwtService.sign(
      { purpose: "plugin-session", userId, guildId, capabilities: pluginCaps },
      { ttlMs },
    );
    return { allowed: true, token, expiresAt };
  });

  // ─── members.get ──────────────────────────────────────────────────
  /**
   * POST /api/plugin/members.get
   * Body: { guild_id: string, user_ids: string[] }
   * Returns: { members: Array<{ userId, displayName, avatarUrl }> }
   *
   * Resolve guild-member display names + avatar URLs for a batch of
   * users — what a plugin WebUI needs to render a player list with the
   * names/faces the guild actually sees (guild nickname + guild/user
   * avatar), which the dispatch payload deliberately doesn't carry.
   *
   * Gated by the same per-guild feature check as messages.send: the
   * plugin may only read members of a guild where it has an enabled
   * feature. Users who have left the guild are simply omitted — the
   * caller keeps whatever name it captured at interaction time.
   */
  server.post<{
    Body: { guild_id?: unknown; user_ids?: unknown };
  }>("/api/plugin/members.get", async (request, reply) => {
    const ctx = await requireScope(request, reply, "members.get");
    if (!ctx) return;
    if (!bot) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (typeof body.guild_id !== "string" || body.guild_id.length === 0) {
      reply.code(400).send({ error: "guild_id required" });
      return;
    }
    const guildId = body.guild_id;
    if (!Array.isArray(body.user_ids)) {
      reply.code(400).send({ error: "user_ids must be an array" });
      return;
    }
    // Snowflake-shaped strings only, de-duplicated. A malformed id
    // can't poison the batch — it's dropped before the fetch.
    const userIds = [
      ...new Set(
        body.user_ids.filter(
          (v): v is string => typeof v === "string" && SNOWFLAKE_RE.test(v),
        ),
      ),
    ];
    if (userIds.length === 0) return { members: [] };
    if (userIds.length > MEMBERS_GET_MAX) {
      reply
        .code(400)
        .send({ error: `at most ${MEMBERS_GET_MAX} user_ids per call` });
      return;
    }
    // Per-guild feature gate — identical to messages.send. The plugin
    // must not be able to enumerate members of a guild it isn't
    // enabled in.
    const enabledFeatures = await findEnabledFeaturesByPluginGuild(
      ctx.pluginId,
      guildId,
    );
    if (enabledFeatures.length === 0) {
      reply.code(403).send({ error: "plugin not enabled in this guild" });
      return;
    }
    let guild;
    try {
      guild = await bot.guilds.fetch(guildId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(404).send({ error: `guild fetch failed: ${msg}` });
      return;
    }
    try {
      const fetched = await guild.members.fetch({ user: userIds });
      const requested = new Set(userIds);
      // Defensive: only ever return the members that were asked for,
      // never anything else the member cache happens to hold.
      const members = [...fetched.values()]
        .filter((m) => requested.has(m.id))
        .map((m) => {
          // Force `.webp` (`forceStatic` stops discord.js swapping to
          // `.gif`, whose CDN endpoint 415s for many assets) and, for
          // an animated avatar, append `&animated=true` so the webp
          // plays — same handling as the karyl-chan frontend.
          const url = m.displayAvatarURL({
            size: 128,
            extension: "webp",
            forceStatic: true,
          });
          const hash = m.avatar ?? m.user.avatar;
          const animated =
            typeof hash === "string" && hash.startsWith("a_");
          return {
            userId: m.id,
            displayName: m.displayName,
            avatarUrl: animated
              ? `${url}${url.includes("?") ? "&" : "?"}animated=true`
              : url,
          };
        });
      return { members };
    } catch (err) {
      // A whole-batch fetch failure (gateway hiccup, every id stale)
      // isn't fatal for the caller — it keeps its interaction-time
      // fallback names. Surface an empty list rather than a 5xx.
      const msg = err instanceof Error ? err.message : String(err);
      request.log.warn({ err: msg, guildId }, "members.get fetch failed");
      return { members: [] };
    }
  });

  // ─── users.get ────────────────────────────────────────────────────
  /**
   * POST /api/plugin/users.get
   * Body: { user_ids: string[] }
   * Returns: { users: Array<{userId, username, globalName, displayName,
   *           avatarUrl, bannerUrl, accentColor, isBot}> }
   *
   * Resolve GLOBAL Discord user profiles for a batch of users — the
   * companion to `members.get` for surfaces with no guild context
   * (DM commands, user-install commands, plugin webuis opened from
   * private channels). Returns the richer User shape (banner + accent
   * + username/globalName) that members.get can't supply because it
   * only returns the per-guild member projection.
   *
   * Permission model: any plugin with the `users.get` scope can call
   * this — there's no per-guild gate possible because there's no
   * guild. The natural permission boundary is the Discord API itself:
   * `bot.users.fetch(id)` 10013s for users the bot can't see (no
   * mutual guild, never DM'd). Users who can't be fetched are
   * omitted from the response; the caller keeps whatever fallback
   * it had.
   *
   * Use `members.get` instead whenever a guild_id is available — it
   * surfaces the per-guild nickname + per-guild avatar override.
   */
  server.post<{ Body: { user_ids?: unknown } }>(
    "/api/plugin/users.get",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "users.get");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body ?? {};
      if (!Array.isArray(body.user_ids)) {
        reply.code(400).send({ error: "user_ids must be an array" });
        return;
      }
      const userIds = [
        ...new Set(
          body.user_ids.filter(
            (v): v is string => typeof v === "string" && SNOWFLAKE_RE.test(v),
          ),
        ),
      ];
      if (userIds.length === 0) return { users: [] };
      // Same batch cap as members.get — keeps a single call from
      // hammering Discord REST with 100 parallel GET /users/:id.
      if (userIds.length > MEMBERS_GET_MAX) {
        reply
          .code(400)
          .send({ error: `at most ${MEMBERS_GET_MAX} user_ids per call` });
        return;
      }
      const out = await Promise.all(
        userIds.map(async (id) => {
          try {
            // `force: true` so the cached projection from a member
            // event (which often lacks `banner` / `accent_color`)
            // doesn't shadow a full REST fetch.
            const user = await bot!.users.fetch(id, { force: true });
            const avatarUrl = user.displayAvatarURL({
              size: 128,
              extension: "webp",
              forceStatic: true,
            });
            const avatarHash = user.avatar;
            const avatarAnimated =
              typeof avatarHash === "string" && avatarHash.startsWith("a_");
            const bannerUrl = user.bannerURL({
              size: 512,
              extension: "webp",
              forceStatic: true,
            });
            const bannerHash = user.banner;
            const bannerAnimated =
              typeof bannerHash === "string" && bannerHash.startsWith("a_");
            return {
              userId: user.id,
              username: user.username,
              globalName: user.globalName ?? null,
              displayName: user.globalName ?? user.username,
              avatarUrl: avatarAnimated
                ? `${avatarUrl}${avatarUrl.includes("?") ? "&" : "?"}animated=true`
                : avatarUrl,
              bannerUrl: bannerUrl
                ? bannerAnimated
                  ? `${bannerUrl}${bannerUrl.includes("?") ? "&" : "?"}animated=true`
                  : bannerUrl
                : null,
              accentColor:
                typeof user.accentColor === "number" ? user.accentColor : null,
              isBot: user.bot,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            request.log.warn(
              { err: msg, userId: id, pluginId: ctx.pluginId },
              "users.get fetch failed for user",
            );
            return null;
          }
        }),
      );
      return { users: out.filter((u): u is NonNullable<typeof u> => u !== null) };
    },
  );

  // ─── channels.get ─────────────────────────────────────────────────
  /**
   * POST /api/plugin/channels.get
   * Body:    { guild_id: string, channel_id: string }
   * Returns: APIChannel (discord-api-types/v10 discriminated union)
   *
   * Fetch a single channel's metadata: type / parent / topic / NSFW
   * / slow_mode / position / permission overwrites. Returns the raw
   * Discord REST shape rather than a mapped subset because callers
   * legitimately want different fields (config UI needs type+name,
   * an audit display wants topic+NSFW, etc.).
   */
  server.post<{ Body: { guild_id?: unknown; channel_id?: unknown } }>(
    "/api/plugin/channels.get",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "channels.get");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body ?? {};
      if (typeof body.guild_id !== "string" || !SNOWFLAKE_RE.test(body.guild_id)) {
        reply.code(400).send({ error: "guild_id required" });
        return;
      }
      if (
        typeof body.channel_id !== "string" ||
        !SNOWFLAKE_RE.test(body.channel_id)
      ) {
        reply.code(400).send({ error: "channel_id required" });
        return;
      }
      const enabledFeatures = await findEnabledFeaturesByPluginGuild(
        ctx.pluginId,
        body.guild_id,
      );
      if (enabledFeatures.length === 0) {
        reply.code(403).send({ error: "plugin not enabled in this guild" });
        return;
      }
      try {
        const channel = (await bot.rest.get(
          Routes.channel(body.channel_id),
        )) as { guild_id?: string };
        if (channel.guild_id !== body.guild_id) {
          reply
            .code(403)
            .send({ error: "channel does not belong to specified guild" });
          return;
        }
        return { channel };
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        reply.code(discordErrorStatus(err)).send({
          error: `channels.get failed: ${m}`,
        });
      }
    },
  );

  // ─── channels.list ────────────────────────────────────────────────
  /**
   * POST /api/plugin/channels.list
   * Body:    { guild_id: string, types?: number[] }
   * Returns: { channels: APIChannel[] }
   *
   * List all channels in a guild, optionally filtered by Discord's
   * numeric `ChannelType` (e.g. [0,5] for GuildText + GuildAnnouncement).
   * Capped at 500 entries as a defensive ceiling; real-world guilds
   * don't exceed this. Discord doesn't paginate channel lists, so
   * there is no cursor parameter.
   */
  server.post<{ Body: { guild_id?: unknown; types?: unknown } }>(
    "/api/plugin/channels.list",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "channels.list");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body ?? {};
      if (typeof body.guild_id !== "string" || !SNOWFLAKE_RE.test(body.guild_id)) {
        reply.code(400).send({ error: "guild_id required" });
        return;
      }
      const enabledFeatures = await findEnabledFeaturesByPluginGuild(
        ctx.pluginId,
        body.guild_id,
      );
      if (enabledFeatures.length === 0) {
        reply.code(403).send({ error: "plugin not enabled in this guild" });
        return;
      }
      const typeFilter =
        Array.isArray(body.types) && body.types.length > 0
          ? new Set(body.types.filter((v): v is number => typeof v === "number"))
          : null;
      try {
        const all = (await bot.rest.get(
          Routes.guildChannels(body.guild_id),
        )) as Array<{ type: number }>;
        let channels = typeFilter
          ? all.filter((c) => typeFilter.has(c.type))
          : all;
        if (channels.length > 500) channels = channels.slice(0, 500);
        return { channels };
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        reply.code(discordErrorStatus(err)).send({
          error: `channels.list failed: ${m}`,
        });
      }
    },
  );

  // ─── roles.list ───────────────────────────────────────────────────
  /**
   * POST /api/plugin/roles.list
   * Body:    { guild_id: string }
   * Returns: { roles: APIRole[] }
   */
  server.post<{ Body: { guild_id?: unknown } }>(
    "/api/plugin/roles.list",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "roles.list");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body ?? {};
      if (typeof body.guild_id !== "string" || !SNOWFLAKE_RE.test(body.guild_id)) {
        reply.code(400).send({ error: "guild_id required" });
        return;
      }
      const enabledFeatures = await findEnabledFeaturesByPluginGuild(
        ctx.pluginId,
        body.guild_id,
      );
      if (enabledFeatures.length === 0) {
        reply.code(403).send({ error: "plugin not enabled in this guild" });
        return;
      }
      try {
        const roles = await bot.rest.get(Routes.guildRoles(body.guild_id));
        return { roles };
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        reply.code(discordErrorStatus(err)).send({
          error: `roles.list failed: ${m}`,
        });
      }
    },
  );

  // ─── roles.get ────────────────────────────────────────────────────
  /**
   * POST /api/plugin/roles.get
   * Body:    { guild_id: string, role_id: string }
   * Returns: { role: APIRole }
   *
   * Discord has no single-role endpoint — under the hood this fetches
   * the full role list (cached by the bot) and picks the entry.
   */
  server.post<{ Body: { guild_id?: unknown; role_id?: unknown } }>(
    "/api/plugin/roles.get",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "roles.get");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body ?? {};
      if (typeof body.guild_id !== "string" || !SNOWFLAKE_RE.test(body.guild_id)) {
        reply.code(400).send({ error: "guild_id required" });
        return;
      }
      if (typeof body.role_id !== "string" || !SNOWFLAKE_RE.test(body.role_id)) {
        reply.code(400).send({ error: "role_id required" });
        return;
      }
      const enabledFeatures = await findEnabledFeaturesByPluginGuild(
        ctx.pluginId,
        body.guild_id,
      );
      if (enabledFeatures.length === 0) {
        reply.code(403).send({ error: "plugin not enabled in this guild" });
        return;
      }
      try {
        const roles = (await bot.rest.get(
          Routes.guildRoles(body.guild_id),
        )) as Array<{ id: string }>;
        const role = roles.find((r) => r.id === body.role_id);
        if (!role) {
          reply.code(404).send({ error: "role not found in this guild" });
          return;
        }
        return { role };
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        reply.code(discordErrorStatus(err)).send({
          error: `roles.get failed: ${m}`,
        });
      }
    },
  );

  // ─── members.add_role ─────────────────────────────────────────────
  /**
   * POST /api/plugin/members.add_role
   * Body:    { guild_id, user_id, role_id }
   * Returns: { ok: true }
   *
   * Bot needs `MANAGE_ROLES` AND must hold a role positioned above
   * the target role. Discord returns code 50013 in both cases —
   * indistinguishable from the error alone. We surface the raw
   * Discord message via discordErrorStatus(err) so the plugin author
   * sees the actionable hint ("Missing Permissions").
   */
  server.post<{
    Body: { guild_id?: unknown; user_id?: unknown; role_id?: unknown };
  }>("/api/plugin/members.add_role", async (request, reply) => {
    const ctx = await requireScope(request, reply, "members.add_role");
    if (!ctx) return;
    if (!bot) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (typeof body.guild_id !== "string" || !SNOWFLAKE_RE.test(body.guild_id)) {
      reply.code(400).send({ error: "guild_id required" });
      return;
    }
    if (typeof body.user_id !== "string" || !SNOWFLAKE_RE.test(body.user_id)) {
      reply.code(400).send({ error: "user_id required" });
      return;
    }
    if (typeof body.role_id !== "string" || !SNOWFLAKE_RE.test(body.role_id)) {
      reply.code(400).send({ error: "role_id required" });
      return;
    }
    const enabledFeatures = await findEnabledFeaturesByPluginGuild(
      ctx.pluginId,
      body.guild_id,
    );
    if (enabledFeatures.length === 0) {
      reply.code(403).send({ error: "plugin not enabled in this guild" });
      return;
    }
    try {
      await bot.rest.put(
        Routes.guildMemberRole(body.guild_id, body.user_id, body.role_id),
      );
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(discordErrorStatus(err)).send({
        error: `add_role failed: ${m}`,
      });
    }
  });

  // ─── members.remove_role ──────────────────────────────────────────
  server.post<{
    Body: { guild_id?: unknown; user_id?: unknown; role_id?: unknown };
  }>("/api/plugin/members.remove_role", async (request, reply) => {
    const ctx = await requireScope(request, reply, "members.remove_role");
    if (!ctx) return;
    if (!bot) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (typeof body.guild_id !== "string" || !SNOWFLAKE_RE.test(body.guild_id)) {
      reply.code(400).send({ error: "guild_id required" });
      return;
    }
    if (typeof body.user_id !== "string" || !SNOWFLAKE_RE.test(body.user_id)) {
      reply.code(400).send({ error: "user_id required" });
      return;
    }
    if (typeof body.role_id !== "string" || !SNOWFLAKE_RE.test(body.role_id)) {
      reply.code(400).send({ error: "role_id required" });
      return;
    }
    const enabledFeatures = await findEnabledFeaturesByPluginGuild(
      ctx.pluginId,
      body.guild_id,
    );
    if (enabledFeatures.length === 0) {
      reply.code(403).send({ error: "plugin not enabled in this guild" });
      return;
    }
    try {
      await bot.rest.delete(
        Routes.guildMemberRole(body.guild_id, body.user_id, body.role_id),
      );
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(discordErrorStatus(err)).send({
        error: `remove_role failed: ${m}`,
      });
    }
  });

  // ─── messages.get ─────────────────────────────────────────────────
  /**
   * POST /api/plugin/messages.get
   * Body:    { guild_id, channel_id, message_id }
   * Returns: { message: APIMessage }
   *
   * guild_id is required for the per-guild feature gate (a plugin
   * can't read a message in a guild it isn't enabled in). We also
   * verify the channel actually belongs to that guild via
   * `assertChannelInGuild` — Discord's `/channels/:id/messages/:id`
   * route doesn't validate cross-guild itself, so without this a
   * plugin could pass `guild_id` of a guild it owns and `channel_id`
   * of a channel in a different guild and read across the boundary.
   */
  server.post<{
    Body: { guild_id?: unknown; channel_id?: unknown; message_id?: unknown };
  }>("/api/plugin/messages.get", async (request, reply) => {
    const ctx = await requireScope(request, reply, "messages.get");
    if (!ctx) return;
    if (!bot) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (typeof body.guild_id !== "string" || !SNOWFLAKE_RE.test(body.guild_id)) {
      reply.code(400).send({ error: "guild_id required" });
      return;
    }
    if (
      typeof body.channel_id !== "string" ||
      !SNOWFLAKE_RE.test(body.channel_id)
    ) {
      reply.code(400).send({ error: "channel_id required" });
      return;
    }
    if (
      typeof body.message_id !== "string" ||
      !SNOWFLAKE_RE.test(body.message_id)
    ) {
      reply.code(400).send({ error: "message_id required" });
      return;
    }
    const enabledFeatures = await findEnabledFeaturesByPluginGuild(
      ctx.pluginId,
      body.guild_id,
    );
    if (enabledFeatures.length === 0) {
      reply.code(403).send({ error: "plugin not enabled in this guild" });
      return;
    }
    if (!(await assertChannelInGuild(bot, body.channel_id, body.guild_id))) {
      reply
        .code(403)
        .send({ error: "channel does not belong to specified guild" });
      return;
    }
    try {
      const message = await bot.rest.get(
        Routes.channelMessage(body.channel_id, body.message_id),
      );
      return { message };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(discordErrorStatus(err)).send({
        error: `messages.get failed: ${m}`,
      });
    }
  });

  // ─── messages.fetch_history ──────────────────────────────────────
  /**
   * POST /api/plugin/messages.fetch_history
   * Body:    { guild_id, channel_id, limit?, before?, after?, around? }
   * Returns: { messages: APIMessage[] }
   *
   * Discord caps each call at 100 messages. We expose the cursor
   * pattern directly — pass `before: <oldest_id_from_previous_page>`
   * to walk further back. No silent multi-page fetching; that would
   * silently consume the plugin's REST rate-limit budget.
   */
  server.post<{
    Body: {
      guild_id?: unknown;
      channel_id?: unknown;
      limit?: unknown;
      before?: unknown;
      after?: unknown;
      around?: unknown;
    };
  }>("/api/plugin/messages.fetch_history", async (request, reply) => {
    const ctx = await requireScope(request, reply, "messages.fetch_history");
    if (!ctx) return;
    if (!bot) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (typeof body.guild_id !== "string" || !SNOWFLAKE_RE.test(body.guild_id)) {
      reply.code(400).send({ error: "guild_id required" });
      return;
    }
    if (
      typeof body.channel_id !== "string" ||
      !SNOWFLAKE_RE.test(body.channel_id)
    ) {
      reply.code(400).send({ error: "channel_id required" });
      return;
    }
    const enabledFeatures = await findEnabledFeaturesByPluginGuild(
      ctx.pluginId,
      body.guild_id,
    );
    if (enabledFeatures.length === 0) {
      reply.code(403).send({ error: "plugin not enabled in this guild" });
      return;
    }
    if (!(await assertChannelInGuild(bot, body.channel_id, body.guild_id))) {
      reply
        .code(403)
        .send({ error: "channel does not belong to specified guild" });
      return;
    }
    const limit =
      typeof body.limit === "number" && Number.isInteger(body.limit)
        ? Math.max(1, Math.min(100, body.limit))
        : 50;
    const query = new URLSearchParams({ limit: String(limit) });
    if (typeof body.before === "string" && SNOWFLAKE_RE.test(body.before)) {
      query.set("before", body.before);
    }
    if (typeof body.after === "string" && SNOWFLAKE_RE.test(body.after)) {
      query.set("after", body.after);
    }
    if (typeof body.around === "string" && SNOWFLAKE_RE.test(body.around)) {
      query.set("around", body.around);
    }
    try {
      // Pass `query` as an option rather than concatenating into the
      // URL: @discordjs/rest derives the rate-limit bucket from the
      // raw route string, which would otherwise fragment buckets per
      // unique query combination and break 429 handling.
      const messages = await bot.rest.get(
        Routes.channelMessages(body.channel_id),
        { query },
      );
      return { messages };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(discordErrorStatus(err)).send({
        error: `messages.fetch_history failed: ${m}`,
      });
    }
  });

  // ─── messages.remove_reaction ────────────────────────────────────
  /**
   * POST /api/plugin/messages.remove_reaction
   * Body:    { guild_id, channel_id, message_id, emoji, user_id? }
   * Returns: { ok: true }
   *
   * Removes the bot's own reaction when `user_id` is omitted; removes
   * a specific user's reaction otherwise. `emoji` follows Discord's
   * URL format — Unicode emoji as the character itself, custom emoji
   * as `name:id`.
   */
  server.post<{
    Body: {
      guild_id?: unknown;
      channel_id?: unknown;
      message_id?: unknown;
      emoji?: unknown;
      user_id?: unknown;
    };
  }>("/api/plugin/messages.remove_reaction", async (request, reply) => {
    const ctx = await requireScope(request, reply, "messages.remove_reaction");
    if (!ctx) return;
    if (!bot) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body ?? {};
    if (typeof body.guild_id !== "string" || !SNOWFLAKE_RE.test(body.guild_id)) {
      reply.code(400).send({ error: "guild_id required" });
      return;
    }
    if (
      typeof body.channel_id !== "string" ||
      !SNOWFLAKE_RE.test(body.channel_id)
    ) {
      reply.code(400).send({ error: "channel_id required" });
      return;
    }
    if (
      typeof body.message_id !== "string" ||
      !SNOWFLAKE_RE.test(body.message_id)
    ) {
      reply.code(400).send({ error: "message_id required" });
      return;
    }
    if (typeof body.emoji !== "string" || body.emoji.length === 0) {
      reply.code(400).send({ error: "emoji required" });
      return;
    }
    const userId =
      typeof body.user_id === "string" && SNOWFLAKE_RE.test(body.user_id)
        ? body.user_id
        : null;
    const enabledFeatures = await findEnabledFeaturesByPluginGuild(
      ctx.pluginId,
      body.guild_id,
    );
    if (enabledFeatures.length === 0) {
      reply.code(403).send({ error: "plugin not enabled in this guild" });
      return;
    }
    if (!(await assertChannelInGuild(bot, body.channel_id, body.guild_id))) {
      reply
        .code(403)
        .send({ error: "channel does not belong to specified guild" });
      return;
    }
    try {
      // Discord's reaction endpoint requires the literal `:` for
      // custom emoji (`name:id`). Plain encodeURIComponent percent-
      // encodes the colon, which Discord then rejects as Unknown
      // Emoji (10014). Encode everything else but restore the colon.
      const encoded = encodeURIComponent(body.emoji).replace(/%3A/gi, ":");
      const route = userId
        ? Routes.channelMessageUserReaction(
            body.channel_id,
            body.message_id,
            encoded,
            userId,
          )
        : Routes.channelMessageOwnReaction(
            body.channel_id,
            body.message_id,
            encoded,
          );
      await bot.rest.delete(route);
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      reply.code(discordErrorStatus(err)).send({
        error: `remove_reaction failed: ${m}`,
      });
    }
  });

  // ─── guilds.get ──────────────────────────────────────────────────
  /**
   * POST /api/plugin/guilds.get
   * Body:    { guild_id: string }
   * Returns: { guild: APIGuild }
   */
  server.post<{ Body: { guild_id?: unknown } }>(
    "/api/plugin/guilds.get",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "guilds.get");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body ?? {};
      if (typeof body.guild_id !== "string" || !SNOWFLAKE_RE.test(body.guild_id)) {
        reply.code(400).send({ error: "guild_id required" });
        return;
      }
      const enabledFeatures = await findEnabledFeaturesByPluginGuild(
        ctx.pluginId,
        body.guild_id,
      );
      if (enabledFeatures.length === 0) {
        reply.code(403).send({ error: "plugin not enabled in this guild" });
        return;
      }
      try {
        const guild = await bot.rest.get(Routes.guild(body.guild_id));
        return { guild };
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        reply.code(discordErrorStatus(err)).send({
          error: `guilds.get failed: ${m}`,
        });
      }
    },
  );

  // ─── me.enabled_guilds ───────────────────────────────────────────
  /**
   * GET /api/plugin/me/enabled_guilds
   * Returns: { guild_ids: string[] }
   *
   * Guild ids where this plugin has at least one *effectively enabled*
   * feature. Effective = per-guild row precedence:
   *   row.enabled (if a row exists) → operator default override →
   *   manifest's enabled_by_default → false.
   *
   * Iterating only the rows would miss guilds that are following an
   * enabled-by-default feature with no row written yet — background
   * workers (e.g. radio's heartbeat loop) need those guilds too.
   * Walks bot.guilds.cache once so the result reflects only guilds the
   * bot is currently in.
   */
  server.get(
    "/api/plugin/me/enabled_guilds",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "me.enabled_guilds");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const plugin = await findPluginById(ctx.pluginId);
      const manifest = plugin ? getManifest(plugin.manifestJson) : null;
      const manifestFeatures = manifest?.guild_features ?? [];
      if (manifestFeatures.length === 0) {
        return { guild_ids: [] };
      }
      const [rows, defaults] = await Promise.all([
        findFeatureRowsByPlugin(ctx.pluginId),
        findFeatureDefaultsByPlugin(ctx.pluginId),
      ]);
      const operatorDefaultByKey = new Map(
        defaults.map((d) => [d.featureKey, d.enabled]),
      );
      const manifestDefaultByKey = new Map(
        manifestFeatures.map((f) => [f.key, !!f.enabled_by_default]),
      );
      const rowsByGuild = new Map<string, Map<string, boolean>>();
      for (const r of rows) {
        let byKey = rowsByGuild.get(r.guildId);
        if (!byKey) {
          byKey = new Map();
          rowsByGuild.set(r.guildId, byKey);
        }
        byKey.set(r.featureKey, r.enabled);
      }
      const enabledGuilds: string[] = [];
      for (const guildId of bot.guilds.cache.keys()) {
        const guildRows = rowsByGuild.get(guildId);
        const anyEnabled = manifestFeatures.some((feature) => {
          const rowVal = guildRows?.get(feature.key);
          if (rowVal !== undefined) return rowVal;
          const opDefault = operatorDefaultByKey.get(feature.key);
          if (opDefault !== undefined) return opDefault;
          return manifestDefaultByKey.get(feature.key) ?? false;
        });
        if (anyEnabled) enabledGuilds.push(guildId);
      }
      return { guild_ids: enabledGuilds };
    },
  );

  // ─── me.kv_usage ─────────────────────────────────────────────────
  /**
   * POST /api/plugin/me/kv_usage
   * Body:    { guild_id: string }
   * Returns: { used_bytes: number, quota_bytes: number }
   *
   * Read the plugin's current KV usage + quota for a given guild
   * without having to issue a sentinel kv_set. Useful for admin UIs
   * showing storage headroom.
   */
  server.post<{ Body: { guild_id?: unknown } }>(
    "/api/plugin/me/kv_usage",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "me.kv_usage");
      if (!ctx) return;
      const body = request.body ?? {};
      if (typeof body.guild_id !== "string" || !SNOWFLAKE_RE.test(body.guild_id)) {
        reply.code(400).send({ error: "guild_id required" });
        return;
      }
      const used = await sumGuildBytes(ctx.pluginId, body.guild_id);
      const quota = await quotaForGuildKv(ctx.pluginId);
      return { used_bytes: used, quota_bytes: quota };
    },
  );

  // ─── log.emit ────────────────────────────────────────────────────
  /**
   * POST /api/plugin/log.emit
   * Body:    { entries: Array<{ level, message, context?, eventKey? }> }
   * Returns: { accepted: number, deduped: number }
   *
   * SDK-side `ctx.botEventLog.emit()` calls land here batched. Each
   * entry is validated, optionally deduped via `shouldRecord`, and
   * forwarded to the bot's `botEventLog` under category `"plugin"`
   * with the plugin's key tagged on the context. Used for the admin
   * UI event timeline.
   */
  server.post<{ Body: { entries?: unknown } }>(
    "/api/plugin/log.emit",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "me.log");
      if (!ctx) return;
      const body = request.body ?? {};
      if (!Array.isArray(body.entries)) {
        reply.code(400).send({ error: "entries array required" });
        return;
      }
      // Defensive cap — a runaway plugin could otherwise drive a 100k
      // entry POST and saturate the bot's event-log write path.
      if (body.entries.length > 100) {
        reply.code(400).send({ error: "max 100 entries per batch" });
        return;
      }
      let accepted = 0;
      let deduped = 0;
      for (const raw of body.entries) {
        if (!raw || typeof raw !== "object") continue;
        const e = raw as Record<string, unknown>;
        const level = e.level;
        if (level !== "info" && level !== "warn" && level !== "error") {
          continue;
        }
        if (typeof e.message !== "string" || e.message.length === 0) continue;
        if (
          e.context !== undefined &&
          (e.context === null ||
            typeof e.context !== "object" ||
            Array.isArray(e.context))
        ) {
          continue;
        }
        if (
          e.eventKey !== undefined &&
          (typeof e.eventKey !== "string" || e.eventKey.length === 0)
        ) {
          continue;
        }
        const ek = typeof e.eventKey === "string" ? e.eventKey : null;
        if (ek) {
          const dedupKey = `plugin-log:${ctx.pluginKey}:${ek}`;
          if (!shouldRecord(dedupKey)) {
            deduped++;
            continue;
          }
        }
        const message = String(e.message).slice(0, 500);
        const context = (e.context as Record<string, unknown> | undefined) ?? {};
        botEventLog.record(level, "plugin", `[${ctx.pluginKey}] ${message}`, {
          ...context,
          pluginId: ctx.pluginId,
          pluginKey: ctx.pluginKey,
        });
        accepted++;
      }
      return { accepted, deduped };
    },
  );

  // ─── metrics.push ────────────────────────────────────────────────
  /**
   * POST /api/plugin/metrics.push
   * Body:    MetricsSnapshot
   * Returns: { ok: true }
   *
   * SDK-side `MetricsCollector` pushes its snapshot here every 30 s and
   * once more on shutdown. We don't store history — the latest snapshot
   * per plugin is held in memory and surfaced to the admin UI via
   * `GET /api/admin/plugins/:id`. Validation is shape-checking only;
   * malformed snapshots are rejected without partial-stored state so
   * the admin UI never renders a half-populated row.
   */
  server.post<{ Body: unknown }>(
    "/api/plugin/metrics.push",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "me.metrics");
      if (!ctx) return;
      const body = request.body;
      if (!body || typeof body !== "object") {
        reply.code(400).send({ error: "snapshot object required" });
        return;
      }
      const snap = body as Record<string, unknown>;
      const ts = typeof snap.ts === "number" ? snap.ts : Date.now();
      const counters = Array.isArray(snap.counters) ? snap.counters : [];
      const gauges = Array.isArray(snap.gauges) ? snap.gauges : [];
      const histograms = Array.isArray(snap.histograms) ? snap.histograms : [];
      // Hard cap on series count per push — protects against a plugin
      // emitting unbounded high-cardinality labels (e.g. one counter
      // per user id).
      if (
        counters.length > 500 ||
        gauges.length > 500 ||
        histograms.length > 200
      ) {
        reply.code(400).send({ error: "metric series cap exceeded" });
        return;
      }
      const { setSnapshot } = await import("./plugin-metrics-store.js");
      await setSnapshot(ctx.pluginKey, {
        ts,
        counters: counters as Array<{
          name: string;
          labels: Record<string, string>;
          value: number;
        }>,
        gauges: gauges as Array<{
          name: string;
          labels: Record<string, string>;
          value: number;
        }>,
        histograms: histograms as Array<{
          name: string;
          labels: Record<string, string>;
          count: number;
          sum: number;
          p50: number;
          p95: number;
          p99: number;
        }>,
      });
      return { ok: true };
    },
  );

  // ─── plugin self-info ─────────────────────────────────────────────
  /**
   * GET /api/plugin/me
   * Returns the plugin's own row from the bot's perspective. Useful
   * for plugins to confirm their effective scopes / id without
   * needing a debug endpoint of their own.
   */
  server.get("/api/plugin/me", async (request, reply) => {
    const auth = request.pluginAuth;
    if (!auth) {
      reply.code(401).send({ error: "plugin auth missing" });
      return;
    }
    const plugin = await findPluginById(auth.pluginId);
    if (!plugin) {
      reply.code(404).send({ error: "plugin row not found" });
      return;
    }
    return {
      id: plugin.id,
      pluginKey: plugin.pluginKey,
      version: plugin.version,
      enabled: plugin.enabled,
      status: plugin.status,
      scopes: Array.from(auth.scopes),
    };
  });
}
