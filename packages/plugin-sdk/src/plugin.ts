import type { FastifyInstance } from "fastify";
import type {
  CommandContext,
  CommandOption,
  CommandReply,
  ComponentContext,
  ComponentReply,
  InteractionContext,
} from "./types.js";
import type { ManifestConfigField } from "./manifest.js";

// ── 共用型別 ─────────────────────────────────────────────────────────────────

/**
 * Returned by plugin.start().
 * Provides an escape hatch for integration tests and advanced use cases
 * that need direct access to the underlying Fastify instance.
 */
export interface StartedPlugin {
  /** The underlying Fastify server instance. */
  server: FastifyInstance;
  /** Gracefully stops both the HTTP server and the plugin lifecycle client. */
  stop(): Promise<void>;
  /** Returns the bound address string, e.g. "http://127.0.0.1:3000". */
  address(): string;
  /**
   * Call a bot-side plugin RPC endpoint outside of a command handler
   * (e.g. from a background interval). Returns null if the plugin has
   * not yet completed its first register call (no token), or on
   * network / non-2xx errors (already logged).
   */
  botRpc(path: string, body?: unknown): Promise<unknown | null>;
  /**
   * Ed25519 public key (SPKI PEM) the bot returned at register, used to
   * verify `plugin-session` JWTs offline (see `verifyPluginSession`).
   * Null until the first successful register. Plugins that expose a
   * WebUI typically wire this into their session-auth layer after
   * `start()` resolves (the lifecycle client doesn't exist during
   * `onReady`).
   */
  getSessionVerifyPublicKey(): string | null;
  /**
   * Browser-reachable base URL the bot exposes for this plugin's HTTP
   * surface (i.e. `<bot>/plugin/<key>`). Undefined until the first
   * successful register and only when the bot has `WEB_BASE_URL`
   * configured. Supersedes a manually-set public-URL env on the plugin
   * side — prefer this over a hard-coded env when the plugin is accessed
   * through the bot proxy.
   */
  getPublicBaseUrl(): string | undefined;
  /**
   * Per-plugin HMAC key the bot uses to sign all outbound dispatches
   * (`/commands`, `/components`, and any plugin-mounted event/webhook
   * endpoints). Null until the first successful register. Plugins that
   * mount their own `/events` route (e.g. to consume
   * `guild.message_create`) need this to verify the HMAC headers — the
   * SDK only auto-verifies its own built-in `/commands` + `/components`
   * routes.
   */
  getDispatchHmacKey(): string | null;
}

/** Options passed to plugin.start() — all optional; fall back to env vars. */
export interface StartOptions {
  port?: number;
  host?: string;
  botUrl?: string;
  setupSecret?: string;
  pluginUrl?: string;
}

/**
 * 軌三：Plugin 自訂指令定義（含 handler）。
 * 三軸（scope/integrationTypes/contexts）在此寫死，SDK 生成 manifest 時
 * 原樣輸出；bot 端不接受 admin patch 這三個欄位。
 */
export interface PluginCommandDefinition {
  /** Discord slash command name，格式 [a-z0-9][a-z0-9-]{0,31}。 */
  name: string;
  /** 指令說明文字。必填且必須是非空字串。 */
  description: string;
  /** 三軸：manifest 寫死，admin 不可改。 */
  scope: "guild" | "global";
  integrationTypes: Array<"guild_install" | "user_install">;
  contexts: InteractionContext[];
  options?: CommandOption[];
  defaultMemberPermissions?: string;
  defaultEphemeral?: boolean;
  requiredCapability?: string;
  handler: (ctx: CommandContext) => CommandReply | Promise<CommandReply>;
}

/**
 * Plugin 元件（按鈕）handler 定義。
 *
 * Plugin 在它送出的訊息上掛 Discord 按鈕，`custom_id` 形如
 * `kc:<pluginKey>:<id>`（可再帶 `:<tail>` 夾參數）—— 用
 * `componentCustomId()` 建。使用者點擊時 bot 先 `deferUpdate()` ack，
 * 再把點擊 POST 到此 plugin 的 `/components` 端點；對應 `id` 的 handler
 * 被呼叫。component interaction 每次點擊都是全新的 interaction（含新的
 * 15 分鐘 token），所以按鈕在訊息存在期間一直有效。
 */
export interface PluginComponentDefinition {
  /**
   * 元件 id（plugin 內唯一），格式 [a-z0-9][a-z0-9._-]*。會被嵌進
   * `custom_id` —— `kc:` + pluginKey + `:` + id（+ 可選 `:tail`）必須
   * ≤ 100 字（Discord 上限），所以 id + tail 加起來別太長。
   */
  id: string;
  handler: (ctx: ComponentContext) => ComponentReply | Promise<ComponentReply>;
}

/**
 * Plugin 自身需要的 RBAC capability 宣告。
 *
 * Plugin 在 manifest 宣告它需要哪些自訂權限詞條（例如 WebUI 存取、
 * 某個敏感操作）。bot 端在 register 時持久化，並在 admin 的「身分組
 * 權限」modal 開一個專屬此 plugin 的分頁，讓 admin 把這些詞條賦予
 * 身分組。plugin 移除時這些詞條也一併從所有身分組清除。
 *
 * 實際存進 bot 的 token 形式為 `plugin:<pluginKey>:<key>`，例如
 * `plugin:karyl-radio:webui.access`。plugin 收到的 plugin-session JWT
 * 會帶 `capabilities` claim（使用者持有的 `plugin:*` + `admin` 子集），
 * plugin 自行離線判斷是否放行。
 */
export interface PluginCapabilityDefinition {
  /** 詞條 key（plugin 內唯一），格式 [a-z0-9][a-z0-9._-]*，例如 `webui.access`。 */
  key: string;
  /** 給 admin 看的說明文字（非空）。 */
  description: string;
}

/**
 * 軌一：Guild Feature 定義。
 *
 * 一個 feature 是「bot admin 可以逐 guild 開關」的單位。`enabledByDefault`
 * 控制一個 guild 沒明確設定時的預設（false = 預設關，admin 自己挑 guild 開）。
 * Feature 的 `commands[]` 是 guild-scoped slash 指令：bot 只在啟用該 feature
 * 的 guild 把它們註冊給 Discord，呼叫時和一般 pluginCommands 走同一條
 * `/commands/{command_name}` 派送路徑 —— 所以這些指令**要帶 handler**（SDK
 * 在 `start()` 時把它們併進指令 map；manifest 那邊照樣只輸出 metadata 不含
 * handler）。
 */
export interface GuildFeatureDefinition {
  key: string;
  name: string;
  icon?: string;
  description?: string;
  enabledByDefault?: boolean;
  eventsSubscribed?: string[];
  configSchema?: ManifestConfigField[];
  surfaces?: string[];
  overviewMetrics?: Array<{ key: string; label: string; type: string }>;
  /** This feature's guild-scoped slash commands (with handlers — see above). */
  commands?: PluginCommandDefinition[];
}

/** Plugin config，傳入 definePlugin。 */
export interface PluginConfig {
  key: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  /**
   * Scopes the plugin will exercise against the bot's `/api/plugin/*`
   * RPC surface. The bot mints plugin tokens with exactly these scopes
   * (subject to admin approval / auto-approve); a call to any
   * `/api/plugin/*` endpoint not listed here 403s with
   * `plugin token missing scope '<name>'`.
   *
   * Common scopes:
   *   "interactions.respond"      — return a reply from a command handler
   *   "interactions.followup"     — post follow-up messages
   *   "messages.send"             — send guild channel messages
   *   "messages.send_dm"          — DM a user
   *   "messages.delete" / "messages.edit" / "messages.add_reaction"
   *   "auth.session"              — mint plugin-session JWTs (link tokens)
   *   "members.get"               — resolve guild-member displayName+avatar
   *   "users.get"                 — resolve global Discord user profile
   *                                  (works without a guild — use this
   *                                  for DM / user-install / private-
   *                                  channel surfaces where members.get
   *                                  can't apply)
   *   "config.get" / "config.set" — admin-configurable plugin config
   *   "storage.kv_*"              — guild-scoped KV storage
   */
  rpcMethodsUsed: string[];
  storage?: {
    guildKv?: boolean;
    guildKvQuotaKb?: number;
    requiresSecrets?: boolean;
  };
  configSchema?: ManifestConfigField[];

  /** 軌三：plugin 自訂指令（三軸寫死）。 */
  pluginCommands?: PluginCommandDefinition[];

  /** 軌一：guild feature 定義。 */
  guildFeatures?: GuildFeatureDefinition[];

  /**
   * Plugin 元件（按鈕）handler。宣告任一條時，manifest 會帶
   * `endpoints.plugin_component = "/components"`，SDK 掛上對應路由，bot
   * 才會把 `kc:<thisKey>:…` 的按鈕點擊派送過來。
   */
  components?: PluginComponentDefinition[];

  /**
   * 此 plugin 需要的 RBAC capability 詞條。bot 端在 register 時持久化，
   * 並在 admin「身分組權限」modal 開專屬分頁；plugin 移除時一併清除。
   */
  capabilities?: PluginCapabilityDefinition[];

  /**
   * Optional hook called once the SDK has wired its routes but BEFORE
   * `server.listen()`. Use this to register additional Fastify routes.
   */
  onReady?: (server: FastifyInstance) => void | Promise<void>;
}

/** The object returned by definePlugin. */
export interface PluginInstance {
  readonly config: PluginConfig;
  start(opts?: StartOptions): Promise<StartedPlugin>;
}

/** 定義一條 plugin 自訂指令（軌三）。回傳定義物件不變（類型化建構子）。 */
export function definePluginCommand(
  def: PluginCommandDefinition,
): PluginCommandDefinition {
  if (
    typeof def.name !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,31}$/.test(def.name)
  ) {
    throw new Error(
      `definePluginCommand: name "${String(def.name)}" must match [a-z0-9][a-z0-9-]{0,31}`,
    );
  }
  if (
    typeof def.description !== "string" ||
    def.description.trim().length === 0
  ) {
    throw new Error(
      `definePluginCommand: '${def.name}'.description must be a non-empty string`,
    );
  }
  return def;
}

/** 元件 id 格式（plugin 內唯一）：[a-z0-9][a-z0-9._-]* */
const COMPONENT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * 定義一個 plugin 元件（按鈕）handler。回傳定義物件不變（類型化建構子）。
 * `id` 格式在 build 時就驗，避免等 bot dispatch 才出錯。
 */
export function definePluginComponent(
  def: PluginComponentDefinition,
): PluginComponentDefinition {
  if (typeof def.id !== "string" || !COMPONENT_ID_RE.test(def.id)) {
    throw new Error(
      `definePluginComponent: id "${String(def.id)}" must match [a-z0-9][a-z0-9._-]*`,
    );
  }
  if (typeof def.handler !== "function") {
    throw new Error(`definePluginComponent: '${def.id}'.handler must be a function`);
  }
  return def;
}

/**
 * Build the Discord `custom_id` for one of this plugin's button
 * components: `kc:<pluginKey>:<id>` (+ `:<tail>` when args are passed).
 * The result must be ≤ 100 chars (Discord's limit) — keep ids short and
 * tails small. The matching `definePluginComponent({ id })` handler is
 * invoked when the button is clicked.
 */
export function componentCustomId(
  pluginKey: string,
  id: string,
  tail?: string,
): string {
  const cid = `kc:${pluginKey}:${id}${tail !== undefined && tail !== "" ? `:${tail}` : ""}`;
  if (cid.length > 100) {
    throw new Error(
      `componentCustomId: "${cid}" exceeds Discord's 100-char custom_id limit`,
    );
  }
  return cid;
}

/**
 * 定義一個 guild feature（軌一）。回傳定義物件不變（類型化建構子）。
 * `key` 格式 [a-z0-9][a-z0-9._-]*（plugin 內唯一），在 build 時就驗，
 * 避免等 bot register 才被 4xx 拒絕。
 */
export function defineGuildFeature(
  def: GuildFeatureDefinition,
): GuildFeatureDefinition {
  if (typeof def.key !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(def.key)) {
    throw new Error(
      `defineGuildFeature: key "${String(def.key)}" must match [a-z0-9][a-z0-9._-]*`,
    );
  }
  if (typeof def.name !== "string" || def.name.trim().length === 0) {
    throw new Error(`defineGuildFeature: '${def.key}'.name must be non-empty`);
  }
  return def;
}

/**
 * 定義一個 plugin capability 詞條。回傳定義物件不變（類型化建構子）。
 * 在此先做格式驗證，讓 plugin 作者在 build 時就拿到錯誤，而不是等 bot
 * register 才被 4xx 拒絕（bot 端 validateManifest 規則的鏡像）。
 */
export function definePluginCapability(
  def: PluginCapabilityDefinition,
): PluginCapabilityDefinition {
  if (typeof def.key !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(def.key)) {
    throw new Error(
      `definePluginCapability: key "${String(def.key)}" must match [a-z0-9][a-z0-9._-]*`,
    );
  }
  if (
    typeof def.description !== "string" ||
    def.description.trim().length === 0 ||
    def.description.length > 200
  ) {
    throw new Error(
      `definePluginCapability: '${def.key}'.description must be a non-empty string ≤200 chars`,
    );
  }
  return def;
}

/**
 * Define a plugin. Returns a PluginInstance whose `start()` method:
 * 1. Builds a Fastify server with HMAC-verified /commands/:commandName dispatch
 * 2. Starts listening on PORT/HOST (env or StartOptions)
 * 3. If KARYL_PLUGIN_SETUP_SECRET is set, starts the register+heartbeat lifecycle
 * 4. Registers SIGTERM/SIGINT handlers for graceful shutdown
 * 5. Returns a StartedPlugin for integration-test access and graceful shutdown
 *
 * PLUGIN_URL default is `http://${config.key}:3000` — assumes docker hostname
 * matches config.key. Production deployments should set PLUGIN_URL explicitly.
 */
export function definePlugin(config: PluginConfig): PluginInstance {
  // Command names must be unique across pluginCommands AND every
  // guildFeatures[].commands[] — they all share one /commands/:name
  // dispatch map, and feature commands also get registered with Discord.
  const seen = new Set<string>();
  for (const cmd of [
    ...(config.pluginCommands ?? []),
    ...(config.guildFeatures ?? []).flatMap((f) => f.commands ?? []),
  ]) {
    if (seen.has(cmd.name)) {
      throw new Error(
        `definePlugin: duplicate command name "${cmd.name}" (across pluginCommands / guildFeatures.commands)`,
      );
    }
    seen.add(cmd.name);
  }
  const seenComponents = new Set<string>();
  for (const c of config.components ?? []) {
    if (seenComponents.has(c.id)) {
      throw new Error(`definePlugin: duplicate component id "${c.id}"`);
    }
    seenComponents.add(c.id);
  }
  return {
    config,
    async start(opts?: StartOptions): Promise<StartedPlugin> {
      // Defer imports so SDK users that only use the type layer don't
      // pay the Fastify startup cost at import time.
      const { createPluginServer, callBotRpc } = await import("./server.js");
      const { startPluginClient } = await import("./client.js");
      const { buildManifest } = await import("./manifest-builder.js");

      const port =
        opts?.port ?? Number.parseInt(process.env.PORT ?? "3000", 10);
      const host = opts?.host ?? process.env.HOST ?? "0.0.0.0";
      const botUrl = (
        opts?.botUrl ??
        process.env.BOT_URL ??
        "http://karyl-chan:3000"
      ).replace(/\/+$/, "");
      const setupSecret =
        opts?.setupSecret ?? process.env.KARYL_PLUGIN_SETUP_SECRET;
      const pluginUrl = (
        opts?.pluginUrl ??
        process.env.PLUGIN_URL ??
        `http://${config.key}:3000`
      ).replace(/\/+$/, "");

      let client: ReturnType<typeof startPluginClient> | null = null;

      const server = createPluginServer({
        pluginKey: config.key,
        botUrl,
        // Guild-feature commands are dispatched on the same
        // /commands/{command_name} path as top-level pluginCommands, so
        // their handlers go into the same map. (The manifest builder
        // outputs guild_features[].commands[] without handlers.)
        pluginCommands: [
          ...(config.pluginCommands ?? []),
          ...(config.guildFeatures ?? []).flatMap((f) => f.commands ?? []),
        ],
        components: config.components ?? [],
        getToken: () => client?.token() ?? null,
        getDispatchHmacKey: () => client?.getDispatchHmacKey() ?? null,
        getPublicBaseUrl: () => client?.getPublicBaseUrl(),
      });

      await config.onReady?.(server);
      await server.listen({ port, host });

      server.log.info(
        { port, botUrl, pluginSigningEnabled: !!setupSecret?.trim() },
        `${config.key} plugin listening`,
      );

      if (setupSecret && setupSecret.trim().length > 0) {
        const manifest = buildManifest(config, pluginUrl);
        client = startPluginClient({
          botUrl,
          setupSecret,
          manifest,
          logger: {
            info: (msg, meta) => server.log.info(meta ?? {}, msg),
            warn: (msg, meta) => server.log.warn(meta ?? {}, msg),
            error: (msg, meta) => server.log.error(meta ?? {}, msg),
          },
        });
      } else {
        server.log.warn(
          "KARYL_PLUGIN_SETUP_SECRET not set — will not register with bot",
        );
      }

      const started: StartedPlugin = {
        server,
        async stop(): Promise<void> {
          client?.stop();
          try {
            await server.close();
          } catch {
            /* ignore close errors during shutdown */
          }
        },
        address(): string {
          return (
            server
              .addresses()
              .map((a) => `http://${a.address}:${a.port}`)[0] ??
            `http://${host}:${port}`
          );
        },
        async botRpc(path: string, body?: unknown) {
          const token = client?.token() ?? null;
          if (!token) return null;
          return callBotRpc(server.log, botUrl, token, path, body);
        },
        getSessionVerifyPublicKey() {
          return client?.getSessionVerifyPublicKey() ?? null;
        },
        getPublicBaseUrl() {
          return client?.getPublicBaseUrl();
        },
        getDispatchHmacKey() {
          return client?.getDispatchHmacKey() ?? null;
        },
      };

      for (const sig of ["SIGTERM", "SIGINT"] as const) {
        process.on(sig, async () => {
          await started.stop();
          process.exit(0);
        });
      }

      return started;
    },
  };
}
