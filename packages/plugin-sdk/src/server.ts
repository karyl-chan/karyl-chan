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
import { createPluginRpc } from "./rpc/index.js";

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
  /**
   * Called by the SDK-mounted `/events` route on each HMAC-verified
   * inbound bot event dispatch. Receives the event type and raw data;
   * `plugin.ts` resolves the handler by type and runs it inside a
   * try/catch so a single throw can't take the process down.
   *
   * When `hasEventHandlers` is false, the `/events` route is not
   * mounted — the bot still emits the event but we 404 on receipt,
   * which surfaces a "no events endpoint" in the bot event log to
   * prompt the plugin author.
   */
  dispatchEvent?: (eventType: string, data: unknown) => Promise<void>;
  /** When false, the SDK does NOT mount `/events`. */
  hasEventHandlers?: boolean;
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
  /** BCP-47 locale of the user (from Discord's interaction.locale). May be absent on older bots. */
  locale?: string | null;
  /** BCP-47 locale of the server (Discord's interaction.guildLocale). */
  guild_locale?: string | null;
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
  locale?: string | null;
  guild_locale?: string | null;
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
  locale?: string | null;
  guild_locale?: string | null;
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
  locale?: string | null;
  guild_locale?: string | null;
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
 * Discriminated error from a bot RPC call. `reason` lets callers tell
 * "the bot rejected my call" from "the bot is unreachable" — the
 * previous `Promise<unknown | null>` shape collapsed both into a single
 * `null` and forced plugin code to guess which one happened.
 *
 * Throws are routed through this class so plugins can `try { ... }
 * catch (e) { if (e instanceof BotRpcError && e.reason === ...) ... }`.
 *
 * Reasons:
 *   - `no_token`: plugin hasn't completed its first successful register
 *     yet (no auth token to send). Mostly a startup-race signal.
 *   - `network`: fetch threw — DNS, connection, abort, etc.
 *   - `forbidden`: bot replied 403. Usually means the scope this RPC
 *     needs isn't in the manifest's `rpcMethodsUsed` (auto-derived from
 *     the typed facade — see `manifest-builder.ts`), OR the plugin row
 *     is disabled / inactive on the bot, OR the per-guild feature gate
 *     denied this guild.
 *   - `quota_exceeded`: bot replied 413. The per-guild KV quota would
 *     be exceeded by this `kv_set` / `kv_increment`. `status` is 413.
 *   - `rate_limited`: bot replied 429 and the SDK exhausted its retry
 *     budget (3 attempts with backoff). Callers should back off harder
 *     or shed load — the SDK has already done the polite retry.
 *   - `http_status`: every other 4xx/5xx. `status` carries the HTTP code.
 *
 * The narrow reasons (`forbidden` / `quota_exceeded` / `rate_limited`)
 * always carry `status` set; `http_status` is the catch-all when the
 * status doesn't map to one of those.
 */
export type BotRpcErrorReason =
  | "no_token"
  | "network"
  | "forbidden"
  | "quota_exceeded"
  | "rate_limited"
  | "http_status";

export class BotRpcError extends Error {
  constructor(
    public readonly reason: BotRpcErrorReason,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "BotRpcError";
  }
}

function classifyHttpStatus(status: number): BotRpcErrorReason {
  if (status === 403) return "forbidden";
  if (status === 413) return "quota_exceeded";
  if (status === 429) return "rate_limited";
  return "http_status";
}

/**
 * Generic bot RPC caller. Used by `ctx.botRpc()`, `respondToInteraction`,
 * and re-exported for `StartedPlugin.botRpc()` to share one
 * implementation. Returns the parsed JSON body (or `{}` for 204) on
 * success. Throws `BotRpcError` on network failure or non-2xx status —
 * fire-and-forget callers must wrap in `.catch(() => {})` if they want
 * to swallow.
 *
 * Retry policy: on a 503 / 429 / network failure we
 * retry up to MAX_RPC_RETRIES times with exponential backoff + jitter,
 * honouring a server-supplied `Retry-After` header when present. These
 * three failure modes share the same invariant: the bot has NOT yet
 * accepted the request body, so a retry is safe even for non-idempotent
 * RPCs (messages.send, interactions.respond, …). Any other 5xx is
 * surfaced immediately — once the bot has accepted the body we can't
 * know whether the side effect happened, so we don't double-send.
 *
 * Total worst-case wall time on a fully degenerate path: ~3.5 s of
 * sleeps on top of the 10 s per-attempt fetch timeout. Plugin code
 * should NOT layer its own retry on top — that compounds.
 */
const MAX_RPC_RETRIES = 3;
const RETRY_BASE_MS = 200;
const RETRY_MAX_MS = 1_500;

function computeBackoffMs(
  attempt: number,
  retryAfterHeader: string | null,
): number {
  // `Retry-After` may be either delta-seconds or an HTTP date. We only
  // honour the integer-seconds form — the date form is rare in practice
  // and parsing it adds bytes for ~0 benefit on a private bot↔plugin
  // RPC link.
  if (retryAfterHeader) {
    const sec = Number.parseInt(retryAfterHeader, 10);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.min(sec * 1000, RETRY_MAX_MS);
    }
  }
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
  // ±30% jitter — spreads simultaneous retries across plugins so a
  // bot drain doesn't release a synchronized stampede.
  return base + Math.floor(Math.random() * base * 0.3);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callBotRpc(
  log: FastifyInstance["log"],
  botUrl: string,
  token: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const serialized = JSON.stringify(body ?? {});
  let lastNetworkErr: unknown = null;
  let lastHttpStatus = 0;
  let lastHttpText = "";
  let lastRetryAfter: string | null = null;

  for (let attempt = 0; attempt <= MAX_RPC_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = computeBackoffMs(attempt - 1, lastRetryAfter);
      log.debug(
        { path, attempt, delay, lastStatus: lastHttpStatus || "network" },
        "bot rpc retrying after transient failure",
      );
      await sleep(delay);
    }

    let res: Response;
    try {
      res = await fetch(`${botUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: serialized,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // Network errors are retryable: the bot definitionally never
      // received the body, so re-sending can't duplicate side effects.
      lastNetworkErr = err;
      lastHttpStatus = 0;
      lastRetryAfter = null;
      continue;
    }

    if (res.ok) {
      if (res.status === 204) return {};
      return await res.json().catch(() => ({}));
    }

    lastHttpStatus = res.status;
    lastHttpText = await res.text().catch(() => "");
    lastRetryAfter = res.headers.get("retry-after");

    // 503 = graceful drain or bot-not-ready; 429 = rate limit. Both
    // signal "bot rejected before processing" → safe to retry. Other
    // statuses (4xx, 500, 502, 504) are NOT retried: we can't tell
    // whether the side effect happened.
    if (res.status === 503 || res.status === 429) {
      continue;
    }

    log.warn(
      { path, status: res.status, body: lastHttpText.slice(0, 200) },
      "bot rpc call failed",
    );
    const reason = classifyHttpStatus(res.status);
    const hint =
      reason === "forbidden"
        ? " (check manifest rpcMethodsUsed / per-guild feature enablement)"
        : reason === "quota_exceeded"
          ? " (per-guild KV quota would be exceeded)"
          : "";
    throw new BotRpcError(
      reason,
      `bot rpc HTTP ${res.status}${hint}: ${lastHttpText.slice(0, 200)}`,
      res.status,
    );
  }

  // Out of retries. Surface whichever failure-mode we ended on.
  if (lastHttpStatus > 0) {
    log.warn(
      {
        path,
        status: lastHttpStatus,
        attempts: MAX_RPC_RETRIES + 1,
        body: lastHttpText.slice(0, 200),
      },
      "bot rpc retries exhausted",
    );
    // Retries only run for 503 / 429 / network. 429 → rate_limited;
    // 503 falls through as a transient http_status (operator-visible).
    const reason: BotRpcErrorReason =
      lastHttpStatus === 429 ? "rate_limited" : classifyHttpStatus(lastHttpStatus);
    throw new BotRpcError(
      reason,
      `bot rpc HTTP ${lastHttpStatus} after ${MAX_RPC_RETRIES + 1} attempts: ${lastHttpText.slice(0, 200)}`,
      lastHttpStatus,
    );
  }
  const msg =
    lastNetworkErr instanceof Error ? lastNetworkErr.message : String(lastNetworkErr);
  log.error(
    { err: lastNetworkErr, path, attempts: MAX_RPC_RETRIES + 1 },
    "bot rpc network retries exhausted",
  );
  throw new BotRpcError(
    "network",
    `bot rpc network error after ${MAX_RPC_RETRIES + 1} attempts: ${msg}`,
  );
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

/**
 * Normalize a CommandReply to its full field set.
 *
 * `defaultEphemeral` is the per-command default declared in the
 * manifest (`PluginCommandDefinition.defaultEphemeral`, mapped to
 * `default_ephemeral` on the wire). The bot uses the same value to
 * choose the defer ephemerality, so when the handler returns a plain
 * string or omits `ephemeral`, the reply matches the defer and the
 * bot stays on the happy "PATCH @original" path — no follow-up + DELETE
 * dance. Explicit `ephemeral: true` / `ephemeral: false` on the reply
 * still wins per call (the bot handles the mismatch by posting a
 * follow-up of the right ephemerality and deleting @original).
 */
function normalizeReply(
  reply: CommandReply,
  defaultEphemeral: boolean,
): {
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
      ephemeral: defaultEphemeral,
      embeds: undefined,
      components: undefined,
      attachments: undefined,
      flags: undefined,
    };
  }
  if (typeof reply === "string") {
    return {
      content: reply,
      ephemeral: defaultEphemeral,
      embeds: undefined,
      components: undefined,
      attachments: undefined,
      flags: undefined,
    };
  }
  return {
    content: reply.content,
    ephemeral: reply.ephemeral ?? defaultEphemeral,
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
  // Map carries the handler plus the modal flag so the dispatcher
  // can detect "modal-declared command returned without calling
  // sendModal" — that scenario is silent-fail (Discord's 3-s window
  // expires and the user sees "interaction failed" with no bot-side
  // trace). We surface it as a warn-level log.
  const commandMap = new Map<
    string,
    {
      handler: PluginCommandDefinition["handler"];
      modal: boolean;
      /**
       * Per-command default for `CommandReply.ephemeral` when the
       * handler returns a plain string or an object without explicit
       * `ephemeral`. Matches the bot's defer choice (the bot also reads
       * `default_ephemeral` from the manifest at dispatch time), so a
       * matching command stays on the happy "PATCH @original" path
       * without the plugin author having to wrap every return in
       * `{ content, ephemeral: true }`. Defaults to `true` when
       * omitted — same as the bot's defer default.
       */
      defaultEphemeral: boolean;
    }
  >(
    (opts.pluginCommands ?? []).map((cmd) => [
      cmd.name,
      {
        handler: cmd.handler,
        modal: cmd.modal ?? false,
        defaultEphemeral: cmd.defaultEphemeral ?? true,
      },
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

  // Shared refusal for every bot-dispatched route while the register
  // handshake hasn't completed (no dispatch HMAC key yet). The warn
  // names the state explicitly: the 2026-06-11 incident showed up
  // plugin-side as bare 503 statusCode lines with no hint that the
  // plugin had been waiting on its register response the whole time.
  const refuseUnregistered = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): FastifyReply => {
    request.log.warn(
      { path: request.url },
      "dispatch refused: register handshake not completed (no dispatch HMAC key yet) — still waiting on /api/plugins/register? check earlier register/timeout logs",
    );
    return reply.code(503).send({
      error: "dispatch HMAC key not available; plugin must re-register",
    });
  };
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

  // Discord-side event dispatch. Only mounted when the plugin declared
  // at least one entry in `eventHandlers`. HMAC-verified with the same
  // dispatch key as /commands, /components, /modals, /_kc/lifecycle —
  // the bot signs every outbound event POST with this key.
  //
  // The SDK owns this route so plugins don't re-implement HMAC
  // verification per-plugin. Older plugins (e.g. xiangqi) used to
  // mount their own /events; a future transport swap (e.g. Redis
  // Streams) stays opaque from the plugin side as long as handlers
  // live here.
  if (opts.hasEventHandlers && opts.dispatchEvent) {
    server.post(
      "/events",
      async (request: FastifyRequest, reply: FastifyReply) => {
        const signingKey = opts.getDispatchHmacKey?.() ?? null;
        if (!signingKey) return refuseUnregistered(request, reply);
        const rawBody = typeof request.body === "string" ? request.body : "";
        const auth = verifyDispatchAuth(request, rawBody, signingKey);
        if (!auth.ok) return reply.code(401).send({ error: auth.reason });
        let payload: { type: unknown; data?: unknown };
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return reply.code(400).send({ error: "invalid JSON" });
        }
        if (typeof payload.type !== "string" || payload.type.length === 0) {
          return reply.code(400).send({ error: "missing event type" });
        }
        // ACK before running the handler so the bot's per-event
        // dispatch timeout (~5 s) never bites a slow handler. Handler
        // errors are caught and surfaced via `ctx.log` only.
        reply.code(204).send();
        try {
          await opts.dispatchEvent!(payload.type, payload.data ?? {});
        } catch (err) {
          server.log.error(
            { err, type: payload.type },
            "event handler threw",
          );
        }
      },
    );
  }

  // Lifecycle dispatch. Only mounted when the plugin declared onEnable
  // or onDisable. HMAC-verified like /commands and /components — the
  // bot signs every POST with the per-plugin dispatch key.
  if (opts.hasLifecycleHandler && opts.dispatchLifecycle) {
    server.post(
      "/_kc/lifecycle",
      async (request: FastifyRequest, reply: FastifyReply) => {
        const signingKey = opts.getDispatchHmacKey?.() ?? null;
        if (!signingKey) return refuseUnregistered(request, reply);
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
      if (!signingKey) return refuseUnregistered(request, reply);
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
        //  - regular command: bot deferred → user sees the message
        //  - modal:true command: bot didn't defer → call 404s,
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
      const {
        handler,
        modal: commandIsModal,
        defaultEphemeral: commandDefaultEphemeral,
      } = entry;

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

      const callRpc = (path: string, body?: unknown) =>
        callBotRpc(server.log, opts.botUrl, token, path, body);
      const rpc = createPluginRpc(callRpc);
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
        locale: payload.locale ?? null,
        guildLocale: payload.guild_locale ?? null,
        log: {
          info: (msg, meta) => server.log.info(meta ?? {}, msg),
          warn: (msg, meta) => server.log.warn(meta ?? {}, msg),
          error: (msg, meta) => server.log.error(meta ?? {}, msg),
        },
        botRpc: callRpc,
        discord: rpc.discord,
        voice: rpc.voice,
        me: rpc.me,
        kv: rpc.kv,
        auth: rpc.auth,
        async sendModal(modal: ModalData): Promise<boolean> {
          // The command must have declared `modal: true` in its
          // manifest so the bot skipped its defer. If it did defer,
          // this call will 4xx — Discord rejects modal-after-ack — and
          // we surface that as `false`.
          //
          // We deliberately don't forward application_id; the bot has
          // its own bot.application.id available and uses that for
          // the REST callback. Forwarding a plugin-supplied id would
          // suggest the bot honours it (it doesn't).
          // callBotRpc resolves to an object on success and THROWS a
          // BotRpcError on any non-2xx (it never returns null). The bot
          // rejects a modal whose interaction already expired / was
          // deferred with a 4xx — surface that as `false` (the documented
          // contract) instead of letting it propagate as a throw, which
          // would skip the handler's post-sendModal code AND log a
          // misleading "command handler threw" error for an expected,
          // recoverable case (common during a bot restart).
          try {
            await callBotRpc(
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
            modalSent = true;
            return true;
          } catch (err) {
            server.log.warn(
              { err, commandName: payload.command_name },
              "sendModal failed — interaction likely expired or deferred",
            );
            return false;
          }
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
        if (commandIsModal) {
          // Handler returned without opening a modal even though the
          // manifest declared `modal: true`. The bot did NOT defer
          // (Discord rejects modal-after-defer), so calling
          // interactions.respond below would 404. Surface the misuse
          // as a warning rather than letting Discord just time out.
          server.log.warn(
            { commandName: payload.command_name },
            "command declares modal:true but handler returned without calling ctx.sendModal — interaction will expire",
          );
          return;
        }
        const { content, ephemeral, embeds, components, attachments, flags } =
          normalizeReply(rawReply, commandDefaultEphemeral);
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
        //  - the command declared modal:true so the bot didn't defer;
        //    respond would 404 against the dead token
        if (!modalSent && !commandIsModal) {
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
      if (!signingKey) return refuseUnregistered(request, reply);
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

      // Followup is called from catch handlers (component error paths)
      // where a thrown BotRpcError would itself bubble up and obscure
      // the original handler error. Suppress; the underlying server.log
      // already records the failure from inside callBotRpc.
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
        ).catch(() => null);

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
      const callRpc = (path: string, body?: unknown) =>
        callBotRpc(server.log, opts.botUrl, token, path, body);
      const rpc = createPluginRpc(callRpc);
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
        botRpc: callRpc,
        discord: rpc.discord,
        voice: rpc.voice,
        me: rpc.me,
        kv: rpc.kv,
        auth: rpc.auth,
        locale: payload.locale ?? null,
        guildLocale: payload.guild_locale ?? null,
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
      if (!signingKey) return refuseUnregistered(request, reply);
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
        locale: payload.locale ?? null,
        guildLocale: payload.guild_locale ?? null,
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
  // the deferred message. Modal replies are ALWAYS ephemeral — see
  // ModalReply doc in types.ts: Discord locks ephemerality at defer
  // time and modals are unconditionally deferred ephemeral, so
  // flipping `flags` here is silently ignored.
  server.post<{ Params: { modalId: string } }>(
    "/modals/:modalId",
    async (request, reply) => {
      const signingKey = opts.getDispatchHmacKey?.() ?? null;
      if (!signingKey) return refuseUnregistered(request, reply);
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
      const callRpc = (path: string, body?: unknown) =>
        callBotRpc(server.log, opts.botUrl, token, path, body);
      const rpc = createPluginRpc(callRpc);
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
        botRpc: callRpc,
        discord: rpc.discord,
        voice: rpc.voice,
        me: rpc.me,
        kv: rpc.kv,
        auth: rpc.auth,
        locale: payload.locale ?? null,
        guildLocale: payload.guild_locale ?? null,
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
