import type { Client } from "discord.js";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifySchemaValidationError,
} from "fastify";
import { config } from "../../config.js";
import { ChannelType, Routes, MessageFlags } from "discord.js";
import { RateLimiter } from "../../utils/rate-limiter.js";
import { findPluginById } from "./models/plugin.model.js";
import { parsePluginManifest } from "./plugin-dispatch-util.js";
import {
  guildKvUsage,
  incrementGuildKv,
  writeGuildKv,
} from "./plugin-kv-accounting.js";
import { mintPluginManageToken } from "./plugin-manage-token.js";
import {
  deleteKv,
  getKv,
  listKvKeys,
  listKvWithValues,
} from "./models/plugin-kv.model.js";
import {
  deleteConfigKey,
  findConfigByPlugin,
  upsertConfigKey,
} from "./models/plugin-config.model.js";
import { decryptSecret } from "../../utils/crypto.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";
import { featureReachResolver } from "../feature-toggle/feature-reach-resolver.js";
import { jwtService } from "../web-core/jwt.service.js";
import { discordErrorStatus } from "../web-core/discord-error.js";
import { assertPluginTarget } from "../../utils/host-policy.js";
import {
  describeOwnershipFailure,
  findUnownedCustomId,
  findUnownedModalCustomId,
} from "./plugin-component-ownership.js";
import {
  clearPluginDeferState,
  planPluginRespond,
} from "./plugin-defer-state.js";
import { maybeForwardGuildRpc } from "./shard-forward-routes.js";
import {
  formatPluginRpcSchemaError,
  installPluginRpcSchemaErrors,
  SNOWFLAKE_PATTERN,
} from "./plugin-rpc-schema.js";

/**
 * Strip dangerous `parse` entries from a plugin-supplied
 * `allowed_mentions` object so a `parse: ["everyone"]` field can't be
 * smuggled into `channel.send`. Only the explicit allowlists (users /
 * roles / repliedUser) survive — a plugin that wants to ping a role
 * must opt in by ID via `roles: ["<id>"]`, not by bulk-parsing every
 * `<@&id>` token in the content. Snowflake-shaped strings only on the
 * id lists (defence in depth against `everyone` smuggled into `roles`).
 */
const SNOWFLAKE_RE = new RegExp(SNOWFLAKE_PATTERN);
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
  // Accept both spellings of the reply-ping opt-out: the wire protocol
  // is snake_case (`replied_user`, matching Discord's own field) but
  // discord.js — and therefore early consumers of this route — uses
  // camelCase. Snake_case wins when both are present.
  if (typeof m.replied_user === "boolean") {
    out.repliedUser = m.replied_user;
  } else if (typeof m.repliedUser === "boolean") {
    out.repliedUser = m.repliedUser;
  }
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

/** Longest KV key a plugin may write. */
const KV_KEY_MAX = 200;

// ─── shared body-schema fragments ───────────────────────────────────
/**
 * Building blocks for the route body schemas. Each one mirrors a guard
 * the handlers used to hand-roll — a check whose failure was already a
 * 400 — so the schema refuses exactly what the `typeof` guard refused,
 * no wider and no narrower.
 */
const snowflakeField = { type: "string", pattern: SNOWFLAKE_PATTERN };
const stringField = { type: "string" };
const nonEmptyStringField = { type: "string", minLength: 1 };
const arrayField = { type: "array" };
const objectField = { type: "object" };
const numberField = { type: "number" };
const integerField = { type: "integer" };
const booleanField = { type: "boolean" };

/**
 * A field the schema names but does not constrain.
 *
 * The schema batches (#48, #53–#55) left every normaliser-shaped field
 * unconstrained so the conversion stayed a pure refactor. #58 then
 * deliberately tightened them: a wrong-typed optional field is now
 * refused with a 400 naming the field, instead of being silently
 * treated as absent.
 *
 * What remains unconstrained after #58 is only the fields whose
 * looseness is a designed contract rather than an accident — each use
 * below cites which one it is preserving (today: `attachments`, whose
 * whole descriptor shape is owned by `resolvePluginAttachments`, which
 * already 400s on anything malformed).
 */
const unconstrainedField = {};

/**
 * Route-level schema error formatter that byte-preserves specific
 * historical refusal texts, delegating everything else to the family
 * formatter.
 *
 * The family formatter's default rendering is fine where a message
 * merely sharpens ("guild_id required" → "guild_id must be string"),
 * which is the #48 precedent. But a few of the storage/me guards carry
 * a message an operator's tooling may match on and ajv's default
 * wording for the same keyword is a plain regression in clarity
 * (`must NOT have more than 200 characters`), so those keep their old
 * text verbatim. Each override matches ajv's first reported error by
 * (instancePath, keyword).
 */
function preservingSchemaErrorFormatter(
  overrides: ReadonlyArray<{
    instancePath: string;
    keyword: string;
    message: string;
  }>,
) {
  return (
    errors: FastifySchemaValidationError[],
    dataVar: string,
  ): Error => {
    const first = errors[0];
    if (first) {
      const hit = overrides.find(
        (o) =>
          o.instancePath === first.instancePath && o.keyword === first.keyword,
      );
      if (hit) return new Error(hit.message);
    }
    return formatPluginRpcSchemaError(errors, dataVar);
  };
}

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
    // Don't follow redirects past the assertPluginTarget host check (SSRF).
    const res = await fetch(`${base}${e.path}`, { redirect: "manual" });
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

/** Fetch a channel for a plugin RPC. `undefined` = the 404 was already sent;
 *  `null` = Discord returned no channel (call sites 400 with their own message). */
async function fetchChannelOr404(
  bot: Client,
  channelId: string,
  reply: FastifyReply,
): Promise<ReturnType<Client["channels"]["fetch"]> extends Promise<infer C> ? C | undefined : never> {
  try {
    return await bot.channels.fetch(channelId);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    reply.code(404).send({ error: `channel fetch failed: ${m}` });
    return undefined;
  }
}

/**
 * PM-8: the ONE reach check every guild-targeted RPC gate goes through.
 * "Effectively enabled" means the full 3-tier chain (per-guild row →
 * operator default → manifest default), cached in FeatureReachResolver;
 * a plugin that declares NO guild features passes unconditionally (its
 * only per-guild surface is the plugin-level enabled flag, enforced at
 * dispatch/auth).
 *
 * Replaces the previous explicit-rows-only reads
 * (`findEnabledFeaturesByPluginGuild`), which 403'd two legitimate
 * cases: guilds following an operator/manifest default ON (commands
 * registered, RPC blocked) and featureless background plugins (e.g.
 * reminder) everywhere.
 */
async function pluginHasGuildReach(
  pluginId: number,
  guildId: string,
): Promise<boolean> {
  const plugin = await findPluginById(pluginId);
  if (!plugin) return false;
  const manifest = parsePluginManifest(plugin);
  if (!manifest) return false;
  return featureReachResolver.hasAnyFeatureEnabledInGuild(
    pluginId,
    guildId,
    manifest,
  );
}

/**
 * Per-guild feature gate shared by every channel-targeted message RPC: the
 * plugin must have at least one effectively-enabled feature in the
 * channel's guild. DM and group-DM channels are exempt (no guildId);
 * threads inherit guildId from their parent and go through the gate,
 * which is the intended behaviour. Writes the 403 and returns false when
 * blocked. `warnVerb` additionally records a deduped warn event
 * (messages.send's historical behavior).
 */
async function passesGuildFeatureGate(
  channel: NonNullable<Awaited<ReturnType<Client["channels"]["fetch"]>>>,
  ctx: { pluginId: number; pluginKey: string },
  reply: FastifyReply,
  opts: { warnVerb?: string } = {},
): Promise<boolean> {
  const channelGuildId =
    "guildId" in channel && typeof channel.guildId === "string" ? channel.guildId : null;
  if (!channelGuildId || channel.isDMBased()) return true;
  if (await pluginHasGuildReach(ctx.pluginId, channelGuildId)) return true;
  if (opts.warnVerb && shouldRecord(`plugin-rpc-feature-block:${ctx.pluginId}:${channelGuildId}`)) {
    botEventLog.record(
      "warn",
      "feature",
      `plugin ${ctx.pluginKey} tried to ${opts.warnVerb} to guild ${channelGuildId} without enabled feature`,
      { pluginId: ctx.pluginId, guildId: channelGuildId },
    );
  }
  reply.code(403).send({ error: "plugin not enabled in this guild" });
  return false;
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

/**
 * Mount the plugin RPC family inside its own Fastify scope.
 *
 * The scope exists so `installPluginRpcSchemaErrors` — the schema error
 * formatter and the error handler that renders it in this family's
 * historical `{ error }` body — applies to these routes and nothing
 * else. The admin route family, registered on the parent instance,
 * keeps Fastify's defaults untouched.
 */
export async function registerPluginRpcRoutes(
  server: FastifyInstance,
  options: PluginRpcOptions,
): Promise<void> {
  await server.register(async (rpc) => {
    installPluginRpcSchemaErrors(rpc);
    registerRpcRoutes(rpc, options);
  });
}

function registerRpcRoutes(
  server: FastifyInstance,
  options: PluginRpcOptions,
): void {
  const bot = options.bot;
  const dmLimiter = options.dmLimiter ?? defaultDmLimiter;

  // ─── messages.send ────────────────────────────────────────────────
  /**
   * POST /api/plugin/messages.send
   * Body: { channel_id: string, content?: string, embeds?: APIEmbed[],
   *         allowed_mentions?: { parse?: ('users'|'roles'|'everyone')[] },
   *         reply_to?: string }
   * Returns: { id, channel_id }
   *
   * `reply_to` (optional message id) sends the message as a native
   * Discord reply to that message. `failIfNotExists: false` so a
   * since-deleted target degrades to a plain send instead of erroring
   * — deliberate: delayed replies (the main reply_to consumer) may
   * outlive their anchor. Reply ping defaults: a reply with NO
   * allowed_mentions in the request pings its author (like a human
   * reply); a request that provides allowed_mentions keeps raw
   * Discord semantics — `replied_user` (or camelCase `repliedUser`)
   * boolean is honored, absent means no ping.
   *
   * The plugin can target any text channel the bot has access to in
   * any guild it's in, plus DM channels of any user. A future revision
   * may narrow this to the plugin's own guild_features scope; today
   * we trust operator-installed plugins to behave.
   */
  server.post<{
    Body: {
      channel_id: string;
      content?: string;
      embeds?: unknown[];
      components?: unknown[];
      allowed_mentions?: Record<string, unknown>;
      attachments?: unknown;
      reply_to?: string;
    };
  }>(
    "/api/plugin/messages.send",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            channel_id: nonEmptyStringField,
            reply_to: snowflakeField,
            // Tightened by #58: these were normalise-and-continue (a
            // wrong type silently meant absent); a wrong type is now a
            // 400 naming the field. safeAllowedMentions still sanitises
            // the *inside* of allowed_mentions (parse-stripping).
            content: stringField,
            embeds: arrayField,
            components: arrayField,
            allowed_mentions: objectField,
            // resolvePluginAttachments owns the whole descriptor shape,
            // including the array check, and is shared with the
            // interactions family; repeating it here would only change
            // the message it produces.
            attachments: unconstrainedField,
          },
          required: ["channel_id"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "messages.send");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body;
      const content = body.content;
      const embeds = body.embeds;
      const components = body.components;
      // Either-or guard stays in the handler: it reads emptiness
      // (`content: ""` counts as absent), which a per-field type cannot
      // express.
      if (!content && !embeds) {
        reply.code(400).send({ error: "content or embeds required" });
        return;
      }
      const replyTo = body.reply_to;
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
      const channel = await fetchChannelOr404(bot, body.channel_id, reply);
      if (channel === undefined) return;
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        reply.code(400).send({ error: "channel is not text-sendable" });
        return;
      }
      if (!(await passesGuildFeatureGate(channel, ctx, reply, { warnVerb: "send" }))) return;
      // Sanitize allowed_mentions — plugins must not be able to force
      // mass-ping behaviour. We strip `parse` entirely (the field that
      // toggles broad @everyone / @here / "every role mention in
      // content" parsing) and only forward the explicit `users` /
      // `roles` / `repliedUser` allowlists. A plugin wanting to ping
      // role X must list `<@&X>` in the content AND `roles: ["X"]`
      // explicitly — no bulk opt-in.
      const allowedMentions = safeAllowedMentions(body.allowed_mentions);
      // Reply-ping rule (three-way, matching raw Discord semantics for
      // anyone who crafted allowed_mentions themselves):
      //   - no allowed_mentions in the request → replies ping their
      //     author by default, like a human reply (we always attach an
      //     allowed_mentions object for the parse-stripping above, and
      //     with one present Discord would default replied_user to
      //     false — so we set it true here);
      //   - allowed_mentions provided WITH replied_user/repliedUser
      //     boolean → honored verbatim;
      //   - allowed_mentions provided WITHOUT it → Discord's own
      //     default (no ping): a plugin that wrote an explicit mention
      //     allowlist (even an empty one) said exactly who to ping.
      const pluginProvidedMentions = body.allowed_mentions !== undefined;
      if (
        replyTo &&
        !pluginProvidedMentions &&
        allowedMentions.repliedUser === undefined
      ) {
        allowedMentions.repliedUser = true;
      }
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
          ...(replyTo
            ? { reply: { messageReference: replyTo, failIfNotExists: false } }
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
    },
  );

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
      user_id: string;
      content?: string;
      embeds?: unknown[];
      allowed_mentions?: Record<string, unknown>;
    };
  }>(
    "/api/plugin/messages.send_dm",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            user_id: nonEmptyStringField,
            // Tightened by #58 — wrong type is a 400 naming the field,
            // no longer silently treated as absent.
            content: stringField,
            embeds: arrayField,
            allowed_mentions: objectField,
          },
          required: ["user_id"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "messages.send_dm");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body;
      const content = body.content;
      const embeds = body.embeds;
      // Either-or emptiness guard stays in the handler; see messages.send.
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
    },
  );

  // ─── messages.delete ──────────────────────────────────────────────
  server.post<{
    Body: { channel_id: string; message_id: string };
  }>(
    "/api/plugin/messages.delete",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            channel_id: stringField,
            message_id: stringField,
          },
          required: ["channel_id", "message_id"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "messages.delete");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body;
      const channel = await fetchChannelOr404(bot, body.channel_id, reply);
      if (channel === undefined) return;
      if (
        !channel ||
        !channel.isTextBased() ||
        channel.type === ChannelType.GroupDM
      ) {
        reply.code(400).send({ error: "channel not text-based" });
        return;
      }
      // Gate symmetric with messages.send/edit: a plugin enabled in guild A
      // cannot delete messages in guild B even if it knows the ids.
      if (!(await passesGuildFeatureGate(channel, ctx, reply))) return;
      try {
        const msg = await channel.messages.fetch(body.message_id);
        await msg.delete();
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reply.code(discordErrorStatus(err)).send({ error: `delete failed: ${msg}` });
      }
    },
  );

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
      channel_id: string;
      message_id: string;
      content?: string;
      embeds?: unknown[];
      components?: unknown[];
    };
  }>(
    "/api/plugin/messages.edit",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            channel_id: stringField,
            message_id: stringField,
            // Tightened by #58: a wrong-typed field used to leave that
            // field untouched on Discord while the call answered 200 —
            // now it is a 400 naming the field. Presence still decides
            // which fields the edit touches.
            content: stringField,
            embeds: arrayField,
            components: arrayField,
            // `attachments` is deliberately absent: the SDK sends it on
            // edit and this route has always ignored it.
          },
          required: ["channel_id", "message_id"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "messages.edit");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body;
      const channel = await fetchChannelOr404(bot, body.channel_id, reply);
      if (channel === undefined) return;
      if (
        !channel ||
        !channel.isTextBased() ||
        channel.type === ChannelType.GroupDM
      ) {
        reply.code(400).send({ error: "channel not text-based" });
        return;
      }
      if (!(await passesGuildFeatureGate(channel, ctx, reply))) return;
      if (body.components !== undefined) {
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
      if (body.content !== undefined) editPayload.content = body.content;
      if (body.embeds !== undefined) editPayload.embeds = body.embeds;
      if (body.components !== undefined)
        editPayload.components = body.components;
      try {
        const msg = await channel.messages.fetch(body.message_id);
        await msg.edit(editPayload as never);
        return { id: msg.id, channel_id: msg.channelId };
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        reply.code(discordErrorStatus(err)).send({ error: `edit failed: ${m}` });
      }
    },
  );

  // ─── messages.add_reaction ────────────────────────────────────────
  server.post<{
    Body: { channel_id: string; message_id: string; emoji: string };
  }>(
    "/api/plugin/messages.add_reaction",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            channel_id: stringField,
            message_id: stringField,
            emoji: stringField,
          },
          required: ["channel_id", "message_id", "emoji"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "messages.add_reaction");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body;
      const channel = await fetchChannelOr404(bot, body.channel_id, reply);
      if (channel === undefined) return;
      if (!channel || !channel.isTextBased()) {
        reply.code(400).send({ error: "channel not text-based" });
        return;
      }
      if (!(await passesGuildFeatureGate(channel, ctx, reply))) return;
      try {
        const msg = await channel.messages.fetch(body.message_id);
        await msg.react(body.emoji);
        return { ok: true };
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        reply.code(discordErrorStatus(err)).send({ error: `add_reaction failed: ${m}` });
      }
    },
  );

  // ─── messages.trigger_typing ──────────────────────────────────────
  /**
   * POST /api/plugin/messages.trigger_typing
   * Body: { channel_id: string }
   * Returns: { ok: true }
   *
   * Fires Discord's typing indicator in the channel. The indicator
   * auto-expires after ~10 seconds; a plugin that wants to hold it
   * through a longer "typing" period re-calls this on its own cadence
   * (the bot deliberately does NOT loop — one RPC, one trigger, so the
   * audit story stays 1:1 with Discord calls).
   */
  server.post<{
    Body: { channel_id: string };
  }>(
    "/api/plugin/messages.trigger_typing",
    {
      schema: {
        body: {
          type: "object",
          properties: { channel_id: nonEmptyStringField },
          required: ["channel_id"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "messages.trigger_typing");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body;
      const channel = await fetchChannelOr404(bot, body.channel_id, reply);
      if (channel === undefined) return;
      if (!channel || !channel.isTextBased() || !("sendTyping" in channel)) {
        reply.code(400).send({ error: "channel does not support typing" });
        return;
      }
      if (!(await passesGuildFeatureGate(channel, ctx, reply))) return;
      try {
        await channel.sendTyping();
        return { ok: true };
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        reply
          .code(discordErrorStatus(err))
          .send({ error: `trigger_typing failed: ${m}` });
      }
    },
  );

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
    const manifest = parsePluginManifest(plugin);
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
  server.post<{ Body: { key: string; value?: string | null } }>(
    "/api/plugin/config.set",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            key: { type: "string", minLength: 1, maxLength: 200 },
            // `null` deletes — the old guard's explicit union
            // (`value !== null && value !== undefined && typeof value
            // !== "string"` → 400) becomes the schema's type union.
            // Absent stays legal (not in `required`) and also deletes.
            value: { type: ["string", "null"] },
          },
          required: ["key"],
        },
      },
      // Three texts ajv's defaults would regress: the empty-key and
      // over-long-key messages, and the value union (ajv says `value
      // must be string,null`, which leaks the union spelling).
      schemaErrorFormatter: preservingSchemaErrorFormatter([
        { instancePath: "/key", keyword: "minLength", message: "key required" },
        {
          instancePath: "/key",
          keyword: "maxLength",
          message: "key exceeds 200 chars",
        },
        {
          instancePath: "/value",
          keyword: "type",
          message: "value must be string or null",
        },
      ]),
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "config.set");
      if (!ctx) return;
      const body = request.body;
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
    Body: { guild_id: string; key: string };
  }>(
    "/api/plugin/storage.kv_get",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            guild_id: nonEmptyStringField,
            key: nonEmptyStringField,
          },
          required: ["guild_id", "key"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "storage.kv_get");
      if (!ctx) return;
      const body = request.body;
      const row = await getKv(ctx.pluginId, body.guild_id, body.key);
      if (!row) {
        return { found: false, value: null };
      }
      return { found: true, value: row.value, bytes: row.bytes };
    },
  );

  // ─── storage.kv_set ───────────────────────────────────────────────
  server.post<{
    Body: { guild_id: string; key: string; value: string };
  }>(
    "/api/plugin/storage.kv_set",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            guild_id: nonEmptyStringField,
            key: { type: "string", minLength: 1, maxLength: KV_KEY_MAX },
            value: stringField,
          },
          required: ["guild_id", "key", "value"],
        },
      },
      // The old guard folded empty and over-long keys into one message;
      // an over-long key must keep it verbatim (ajv's own maxLength text
      // is "must NOT have more than 200 characters").
      schemaErrorFormatter: preservingSchemaErrorFormatter([
        {
          instancePath: "/key",
          keyword: "maxLength",
          message: `key required (max ${KV_KEY_MAX} chars)`,
        },
        {
          instancePath: "/key",
          keyword: "minLength",
          message: `key required (max ${KV_KEY_MAX} chars)`,
        },
      ]),
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "storage.kv_set");
      if (!ctx) return;
      const body = request.body;
      // Quota accounting — per-row cap, budget projection under the
      // per-(plugin,guild) mutex, write, usage report — lives in
      // Guild-KV Accounting (#56). Both refusals (the hard cap and the
      // quota projection) are 413s with the accounting's message; the
      // route keeps transport only.
      const result = await writeGuildKv(
        ctx.pluginId,
        body.guild_id,
        body.key,
        body.value,
      );
      if (!result.ok) {
        reply.code(413).send({ error: result.error });
        return;
      }
      return result;
    },
  );

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
    Body: { guild_id: string; key: string; delta?: number };
  }>(
    "/api/plugin/storage.kv_increment",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            guild_id: nonEmptyStringField,
            key: { type: "string", minLength: 1, maxLength: KV_KEY_MAX },
            // Tightened by #58: an explicit `delta: null` used to mean
            // "default to 1" — an accident of the old guard reading
            // `body.delta ?? 1` before type-checking. Now only a number
            // (or absence) is accepted.
            delta: numberField,
          },
          required: ["guild_id", "key"],
        },
      },
      // Two texts ajv's defaults would regress: the over-long-key
      // message, and the delta one (historical wording, kept verbatim).
      schemaErrorFormatter: preservingSchemaErrorFormatter([
        {
          instancePath: "/key",
          keyword: "maxLength",
          message: `key exceeds ${KV_KEY_MAX} chars`,
        },
        {
          instancePath: "/delta",
          keyword: "type",
          message: "delta must be a finite number",
        },
      ]),
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "storage.kv_increment");
      if (!ctx) return;
      const body = request.body;
      // NaN / Infinity cannot be spelled in JSON, so `type: "number"`
      // refuses everything the old Number.isFinite check refused.
      // `??` covers only absence now — null is refused by the schema.
      const deltaRaw = body.delta ?? 1;
      try {
        // Increment + usage read-back live in Guild-KV Accounting (#56).
        return await incrementGuildKv(
          ctx.pluginId,
          body.guild_id,
          body.key,
          deltaRaw,
        );
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
    },
  );

  // ─── storage.kv_delete ────────────────────────────────────────────
  server.post<{
    Body: { guild_id: string; key: string };
  }>(
    "/api/plugin/storage.kv_delete",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            // No minLength on either: the old guard was a bare typeof,
            // so empty strings were accepted (and deleted nothing).
            guild_id: stringField,
            key: stringField,
          },
          required: ["guild_id", "key"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "storage.kv_delete");
      if (!ctx) return;
      const body = request.body;
      const removed = await deleteKv(ctx.pluginId, body.guild_id, body.key);
      return { removed };
    },
  );

  // ─── storage.kv_list ──────────────────────────────────────────────
  server.post<{
    Body: {
      guild_id: string;
      prefix?: string;
      limit?: number;
      offset?: number;
    };
  }>(
    "/api/plugin/storage.kv_list",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            // Bare typeof at HEAD — an empty guild_id was accepted.
            guild_id: stringField,
            // Tightened by #58 — a wrong-typed option is a 400 naming
            // the field, no longer silently defaulted.
            prefix: stringField,
            limit: numberField,
            offset: numberField,
          },
          required: ["guild_id"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "storage.kv_list");
      if (!ctx) return;
      const body = request.body;
      const prefix = body.prefix;
      const limit = body.limit ?? 100;
      const offset = body.offset ?? 0;
      const result = await listKvKeys(ctx.pluginId, body.guild_id, {
        prefix,
        limit,
        offset,
      });
      return { keys: result.keys, total: result.total };
    },
  );

  // ─── storage.kv_list_values ───────────────────────────────────────
  /**
   * POST /api/plugin/storage.kv_list_values
   * Body:    { guild_id, prefix?, limit?, offset? }
   * Returns: { entries: { key, value, bytes }[], total }
   *
   * Same predicate as `storage.kv_list` but ships values alongside the
   * keys. Background workers (schedulers, queues, reminder-style
   * plugins) that need to inspect every row's payload were forced
   * into a `kv_list` + N×`kv_get` loop — each plugin re-discovered the
   * round-trip cost the hard way. Counts against the same scope
   * (`storage.kv_list_values` so operators can rate-limit batch reads
   * separately from key-only enumerations).
   */
  server.post<{
    Body: {
      guild_id: string;
      prefix?: string;
      limit?: number;
      offset?: number;
    };
  }>(
    "/api/plugin/storage.kv_list_values",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            // Same shape as storage.kv_list, including the #58 tightening.
            guild_id: stringField,
            prefix: stringField,
            limit: numberField,
            offset: numberField,
          },
          required: ["guild_id"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "storage.kv_list_values");
      if (!ctx) return;
      const body = request.body;
      const prefix = body.prefix;
      const limit = body.limit ?? 100;
      const offset = body.offset ?? 0;
      const result = await listKvWithValues(ctx.pluginId, body.guild_id, {
        prefix,
        limit,
        offset,
      });
      return { entries: result.entries, total: result.total };
    },
  );

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
      interaction_token: string;
      content?: string;
      embeds?: unknown[];
      components?: unknown[];
      ephemeral?: boolean;
      flags?: number;
      attachments?: unknown;
    };
  }>(
    "/api/plugin/interactions.respond",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            interaction_token: nonEmptyStringField,
            // Tightened by #58 — wrong type is a 400 naming the field.
            // The boolean semantics stay in the handler (absent = keep
            // the defer's ephemerality, `false` = post publicly), as
            // does sanitizePluginFlags' allowlist mask over `flags`.
            content: stringField,
            embeds: arrayField,
            components: arrayField,
            ephemeral: booleanField,
            flags: numberField,
            // resolvePluginAttachments owns the whole descriptor shape —
            // see messages.send.
            attachments: unconstrainedField,
          },
          required: ["interaction_token"],
        },
      },
    },
    async (request, reply) => {
    const ctx = await requireScope(request, reply, "interactions.respond");
    if (!ctx) return;
    if (!bot || !bot.application) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body;
    const content = body.content;
    const embeds = body.embeds;
    const components = body.components;
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
    // The defer → respond transition table (which PATCH/POST/DELETE
    // sequence the recorded defer state demands) lives with the state
    // in plugin-defer-state (#56); this handler keeps the transport.
    // State is consumed (cleared) only after Discord accepts the call,
    // so a failed respond can retry against the same state.
    const plan = planPluginRespond(body.interaction_token, body.ephemeral);
    const extraFlags = sanitizePluginFlags(body.flags);

    try {
      if (plan.action === "patch-original") {
        // PATCH @original — component updates and matching-ephemerality
        // replies. flags is read-only on edit so Ephemeral (set at
        // defer) stays; Discord still honours SuppressEmbeds /
        // SuppressNotifications when included here, which is what the
        // plugin actually wants to set.
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

      // Ephemerality mismatch: POST follow-up with the desired
      // ephemerality, then DELETE @original so the user sees a single
      // message of the right kind. follow-up's `flags` field IS
      // honoured (this is a brand-new message, not an edit), so
      // Ephemeral works here.
      const followupFlags =
        (plan.ephemeral ? MessageFlags.Ephemeral : 0) | extraFlags;
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
      interaction_token: string;
      content?: string;
      embeds?: unknown[];
      components?: unknown[];
      ephemeral?: boolean;
      flags?: number;
      attachments?: unknown;
    };
  }>(
    "/api/plugin/interactions.followup",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            interaction_token: nonEmptyStringField,
            // Tightened by #58 — wrong type is a 400 naming the field.
            // `ephemeral === true` (absent/false = public) and
            // sanitizePluginFlags' allowlist mask stay in the handler.
            content: stringField,
            embeds: arrayField,
            components: arrayField,
            ephemeral: booleanField,
            flags: numberField,
            // resolvePluginAttachments owns the whole descriptor shape —
            // see messages.send.
            attachments: unconstrainedField,
          },
          required: ["interaction_token"],
        },
      },
    },
    async (request, reply) => {
    const ctx = await requireScope(request, reply, "interactions.followup");
    if (!ctx) return;
    if (!bot || !bot.application) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body;
    const content = body.content;
    const embeds = body.embeds;
    const components = body.components;
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
      interaction_token: string;
      message_id: string;
    };
  }>(
    "/api/plugin/interactions.delete_followup",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            // No snowflake pattern on message_id: the old guard was a
            // bare non-empty typeof, and followup ids are whatever
            // Discord's webhook API returned — mirror the check, don't
            // upgrade it.
            interaction_token: nonEmptyStringField,
            message_id: nonEmptyStringField,
          },
          required: ["interaction_token", "message_id"],
        },
      },
    },
    async (request, reply) => {
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
    const body = request.body;
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
      interaction_token: string;
      message_id: string;
      content?: string;
      embeds?: unknown[];
      components?: unknown[];
      allowed_mentions?: Record<string, unknown>;
    };
  }>(
    "/api/plugin/interactions.edit_followup",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            interaction_token: nonEmptyStringField,
            message_id: nonEmptyStringField,
            // Tightened by #58 — wrong type is a 400 naming the field.
            // Presence still decides which fields the PATCH touches;
            // safeAllowedMentions still sanitises the inside of
            // allowed_mentions.
            content: stringField,
            embeds: arrayField,
            components: arrayField,
            allowed_mentions: objectField,
          },
          required: ["interaction_token", "message_id"],
        },
      },
    },
    async (request, reply) => {
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
    const body = request.body;
    const content = body.content;
    const embeds = body.embeds;
    const components = body.components;
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
      interaction_id: string;
      interaction_token: string;
      modal: unknown;
    };
  }>(
    "/api/plugin/interactions.send_modal",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            interaction_id: nonEmptyStringField,
            interaction_token: nonEmptyStringField,
            // Tightened by #58: the old guard (`!body.modal || typeof
            // body.modal !== "object"`) let a JS *array* through — an
            // accident of `typeof [] === "object"`, kept accepted by the
            // schema batch. JSON Schema's "object" excludes arrays, so an
            // array modal is now refused like every other wrong type.
            modal: objectField,
          },
          required: ["interaction_id", "interaction_token", "modal"],
        },
      },
      // The guard folded every modal failure mode into one message;
      // keep it.
      schemaErrorFormatter: preservingSchemaErrorFormatter([
        { instancePath: "/modal", keyword: "type", message: "modal required" },
      ]),
    },
    async (request, reply) => {
    const ctx = await requireScope(request, reply, "interactions.send_modal");
    if (!ctx) return;
    if (!bot || !bot.application) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body;
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
      user_id: string;
      kind?: string;
      guild_id?: string;
      ttl_ms?: number;
    };
  }>(
    "/api/plugin/auth.session",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            // Bare non-empty typeof at HEAD — NOT snowflake-checked,
            // so no pattern here.
            user_id: nonEmptyStringField,
            // Tightened by #58 — a wrong-typed value is a 400 naming
            // the field. Deliberately type-only: an unknown *string*
            // kind still means "session" in the handler (value
            // validation would break pre-0.9 callers that pass the
            // then-documented 'webui'), and an empty guild_id still
            // normalises to a null claim.
            kind: stringField,
            guild_id: stringField,
            ttl_ms: numberField,
          },
          required: ["user_id"],
        },
      },
      // The old guard folded missing/wrong-typed/empty user_id into one
      // "user_id required". Missing keeps that text via the family
      // formatter and wrong-typed sharpens to "user_id must be string"
      // (the #48 precedent), but ajv's own minLength wording ("must NOT
      // have fewer than 1 characters") is a plain clarity regression —
      // the empty-string case keeps the old text verbatim.
      schemaErrorFormatter: preservingSchemaErrorFormatter([
        {
          instancePath: "/user_id",
          keyword: "minLength",
          message: "user_id required",
        },
      ]),
    },
    async (request, reply) => {
    const ctx = await requireScope(request, reply, "auth.session");
    if (!ctx) return;
    const body = request.body;
    const userId = body.user_id;
    const kind = body.kind === "manage" ? "manage" : "session";
    const guildId = body.guild_id ? body.guild_id : null;
    const defaultTtl = kind === "manage" ? 15 * 60_000 : 6 * 60 * 60_000;
    // NaN / Infinity cannot be spelled in JSON, so `type: "number"`
    // refuses everything the old Number.isFinite check refused.
    let ttlMs = body.ttl_ms ?? defaultTtl;
    ttlMs = Math.max(60_000, Math.min(ttlMs, 7 * 24 * 60 * 60_000));

    // Manage tokens go through the shared mint helper so the cap check
    // (admin OR plugin:<key>:manage, via hasPluginCapability) and the
    // `admin` + plugin:<key>:* cap filter stay identical to the admin
    // UI's manage-link endpoint — one authorization rule, two call sites.
    if (kind === "manage") {
      return await mintPluginManageToken(ctx.pluginKey, userId, ttlMs);
    }
    // `session` tokens are authorized purely by the embedded guildId, so
    // they ship NO capabilities — they may end up in a link button the
    // invoker copies/shares, and a leaked token must not confer admin.
    // Sign with this plugin's own derived key so the token verifies ONLY
    // against the `sessionVerifyPublicKey` we hand THIS plugin — a token
    // minted here can't be replayed against a different plugin's WebUI.
    const { token, expiresAt } = jwtService.signPluginSession(
      ctx.pluginKey,
      { purpose: "plugin-session", userId, guildId, capabilities: [] },
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
    Body: { guild_id: string; user_ids: unknown[] };
  }>(
    "/api/plugin/members.get",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            // Bare non-empty typeof at HEAD — NOT snowflake-checked
            // (unlike members.add_role), so no pattern here.
            guild_id: nonEmptyStringField,
            // The array check was a guard (`!Array.isArray` → 400); the
            // per-item filtering below is a normaliser and stays in the
            // handler, so `items` is deliberately unconstrained.
            user_ids: { type: "array" },
          },
          required: ["guild_id", "user_ids"],
        },
      },
      // The wrong-typed case keeps its old text verbatim (ajv renders
      // "user_ids must be array" — same meaning, different bytes). The
      // *missing* case sharpens to the family's "user_ids required":
      // an (instancePath "", keyword "required") override cannot be
      // scoped to one property and would swallow a missing guild_id too.
      schemaErrorFormatter: preservingSchemaErrorFormatter([
        {
          instancePath: "/user_ids",
          keyword: "type",
          message: "user_ids must be an array",
        },
      ]),
    },
    async (request, reply) => {
    const ctx = await requireScope(request, reply, "members.get");
    if (!ctx) return;
    if (!bot) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body;
    const guildId = body.guild_id;
    // Cross-shard forward (PR-3.3): if another shard owns this guild and
    // a forward target is configured, relay the whole RPC there and
    // return its response. No-op in the single-shard default. Placed
    // after guild_id validation, before any local guild work.
    if ((await maybeForwardGuildRpc(request, reply, guildId)).handled) return;
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
    if (!(await pluginHasGuildReach(ctx.pluginId, guildId))) {
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
  server.post<{ Body: { user_ids: unknown[] } }>(
    "/api/plugin/users.get",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            // The array check was a guard (`!Array.isArray` → 400); the
            // per-item snowflake filtering below is a normaliser and
            // stays in the handler, so `items` is deliberately
            // unconstrained — same split as members.get.
            user_ids: { type: "array" },
          },
          required: ["user_ids"],
        },
      },
      // Same trade as members.get: the wrong-typed case keeps its old
      // text verbatim; the *missing* case (which the old `!Array.isArray`
      // also caught, with the same message) sharpens to the family's
      // "user_ids required" — a body-level `required` override can't be
      // scoped to one property.
      schemaErrorFormatter: preservingSchemaErrorFormatter([
        {
          instancePath: "/user_ids",
          keyword: "type",
          message: "user_ids must be an array",
        },
      ]),
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "users.get");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body;
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
  server.post<{ Body: { guild_id: string; channel_id: string } }>(
    "/api/plugin/channels.get",
    {
      schema: {
        body: {
          type: "object",
          // Both old guards ran SNOWFLAKE_RE — accepted set unchanged.
          properties: {
            guild_id: snowflakeField,
            channel_id: snowflakeField,
          },
          required: ["guild_id", "channel_id"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "channels.get");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body;
      if (!(await pluginHasGuildReach(ctx.pluginId, body.guild_id))) {
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
  server.post<{ Body: { guild_id: string; types?: unknown[] } }>(
    "/api/plugin/channels.list",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            // The old guard ran SNOWFLAKE_RE — accepted set unchanged.
            guild_id: snowflakeField,
            // Tightened by #58: a non-array `types` used to mean "no
            // filter"; now it is a 400 naming the field. Per-item
            // filtering (non-number entries dropped) stays a
            // normaliser in the handler, same split as users.get's
            // per-item id filter.
            types: arrayField,
          },
          required: ["guild_id"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "channels.list");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body;
      if (!(await pluginHasGuildReach(ctx.pluginId, body.guild_id))) {
        reply.code(403).send({ error: "plugin not enabled in this guild" });
        return;
      }
      const typeFilter =
        body.types !== undefined && body.types.length > 0
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
  server.post<{ Body: { guild_id: string } }>(
    "/api/plugin/roles.list",
    {
      schema: {
        body: {
          type: "object",
          // The old guard ran SNOWFLAKE_RE — accepted set unchanged.
          properties: { guild_id: snowflakeField },
          required: ["guild_id"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "roles.list");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body;
      if (!(await pluginHasGuildReach(ctx.pluginId, body.guild_id))) {
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
  server.post<{ Body: { guild_id: string; role_id: string } }>(
    "/api/plugin/roles.get",
    {
      schema: {
        body: {
          type: "object",
          // Both old guards ran SNOWFLAKE_RE — accepted set unchanged.
          properties: {
            guild_id: snowflakeField,
            role_id: snowflakeField,
          },
          required: ["guild_id", "role_id"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "roles.get");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body;
      if (!(await pluginHasGuildReach(ctx.pluginId, body.guild_id))) {
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
    Body: { guild_id: string; user_id: string; role_id: string };
  }>(
    "/api/plugin/members.add_role",
    {
      schema: {
        body: {
          type: "object",
          // The old guards ran SNOWFLAKE_RE on all three — the same
          // pattern the schema fragment compiles — so the accepted set
          // is unchanged.
          properties: {
            guild_id: snowflakeField,
            user_id: snowflakeField,
            role_id: snowflakeField,
          },
          required: ["guild_id", "user_id", "role_id"],
        },
      },
    },
    async (request, reply) => {
    const ctx = await requireScope(request, reply, "members.add_role");
    if (!ctx) return;
    if (!bot) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body;
    if (!(await pluginHasGuildReach(ctx.pluginId, body.guild_id))) {
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
    Body: { guild_id: string; user_id: string; role_id: string };
  }>(
    "/api/plugin/members.remove_role",
    {
      schema: {
        // Same shape as members.add_role, including the snowflake guards.
        body: {
          type: "object",
          properties: {
            guild_id: snowflakeField,
            user_id: snowflakeField,
            role_id: snowflakeField,
          },
          required: ["guild_id", "user_id", "role_id"],
        },
      },
    },
    async (request, reply) => {
    const ctx = await requireScope(request, reply, "members.remove_role");
    if (!ctx) return;
    if (!bot) {
      reply.code(503).send({ error: "bot client unavailable" });
      return;
    }
    const body = request.body;
    if (!(await pluginHasGuildReach(ctx.pluginId, body.guild_id))) {
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
    Body: { guild_id: string; channel_id: string; message_id: string };
  }>(
    "/api/plugin/messages.get",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            guild_id: snowflakeField,
            channel_id: snowflakeField,
            message_id: snowflakeField,
          },
          required: ["guild_id", "channel_id", "message_id"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "messages.get");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body;
      if (!(await pluginHasGuildReach(ctx.pluginId, body.guild_id))) {
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
    },
  );

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
      guild_id: string;
      channel_id: string;
      limit?: number;
      before?: string;
      after?: string;
      around?: string;
    };
  }>(
    "/api/plugin/messages.fetch_history",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            guild_id: snowflakeField,
            channel_id: snowflakeField,
            // Tightened by #58: a non-integer limit used to fall back
            // to 50, and a malformed cursor was silently dropped from
            // the query — both are now 400s naming the field. An
            // out-of-range *integer* limit is still clamped to
            // [1, 100] in the handler (a valid-typed value, documented
            // Discord cap), not refused.
            limit: integerField,
            before: snowflakeField,
            after: snowflakeField,
            around: snowflakeField,
          },
          required: ["guild_id", "channel_id"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "messages.fetch_history");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body;
      if (!(await pluginHasGuildReach(ctx.pluginId, body.guild_id))) {
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
        body.limit !== undefined ? Math.max(1, Math.min(100, body.limit)) : 50;
      const query = new URLSearchParams({ limit: String(limit) });
      if (body.before !== undefined) query.set("before", body.before);
      if (body.after !== undefined) query.set("after", body.after);
      if (body.around !== undefined) query.set("around", body.around);
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
    },
  );

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
      guild_id: string;
      channel_id: string;
      message_id: string;
      emoji: string;
      user_id?: string;
    };
  }>(
    "/api/plugin/messages.remove_reaction",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            guild_id: snowflakeField,
            channel_id: snowflakeField,
            message_id: snowflakeField,
            emoji: nonEmptyStringField,
            // Tightened by #58: a malformed user_id used to silently
            // fall back to removing the BOT'S OWN reaction — the
            // sharpest of the silent surprises. Now a 400 naming the
            // field; absence still means "the bot's own reaction".
            user_id: snowflakeField,
          },
          required: ["guild_id", "channel_id", "message_id", "emoji"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "messages.remove_reaction");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body;
      // Absent user_id = remove the bot's own reaction.
      const userId = body.user_id ?? null;
      if (!(await pluginHasGuildReach(ctx.pluginId, body.guild_id))) {
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
    },
  );

  // ─── guilds.get ──────────────────────────────────────────────────
  /**
   * POST /api/plugin/guilds.get
   * Body:    { guild_id: string }
   * Returns: { guild: APIGuild }
   */
  server.post<{ Body: { guild_id: string } }>(
    "/api/plugin/guilds.get",
    {
      schema: {
        body: {
          type: "object",
          // The old guard ran SNOWFLAKE_RE — accepted set unchanged.
          properties: { guild_id: snowflakeField },
          required: ["guild_id"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "guilds.get");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const body = request.body;
      if (!(await pluginHasGuildReach(ctx.pluginId, body.guild_id))) {
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
   * POST /api/plugin/me/enabled_guilds
   * Body: {} (empty — POST so plugin SDK's botRpc, which only speaks POST,
   *   can reach it; was GET before 0.9 and unreachable from any in-tree
   *   plugin)
   * Returns: { guild_ids: string[] }
   *
   * Two-mode semantics, picked from the manifest:
   *   - Plugin declares ≥1 `guild_features`: guild ids where this plugin
   *     has at least one *effectively enabled* feature. Effective =
   *     per-guild row precedence:
   *       row.enabled (if a row exists) → operator default override →
   *       manifest's enabled_by_default → false.
   *     Iterating only the rows would miss guilds that are following an
   *     enabled-by-default feature with no row written yet — background
   *     workers (e.g. radio's heartbeat loop) need those guilds too.
   *   - Plugin declares NO `guild_features` (e.g. a featureless background
   *     worker like reminder): every guild the bot is currently in. The
   *     plugin opts into "always on" by not declaring a feature toggle.
   *     Before 0.9 this returned `[]`, forcing authors to declare a dummy
   *     feature just to enumerate guilds.
   *
   * Walks bot.guilds.cache once so the result always reflects only
   * guilds the bot is currently in (no stale rows for left guilds).
   */
  server.post(
    "/api/plugin/me/enabled_guilds",
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "me.enabled_guilds");
      if (!ctx) return;
      if (!bot) {
        reply.code(503).send({ error: "bot client unavailable" });
        return;
      }
      const plugin = await findPluginById(ctx.pluginId);
      const manifest = plugin ? parsePluginManifest(plugin) : null;
      if (!manifest) {
        // No parseable manifest → no declared features → always-on.
        return { guild_ids: Array.from(bot.guilds.cache.keys()) };
      }
      // Fresh batch resolution (two queries) — the featureless
      // always-on contract and the Precedence Tiers live in the
      // Feature Reach module.
      return {
        guild_ids: await featureReachResolver.enabledGuildIds(
          ctx.pluginId,
          bot.guilds.cache.keys(),
          manifest,
        ),
      };
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
  server.post<{ Body: { guild_id: string } }>(
    "/api/plugin/me/kv_usage",
    {
      schema: {
        body: {
          type: "object",
          // The old guard ran SNOWFLAKE_RE — the same pattern the
          // schema fragment compiles — so the accepted set is unchanged.
          properties: { guild_id: snowflakeField },
          required: ["guild_id"],
        },
      },
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "me.kv_usage");
      if (!ctx) return;
      return await guildKvUsage(ctx.pluginId, request.body.guild_id);
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
  server.post<{ Body: { entries: unknown[] } }>(
    "/api/plugin/log.emit",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            // maxItems is the defensive cap that lived in the handler —
            // a runaway plugin could otherwise drive a 100k entry POST
            // and saturate the bot's event-log write path. Per-entry
            // shape stays unvalidated here: a malformed entry is
            // *skipped* (normalise-and-continue), never a 400.
            entries: { type: "array", maxItems: 100 },
          },
          required: ["entries"],
        },
      },
      // The cap's refusal text predates the formatter; keep it.
      schemaErrorFormatter: preservingSchemaErrorFormatter([
        {
          instancePath: "/entries",
          keyword: "maxItems",
          message: "max 100 entries per batch",
        },
      ]),
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "me.log");
      if (!ctx) return;
      let accepted = 0;
      let deduped = 0;
      for (const raw of request.body.entries) {
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
    {
      schema: {
        // Tightened by #58: the old guard (`!body || typeof body !==
        // "object"`) let an *array* body through — 200 with an empty
        // snapshot stored, an accident of `typeof [] === "object"` the
        // schema batch kept. JSON Schema's "object" excludes arrays, so
        // an array body is now refused. The snapshot's inner fields are
        // still normalisers (wrong type → default) in the handler — the
        // shape is the SDK MetricsCollector's, versioned with it.
        body: { type: "object" },
      },
      schemaErrorFormatter: preservingSchemaErrorFormatter([
        { instancePath: "", keyword: "type", message: "snapshot object required" },
      ]),
    },
    async (request, reply) => {
      const ctx = await requireScope(request, reply, "me.metrics");
      if (!ctx) return;
      const snap = request.body as Record<string, unknown>;
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
