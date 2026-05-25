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
  PluginModalDefinition,
} from "./plugin.js";
import type {
  APIApplicationCommandOptionChoice,
  AutocompleteContext,
  CommandContext,
  CommandReply,
  ComponentContext,
  ComponentReply,
  MessageActionRow,
  MessageAttachment,
  MessageFlags,
  ModalContext,
  ModalData,
  ModalReply,
  APIEmbed,
} from "./types.js";
import type { HealthReport } from "./context.js";

export interface PluginServerOptions {
  pluginKey: string;
  botUrl: string;
  /** Plugin 自訂指令（軌三）。 */
  pluginCommands?: PluginCommandDefinition[];
  /** Plugin 元件（按鈕 + select menu）handler。掛在 `/components`。 */
  components?: PluginComponentDefinition[];
  /** Plugin modal handler。掛在 `/modals/:modalId`。 */
  modals?: PluginModalDefinition[];
  getToken: () => string | null;
  getDispatchHmacKey?: () => string | null;
  getPublicBaseUrl?: () => string | undefined;
  /**
   * Called by the SDK-mounted `/health/detail` route on each probe.
   * Returns the report verbatim (the producer wrapper in `plugin.ts`
   * already handles the no-producer / not-yet-registered / thrown
   * cases). Always defined — when no `healthCheck` is configured,
   * `plugin.ts` supplies a stub that returns `{ status: "healthy" }`.
   */
  getHealthReport?: () => Promise<HealthReport>;
  /**
   * Called by the SDK-mounted `/_kc/lifecycle` route on each
   * HMAC-verified inbound bot dispatch. The dispatcher in `plugin.ts`
   * resolves the event type and routes to `onEnable` / `onDisable`.
   * When `hasLifecycleHandler` is false, the route is not mounted.
   */
  dispatchLifecycle?: (eventType: string, data: unknown) => Promise<void>;
  /** When false, the SDK does NOT mount `/_kc/lifecycle`. */
  hasLifecycleHandler?: boolean;
}

interface InteractionPayload {
  interaction_id: string;
  interaction_token: string;
  /** Bot application id — needed for `interactions.send_modal` REST call. */
  application_id: string;
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

/** Body the bot POSTs to `/components` on a button click / select submit. */
interface ComponentPayload {
  interaction_id: string;
  interaction_token: string;
  custom_id: string;
  /** Numeric `ComponentType` of the interacted component (Button=2, *Select=3/5-8). */
  component_type?: number;
  /**
   * Selected values for select-menu interactions. Empty / absent for buttons.
   * For user/role/mentionable/channel selects, these are the chosen snowflakes.
   */
  selected_values?: string[];
  guild_id: string | null;
  channel_id: string | null;
  message_id: string;
  user: { id: string; username?: string; global_name?: string | null };
  member?: {
    voice_channel_id?: string | null;
    capabilities?: string[];
  } | null;
}

/** Body the bot POSTs to `/commands/:name/autocomplete`. */
interface AutocompletePayload {
  interaction_id: string;
  command_name: string;
  sub_command_name: string | null;
  options: Array<{ name: string; type: number; value?: unknown }>;
  focused: { name: string; value: string; type: number };
  guild_id: string | null;
  user: { id: string; username?: string; global_name?: string | null };
}

/** Body the bot POSTs to `/modals/:modalId` on MODAL_SUBMIT. */
interface ModalPayload {
  interaction_id: string;
  interaction_token: string;
  custom_id: string;
  guild_id: string | null;
  channel_id: string | null;
  user: { id: string; username?: string; global_name?: string | null };
  member?: { capabilities?: string[] } | null;
  /** Submitted text-input values, keyed by each text input's custom_id. */
  components: Array<{ custom_id: string; value: string }>;
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
  embeds?: APIEmbed[],
  components?: MessageActionRow[],
  attachments?: MessageAttachment[],
  flags?: MessageFlags,
): Promise<void> {
  await callBotRpc(log, botUrl, token, "/api/plugin/interactions.respond", {
    interaction_token: interactionToken,
    ...(content !== undefined ? { content } : {}),
    ...(embeds !== undefined ? { embeds } : {}),
    ...(components !== undefined ? { components } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(flags !== undefined ? { flags } : {}),
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

/** Normalize a CommandReply to its full field set. */
function normalizeReply(reply: CommandReply): {
  content: string | undefined;
  ephemeral: boolean;
  embeds: APIEmbed[] | undefined;
  components: MessageActionRow[] | undefined;
  attachments: MessageAttachment[] | undefined;
  flags: MessageFlags | undefined;
} {
  // TypeScript forbids returning null/undefined from a handler, but
  // a JS handler with a missing return statement (or a code path
  // that doesn't return) silently produces undefined at runtime.
  // Without this guard the object branch below throws a confusing
  // TypeError ("Cannot read properties of undefined (reading
  // 'content')") that surfaces through the outer catch as a generic
  // "Internal error" — drowning the real diagnostic. Treat
  // null/undefined as an empty reply.
  if (reply === null || reply === undefined) {
    return {
      content: undefined,
      ephemeral: false,
      embeds: undefined,
      components: undefined,
      attachments: undefined,
      flags: undefined,
    };
  }
  if (typeof reply === "string") {
    return {
      content: reply,
      ephemeral: false,
      embeds: undefined,
      components: undefined,
      attachments: undefined,
      flags: undefined,
    };
  }
  return {
    content: reply.content,
    ephemeral: reply.ephemeral ?? false,
    embeds: reply.embeds,
    components: reply.components,
    attachments: reply.attachments,
    flags: reply.flags,
  };
}

/**
 * Modal replies normalize to a strict ephemeral subset of CommandReply.
 * `ephemeral` is forced true — Discord locks ephemerality at defer
 * time and the bot always defers modal submits as ephemeral (see
 * plugin-modal-dispatch.service.ts). See ModalReply JSDoc.
 */
function normalizeModalReply(reply: ModalReply): {
  content: string | undefined;
  ephemeral: boolean;
  embeds: APIEmbed[] | undefined;
  components: MessageActionRow[] | undefined;
  flags: MessageFlags | undefined;
} | null {
  if (reply === undefined || reply === null) return null;
  if (typeof reply === "string") {
    return {
      content: reply,
      ephemeral: true,
      embeds: undefined,
      components: undefined,
      flags: undefined,
    };
  }
  return {
    content: reply.content,
    ephemeral: true,
    embeds: reply.embeds,
    components: reply.components,
    flags: reply.flags,
  };
}

export function createPluginServer(opts: PluginServerOptions): FastifyInstance {
  // Map carries both the handler and responseKind so the dispatcher
  // can detect "modal-declared command returned without calling
  // sendModal" — that scenario is silent-fail today (Discord's 3-s
  // window expires and the user sees "interaction failed" with no
  // bot-side trace). We surface it as a warn-level log so operators
  // can spot the misconfiguration.
  const commandMap = new Map<
    string,
    {
      handler: PluginCommandDefinition["handler"];
      responseKind: "deferred" | "modal";
    }
  >(
    (opts.pluginCommands ?? []).map((cmd) => [
      cmd.name,
      { handler: cmd.handler, responseKind: cmd.responseKind ?? "deferred" },
    ]),
  );

  // componentId → handler
  const componentMap = new Map<string, PluginComponentDefinition["handler"]>(
    (opts.components ?? []).map((c) => [c.id, c.handler]),
  );

  // modalId → handler
  const modalMap = new Map<string, PluginModalDefinition["handler"]>(
    (opts.modals ?? []).map((m) => [m.id, m.handler]),
  );

  // command_name → autocomplete handler (only commands that opted in)
  const autocompleteMap = new Map<
    string,
    NonNullable<PluginCommandDefinition["autocomplete"]>
  >(
    (opts.pluginCommands ?? [])
      .filter(
        (cmd): cmd is PluginCommandDefinition & {
          autocomplete: NonNullable<PluginCommandDefinition["autocomplete"]>;
        } => typeof cmd.autocomplete === "function",
      )
      .map((cmd) => [cmd.name, cmd.autocomplete]),
  );

  const server = Fastify({ logger: true });
  server.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );
  server.get("/health", async () => ({ status: "ok" }));

  // Rich health probe. The bot polls /health/detail every 60 s and on
  // demand from the admin UI. When no `healthCheck` is configured in
  // PluginConfig, `getHealthReport` returns `{ status: "healthy" }`.
  // Errors thrown inside the producer are caught upstream in plugin.ts
  // and surfaced as `{ status: "unhealthy", message }` — this route
  // itself never throws to the bot.
  server.get("/health/detail", async () => {
    if (!opts.getHealthReport) {
      return { status: "healthy" as const, checkedAt: Date.now() };
    }
    return await opts.getHealthReport();
  });

  // Lifecycle dispatch. Only mounted when the plugin declared onEnable
  // or onDisable. HMAC-verified like /commands and /components — the
  // bot signs every POST with the per-plugin dispatch key.
  if (opts.hasLifecycleHandler && opts.dispatchLifecycle) {
    server.post(
      "/_kc/lifecycle",
      async (request: FastifyRequest, reply: FastifyReply) => {
        const signingKey = opts.getDispatchHmacKey?.() ?? null;
        if (!signingKey) {
          return reply.code(503).send({
            error:
              "dispatch HMAC key not available; plugin must re-register",
          });
        }
        const rawBody = typeof request.body === "string" ? request.body : "";
        const auth = verifyDispatchAuth(request, rawBody, signingKey);
        if (!auth.ok) return reply.code(401).send({ error: auth.reason });
        let payload: { type: unknown; data?: unknown };
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return reply.code(400).send({ error: "invalid JSON" });
        }
        if (typeof payload.type !== "string") {
          return reply.code(400).send({ error: "missing event type" });
        }
        try {
          await opts.dispatchLifecycle!(payload.type, payload.data ?? {});
        } catch (err) {
          // Lifecycle hooks throwing shouldn't cause the bot to retry
          // (the toggle has already happened on the bot side). Log
          // and 200 — operators see the throw in admin event log via
          // the plugin's botEventLog flushing.
          server.log.error(
            { err, type: payload.type },
            "lifecycle hook threw",
          );
        }
        return { ok: true };
      },
    );
  }

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

      const entry = commandMap.get(payload.command_name);
      if (!entry) {
        // Command arrived but no handler is registered for it. The
        // most likely cause is a manifest/code drift: the manifest
        // declared the command but `definePluginCommand` was never
        // called for it (or the name in `pluginCommands` doesn't
        // match the manifest).
        server.log.error(
          { commandName: payload.command_name },
          "command dispatched but no handler registered — manifest/code drift",
        );
        // We can't know from here whether the bot deferred. Try to
        // surface the message via interactions.respond:
        //  - response_kind="deferred": bot deferred → user sees the
        //    message
        //  - response_kind="modal":     bot didn't defer → call 404s,
        //    callBotRpc logs warn, user sees Discord's generic
        //    "interaction failed". Either way the SDK error log
        //    above is the canonical signal for the operator.
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
      const { handler, responseKind: commandResponseKind } = entry;

      // (payload.member?.capabilities ?? []) is provably string[]
      // here — the outer ?? + Array.filter type-narrows cleanly. The
      // previous form used `!` to override the null check, which is
      // forward-compatible-unsafe (a refactor that loosens the
      // ternary loses the safety net silently).
      const capabilities = (payload.member?.capabilities ?? []).filter(
        (c): c is string => typeof c === "string",
      );

      // Tracks whether the handler called ctx.sendModal — if so, the
      // SDK skips the regular respondToInteraction call (Discord
      // doesn't accept a follow-up reply after a modal response).
      let modalSent = false;

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
        interactionId: payload.interaction_id,
        interactionToken: payload.interaction_token,
        log: {
          info: (msg, meta) => server.log.info(meta ?? {}, msg),
          warn: (msg, meta) => server.log.warn(meta ?? {}, msg),
          error: (msg, meta) => server.log.error(meta ?? {}, msg),
        },
        botRpc: (path: string, body?: unknown) =>
          callBotRpc(server.log, opts.botUrl, token, path, body),
        async sendModal(modal: ModalData): Promise<boolean> {
          // The command must have declared response_kind: "modal" in
          // its manifest so the bot skipped its defer. If it did
          // defer, this call will 4xx — Discord rejects modal-after-
          // ack — and we surface that as `false`.
          //
          // We deliberately don't forward application_id; the bot has
          // its own bot.application.id available and uses that for
          // the REST callback. Forwarding a plugin-supplied id would
          // suggest the bot honours it (it doesn't).
          const res = await callBotRpc(
            server.log,
            opts.botUrl,
            token,
            "/api/plugin/interactions.send_modal",
            {
              interaction_id: payload.interaction_id,
              interaction_token: payload.interaction_token,
              modal,
            },
          );
          if (res !== null) {
            modalSent = true;
            return true;
          }
          return false;
        },
      };

      try {
        const rawReply = await handler(ctx);
        if (modalSent) {
          // Modal already opened — there's no editable deferred
          // reply, and any non-empty handler return here would
          // silently drop. Warn if the handler returned anything
          // unusual so the bug is visible.
          if (rawReply !== undefined && rawReply !== null && rawReply !== "") {
            server.log.warn(
              { commandName: payload.command_name },
              "command handler returned a reply AFTER calling sendModal — value ignored",
            );
          }
          return;
        }
        if (commandResponseKind === "modal") {
          // Handler returned without opening a modal even though the
          // manifest declared `response_kind: "modal"`. The bot did
          // NOT defer (Discord rejects modal-after-defer), so calling
          // interactions.respond below would 404. Surface the misuse
          // as a warning rather than letting Discord just time out.
          server.log.warn(
            { commandName: payload.command_name },
            "command declares response_kind='modal' but handler returned without calling ctx.sendModal — interaction will expire",
          );
          return;
        }
        const { content, ephemeral, embeds, components, attachments, flags } =
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
          flags,
        );
      } catch (err) {
        server.log.error({ err }, "command handler threw");
        // Skip the post-throw error reply when:
        //  - the modal was already sent (no editable deferred reply)
        //  - the command declared response_kind:"modal" so the bot
        //    didn't defer; respond would 404 against the dead token
        if (!modalSent && commandResponseKind !== "modal") {
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

      // (payload.member?.capabilities ?? []) is provably string[]
      // here — the outer ?? + Array.filter type-narrows cleanly. The
      // previous form used `!` to override the null check, which is
      // forward-compatible-unsafe (a refactor that loosens the
      // ternary loses the safety net silently).
      const capabilities = (payload.member?.capabilities ?? []).filter(
        (c): c is string => typeof c === "string",
      );
      const ctx: ComponentContext = {
        pluginKey: opts.pluginKey,
        customId: payload.custom_id,
        componentId,
        tail,
        guildId: payload.guild_id,
        channelId: payload.channel_id,
        messageId: payload.message_id,
        interactionToken: payload.interaction_token,
        componentType:
          typeof payload.component_type === "number"
            ? payload.component_type
            : 0,
        selectedValues: Array.isArray(payload.selected_values)
          ? payload.selected_values.filter(
              (v): v is string => typeof v === "string",
            )
          : [],
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
            rawReply.components !== undefined ||
            rawReply.flags !== undefined)
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
            undefined,
            rawReply.flags,
          );
        }
      } catch (err) {
        server.log.error({ err }, "component handler threw");
        await followup("⚠ Internal error while handling the component");
      }
    },
  );

  // ── Plugin autocomplete dispatch（HMAC 驗證）────────────────────────────
  // Bot POSTs to /commands/{command_name}/autocomplete when the user
  // is typing into an option declared with `autocomplete: true`. The
  // handler returns up to 25 choices SYNCHRONOUSLY (bot times out at
  // ~1.5 s). The HTTP response body IS the reply — no botRpc round-
  // trip needed.
  server.post<{ Params: { commandName: string } }>(
    "/commands/:commandName/autocomplete",
    async (request, reply) => {
      const signingKey = opts.getDispatchHmacKey?.() ?? null;
      if (!signingKey) {
        return reply.code(503).send({
          error: "dispatch HMAC key not available; plugin must re-register",
        });
      }
      const rawBody = typeof request.body === "string" ? request.body : "";
      const auth = verifyDispatchAuth(request, rawBody, signingKey);
      if (!auth.ok) return reply.code(401).send({ error: auth.reason });

      let payload: AutocompletePayload;
      try {
        payload = JSON.parse(rawBody) as AutocompletePayload;
      } catch {
        return reply.code(400).send({ error: "invalid JSON" });
      }
      if (request.params.commandName !== payload.command_name) {
        return reply.code(400).send({ error: "command_name mismatch" });
      }

      const handler = autocompleteMap.get(payload.command_name);
      if (!handler) {
        // Command exists but no autocomplete handler — return empty
        // (commands without autocomplete shouldn't even be hit, but
        // be lenient).
        return reply.send({ choices: [] });
      }

      const opts2: Record<string, unknown> = {};
      for (const o of payload.options ?? []) {
        if (typeof o.name === "string") opts2[o.name] = o.value;
      }
      const ctx: AutocompleteContext = {
        pluginKey: opts.pluginKey,
        commandName: payload.command_name,
        // Normalize undefined→null so handlers branching on `=== null`
        // see consistent values whether the bot sent the field or not.
        subCommandName: payload.sub_command_name ?? null,
        guildId: payload.guild_id,
        userId: payload.user.id,
        focused: payload.focused,
        options: opts2,
        log: {
          info: (msg, meta) => server.log.info(meta ?? {}, msg),
          warn: (msg, meta) => server.log.warn(meta ?? {}, msg),
          error: (msg, meta) => server.log.error(meta ?? {}, msg),
        },
      };

      try {
        const choices: APIApplicationCommandOptionChoice[] = await handler(ctx);
        // Discord caps autocomplete responses at 25 choices.
        return reply.send({ choices: choices.slice(0, 25) });
      } catch (err) {
        server.log.error(
          { err, commandName: payload.command_name },
          "autocomplete handler threw",
        );
        return reply.send({ choices: [] });
      }
    },
  );

  // ── Plugin modal-submit dispatch（HMAC 驗證）───────────────────────────
  // Bot POSTs to /modals/{modal_id} when a user submits a modal whose
  // custom_id is `kc:<thisPluginKey>:<modalId>[:<tail>]`. Bot has
  // already deferReply'd ephemerally; handler returns a reply to edit
  // the deferred message (default ephemeral=true).
  server.post<{ Params: { modalId: string } }>(
    "/modals/:modalId",
    async (request, reply) => {
      const signingKey = opts.getDispatchHmacKey?.() ?? null;
      if (!signingKey) {
        return reply.code(503).send({
          error: "dispatch HMAC key not available; plugin must re-register",
        });
      }
      const rawBody = typeof request.body === "string" ? request.body : "";
      const auth = verifyDispatchAuth(request, rawBody, signingKey);
      if (!auth.ok) return reply.code(401).send({ error: auth.reason });

      let payload: ModalPayload;
      try {
        payload = JSON.parse(rawBody) as ModalPayload;
      } catch {
        return reply.code(400).send({ error: "invalid JSON" });
      }
      if (!payload.user || typeof payload.user.id !== "string") {
        return reply.code(400).send({ error: "missing user.id" });
      }
      if (typeof payload.custom_id !== "string") {
        return reply.code(400).send({ error: "missing custom_id" });
      }

      const token = opts.getToken();
      if (!token) return reply.code(200).send({ ok: true });
      reply.code(204).send();

      const prefix = `kc:${opts.pluginKey}:`;
      if (!payload.custom_id.startsWith(prefix)) {
        server.log.warn(
          { customId: payload.custom_id },
          "modal custom_id doesn't match this plugin",
        );
        return;
      }
      const after = payload.custom_id.slice(prefix.length);
      const sep = after.indexOf(":");
      const modalId = sep === -1 ? after : after.slice(0, sep);
      const tail = sep === -1 ? "" : after.slice(sep + 1);

      const handler = modalMap.get(modalId);
      if (!handler) {
        await respondToInteraction(
          server.log,
          opts.botUrl,
          token,
          payload.interaction_token,
          `⚠ Unknown modal \`${modalId}\``,
          true,
        );
        return;
      }

      // (payload.member?.capabilities ?? []) is provably string[]
      // here — the outer ?? + Array.filter type-narrows cleanly. The
      // previous form used `!` to override the null check, which is
      // forward-compatible-unsafe (a refactor that loosens the
      // ternary loses the safety net silently).
      const capabilities = (payload.member?.capabilities ?? []).filter(
        (c): c is string => typeof c === "string",
      );
      const fields: Record<string, string> = {};
      for (const c of payload.components ?? []) {
        if (typeof c.custom_id === "string" && typeof c.value === "string") {
          fields[c.custom_id] = c.value;
        }
      }
      const ctx: ModalContext = {
        pluginKey: opts.pluginKey,
        customId: payload.custom_id,
        modalId,
        tail,
        fields,
        guildId: payload.guild_id,
        channelId: payload.channel_id,
        interactionToken: payload.interaction_token,
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
        const normalized = normalizeModalReply(rawReply);
        if (!normalized) return;
        await respondToInteraction(
          server.log,
          opts.botUrl,
          token,
          payload.interaction_token,
          normalized.content,
          normalized.ephemeral,
          normalized.embeds,
          normalized.components,
          undefined,
          normalized.flags,
        );
      } catch (err) {
        server.log.error({ err, modalId }, "modal handler threw");
        await respondToInteraction(
          server.log,
          opts.botUrl,
          token,
          payload.interaction_token,
          "⚠ Internal error while handling the modal",
          true,
        );
      }
    },
  );

  return server;
}
