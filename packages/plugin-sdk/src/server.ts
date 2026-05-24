import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  isFreshTimestamp,
  verify,
} from "./hmac.js";
import type {
  PluginCommandDefinition,
  PluginComponentDefinition,
} from "./plugin.js";
import type {
  CommandContext,
  CommandReply,
  ComponentContext,
  ComponentReply,
} from "./types.js";

export interface PluginServerOptions {
  pluginKey: string;
  botUrl: string;
  /** Plugin 自訂指令（軌三）。 */
  pluginCommands?: PluginCommandDefinition[];
  /** Plugin 元件（按鈕）handler。掛在 `/components`。 */
  components?: PluginComponentDefinition[];
  getToken: () => string | null;
  getDispatchHmacKey?: () => string | null;
  getPublicBaseUrl?: () => string | undefined;
}

interface InteractionPayload {
  interaction_id: string;
  interaction_token: string;
  command_name: string;
  sub_command_name: string | null;
  options: Array<{ name: string; type: number; value?: unknown }>;
  guild_id: string | null;
  /** Channel the slash was invoked in. The bot has been sending this
   *  since the dispatch service was written — we just hadn't surfaced
   *  it on `CommandContext`. */
  channel_id: string | null;
  user: { id: string; username?: string; global_name?: string | null };
  /** Bot-resolved subset of the invoker's RBAC tokens: `admin` + this plugin's `plugin:<key>:*`. */
  member?: { capabilities?: string[] };
}

/** Body the bot POSTs to `/components` on a button click. */
interface ComponentPayload {
  interaction_id: string;
  interaction_token: string;
  custom_id: string;
  guild_id: string | null;
  channel_id: string | null;
  message_id: string;
  user: { id: string; username?: string; global_name?: string | null };
  member?: {
    voice_channel_id?: string | null;
    capabilities?: string[];
  } | null;
}

function verifyDispatchAuth(
  request: FastifyRequest,
  rawBody: string,
  secret: string,
): { ok: true } | { ok: false; reason: string } {
  const tsHeader = request.headers[TIMESTAMP_HEADER];
  const sigHeader = request.headers[SIGNATURE_HEADER];
  if (typeof tsHeader !== "string") {
    return { ok: false, reason: "missing timestamp header" };
  }
  if (typeof sigHeader !== "string") {
    return { ok: false, reason: "missing signature header" };
  }
  if (!isFreshTimestamp(tsHeader, Math.floor(Date.now() / 1000))) {
    return { ok: false, reason: "timestamp outside replay window" };
  }
  const urlPath = request.url.split("?")[0];
  if (
    !verify({
      secret,
      method: request.method,
      path: urlPath,
      body: rawBody,
      ts: tsHeader,
      presented: sigHeader,
    })
  ) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

/**
 * Generic bot RPC caller. Used by `ctx.botRpc()`, `respondToInteraction`,
 * and re-exported for `StartedPlugin.botRpc()` to share one implementation.
 * Returns the parsed JSON body, an empty object on 204, or null on
 * network / non-2xx errors (already logged).
 */
export async function callBotRpc(
  log: FastifyInstance["log"],
  botUrl: string,
  token: string,
  path: string,
  body: unknown,
): Promise<unknown | null> {
  try {
    const res = await fetch(`${botUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.warn(
        { path, status: res.status, body: text.slice(0, 200) },
        "bot rpc call failed",
      );
      return null;
    }
    if (res.status === 204) return {};
    return await res.json().catch(() => ({}));
  } catch (err) {
    log.error({ err, path }, "bot rpc call threw");
    return null;
  }
}

async function respondToInteraction(
  log: FastifyInstance["log"],
  botUrl: string,
  token: string,
  interactionToken: string,
  content: string | undefined,
  ephemeral: boolean,
  embeds?: unknown[],
  components?: unknown[],
  attachments?: unknown[],
): Promise<void> {
  await callBotRpc(log, botUrl, token, "/api/plugin/interactions.respond", {
    interaction_token: interactionToken,
    ...(content !== undefined ? { content } : {}),
    ...(embeds !== undefined ? { embeds } : {}),
    ...(components !== undefined ? { components } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ephemeral,
  });
}

function readOpts(payload: InteractionPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of payload.options ?? []) {
    if (typeof o.name === "string") out[o.name] = o.value;
  }
  return out;
}

/** Normalize a CommandReply to { content, ephemeral, embeds, components, attachments }. */
function normalizeReply(reply: CommandReply): {
  content: string | undefined;
  ephemeral: boolean;
  embeds: unknown[] | undefined;
  components: unknown[] | undefined;
  attachments: unknown[] | undefined;
} {
  if (typeof reply === "string") {
    return {
      content: reply,
      ephemeral: false,
      embeds: undefined,
      components: undefined,
      attachments: undefined,
    };
  }
  return {
    content: reply.content,
    ephemeral: reply.ephemeral ?? false,
    embeds: reply.embeds,
    components: reply.components,
    attachments: reply.attachments,
  };
}

export function createPluginServer(opts: PluginServerOptions): FastifyInstance {
  const commandMap = new Map<string, PluginCommandDefinition["handler"]>(
    (opts.pluginCommands ?? []).map((cmd) => [cmd.name, cmd.handler]),
  );

  // v2 component map：componentId → handler
  const componentMap = new Map<string, PluginComponentDefinition["handler"]>(
    (opts.components ?? []).map((c) => [c.id, c.handler]),
  );

  const server = Fastify({ logger: true });
  server.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );
  server.get("/health", async () => ({ status: "ok" }));

  // ── 軌三：plugin command dispatch（HMAC 驗證）────────────────────────────
  server.post(
    "/commands/:commandName",
    async (
      request: FastifyRequest<{ Params: { commandName: string } }>,
      reply: FastifyReply,
    ) => {
      const signingKey = opts.getDispatchHmacKey?.() ?? null;
      if (!signingKey) {
        return reply.code(503).send({
          error: "dispatch HMAC key not available; plugin must re-register",
        });
      }
      const rawBody = typeof request.body === "string" ? request.body : "";
      const auth = verifyDispatchAuth(request, rawBody, signingKey);
      if (!auth.ok) return reply.code(401).send({ error: auth.reason });

      let payload: InteractionPayload;
      try {
        payload = JSON.parse(rawBody) as InteractionPayload;
      } catch {
        return reply.code(400).send({ error: "invalid JSON" });
      }

      if (request.params.commandName !== payload.command_name) {
        return reply.code(400).send({ error: "command_name mismatch" });
      }

      if (!payload.user || typeof payload.user.id !== "string") {
        return reply.code(400).send({ error: "missing user.id" });
      }

      const token = opts.getToken();
      if (!token) return reply.code(200).send({ ok: true });
      reply.code(204).send();

      const handler = commandMap.get(payload.command_name);
      if (!handler) {
        await respondToInteraction(
          server.log,
          opts.botUrl,
          token,
          payload.interaction_token,
          `⚠ Unknown command \`${payload.command_name}\``,
          false,
          undefined,
        );
        return;
      }

      const capabilities = Array.isArray(payload.member?.capabilities)
        ? payload.member!.capabilities!.filter(
            (c): c is string => typeof c === "string",
          )
        : [];
      const ctx: CommandContext = {
        pluginKey: opts.pluginKey,
        commandName: payload.command_name,
        subCommandName: payload.sub_command_name,
        options: readOpts(payload),
        guildId: payload.guild_id,
        channelId: payload.channel_id,
        userId: payload.user.id,
        userDisplayName:
          payload.user.global_name || payload.user.username || payload.user.id,
        capabilities,
        hasCapability: (capKey: string): boolean =>
          capabilities.includes("admin") ||
          capabilities.includes(`plugin:${opts.pluginKey}:${capKey}`),
        publicBaseUrl: opts.getPublicBaseUrl?.(),
        log: {
          info: (msg, meta) => server.log.info(meta ?? {}, msg),
          warn: (msg, meta) => server.log.warn(meta ?? {}, msg),
          error: (msg, meta) => server.log.error(meta ?? {}, msg),
        },
        botRpc: (path: string, body?: unknown) =>
          callBotRpc(server.log, opts.botUrl, token, path, body),
      };

      try {
        const rawReply = await handler(ctx);
        const { content, ephemeral, embeds, components, attachments } =
          normalizeReply(rawReply);
        await respondToInteraction(
          server.log,
          opts.botUrl,
          token,
          payload.interaction_token,
          content,
          ephemeral,
          embeds,
          components,
          attachments,
        );
      } catch (err) {
        server.log.error({ err }, "command handler threw");
        await respondToInteraction(
          server.log,
          opts.botUrl,
          token,
          payload.interaction_token,
          "⚠ Internal error while handling command",
          false,
          undefined,
        );
      }
    },
  );

  // ── plugin 元件（按鈕）dispatch（HMAC 驗證）─────────────────────────────
  // custom_id = `kc:<thisPluginKey>:<componentId>[:<tail>]`。bot 先
  // deferUpdate() ack 點擊（不改訊息），再 POST 過來；handler 回傳
  // { content?, embeds?, components? } 就用 interactions.respond
  // PATCH 按鈕所在的那則訊息（@original），回傳空 / null 則維持訊息原狀。
  server.post(
    "/components",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signingKey = opts.getDispatchHmacKey?.() ?? null;
      if (!signingKey) {
        return reply.code(503).send({
          error: "dispatch HMAC key not available; plugin must re-register",
        });
      }
      const rawBody = typeof request.body === "string" ? request.body : "";
      const auth = verifyDispatchAuth(request, rawBody, signingKey);
      if (!auth.ok) return reply.code(401).send({ error: auth.reason });

      let payload: ComponentPayload;
      try {
        payload = JSON.parse(rawBody) as ComponentPayload;
      } catch {
        return reply.code(400).send({ error: "invalid JSON" });
      }
      if (!payload.user || typeof payload.user.id !== "string") {
        return reply.code(400).send({ error: "missing user.id" });
      }
      if (
        typeof payload.custom_id !== "string" ||
        typeof payload.message_id !== "string"
      ) {
        return reply.code(400).send({ error: "missing custom_id / message_id" });
      }

      const token = opts.getToken();
      if (!token) return reply.code(200).send({ ok: true });
      reply.code(204).send();

      const prefix = `kc:${opts.pluginKey}:`;
      if (!payload.custom_id.startsWith(prefix)) {
        server.log.warn(
          { customId: payload.custom_id },
          "component custom_id doesn't match this plugin",
        );
        return;
      }
      const after = payload.custom_id.slice(prefix.length);
      const sep = after.indexOf(":");
      const componentId = sep === -1 ? after : after.slice(0, sep);
      const tail = sep === -1 ? "" : after.slice(sep + 1);

      const followup = (content: string): Promise<unknown | null> =>
        callBotRpc(
          server.log,
          opts.botUrl,
          token,
          "/api/plugin/interactions.followup",
          {
            interaction_token: payload.interaction_token,
            content,
            ephemeral: true,
          },
        );

      const handler = componentMap.get(componentId);
      if (!handler) {
        await followup(`⚠ Unknown component \`${componentId}\``);
        return;
      }

      const capabilities = Array.isArray(payload.member?.capabilities)
        ? payload.member!.capabilities!.filter(
            (c): c is string => typeof c === "string",
          )
        : [];
      const ctx: ComponentContext = {
        pluginKey: opts.pluginKey,
        customId: payload.custom_id,
        componentId,
        tail,
        guildId: payload.guild_id,
        channelId: payload.channel_id,
        messageId: payload.message_id,
        interactionToken: payload.interaction_token,
        userId: payload.user.id,
        userDisplayName:
          payload.user.global_name || payload.user.username || payload.user.id,
        voiceChannelId: payload.member?.voice_channel_id ?? null,
        capabilities,
        hasCapability: (capKey: string): boolean =>
          capabilities.includes("admin") ||
          capabilities.includes(`plugin:${opts.pluginKey}:${capKey}`),
        publicBaseUrl: opts.getPublicBaseUrl?.(),
        log: {
          info: (msg, meta) => server.log.info(meta ?? {}, msg),
          warn: (msg, meta) => server.log.warn(meta ?? {}, msg),
          error: (msg, meta) => server.log.error(meta ?? {}, msg),
        },
        botRpc: (path: string, body?: unknown) =>
          callBotRpc(server.log, opts.botUrl, token, path, body),
      };

      try {
        const rawReply = await handler(ctx);
        if (
          rawReply &&
          (rawReply.content !== undefined ||
            rawReply.embeds !== undefined ||
            rawReply.components !== undefined)
        ) {
          await respondToInteraction(
            server.log,
            opts.botUrl,
            token,
            payload.interaction_token,
            rawReply.content,
            false,
            rawReply.embeds,
            rawReply.components,
          );
        }
      } catch (err) {
        server.log.error({ err }, "component handler threw");
        await followup("⚠ Internal error while handling the button");
      }
    },
  );

  return server;
}
