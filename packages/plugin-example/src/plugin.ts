/**
 * @karyl-chan/plugin-example — reference plugin.
 *
 * Demonstrates the three canonical karyl-chan plugin webui shapes
 * behind a single guild feature `example`. Admins enable the feature
 * per guild; then five slash commands appear:
 *
 *   /example-manage   — admin/manage UI (manage-capability-gated)
 *   /example-chat     — user-bound stateful webui synced with the
 *                       invoking Discord channel (bidirectional via
 *                       SSE + the feature's MESSAGE_CREATE event
 *                       subscription)
 *   /example-sticky   — user-bound webui ↔ persisted KV state
 *                       (no Discord push, just per-user storage)
 *   /example-showcase — every @karyl-chan/ui component on display
 *                       (manage-gated; not unauthenticated content)
 *   /example-bench    — UI stress / boundary test page (manage-gated)
 *
 * All five use the same shape: ask the bot for a plugin-session JWT,
 * return a Discord link button. The SPA at the link end inspects the
 * JWT and the `?surface=` URL param to pick which view to mount.
 *
 * The feature subscribes to `MESSAGE_CREATE` so plain-text Discord
 * messages in any channel of an enabled guild fan out to /example-chat
 * SPA subscribers on that channel — the bidirectional half of the demo.
 */

import {
  definePlugin,
  defineGuildFeature,
  definePluginCapability,
  definePluginCommand,
  Events,
  type CommandContext,
  type CommandReply,
  type MetricsCounter,
  type PluginContext,
} from "@karyl-chan/plugin-sdk";
import {
  registerWebRoutes,
  setBotRpc,
  setSessionVerifyKey,
  setPublicBaseUrl,
} from "./web-routes.js";
import { publish, type ChatEvent } from "./chat-state.js";

const PLUGIN_KEY = "karyl-example";
const FEATURE_KEY = "example";
const MANAGE_CAP = "manage";

// Workpack C: module-level metric handles, populated by `onStart` once
// the PluginContext is available. Command handlers below increment
// `commandCounter` so the admin UI metrics panel renders a non-zero
// counter without the plugin author hand-wiring metric exposition.
let startupCounter: MetricsCounter | null = null;
let commandCounter: MetricsCounter | null = null;

function buildSpaLink(
  publicBaseUrl: string,
  token: string,
  extras: Record<string, string> = {},
): string {
  const u = new URL(publicBaseUrl.replace(/\/+$/, "") + "/");
  u.searchParams.set("token", token);
  for (const [k, v] of Object.entries(extras)) u.searchParams.set(k, v);
  return u.toString();
}

async function withSessionLink(
  ctx: CommandContext,
  kind: "session" | "manage",
  buildLink: (publicBaseUrl: string, token: string) => string,
  noPermissionLabel: string,
): Promise<CommandReply> {
  // Workpack C: tick the per-invocation counter on every command. The
  // counter is created once in `onStart` and shared across every command
  // handler; null-guard covers the brief window before the SDK has
  // populated the PluginContext (very-early invocation before register).
  commandCounter?.inc();
  if (!ctx.publicBaseUrl) {
    return {
      content:
        "Bot is missing WEB_BASE_URL — ask an admin to configure it before retrying.",
      ephemeral: true,
    };
  }
  if (!ctx.guildId) {
    return {
      content: "This command must be used inside a server.",
      ephemeral: true,
    };
  }
  const session = await ctx.auth.mintSession({
    userId: ctx.userId,
    guildId: ctx.guildId,
    kind,
  });
  if (!session.allowed) {
    return { content: noPermissionLabel, ephemeral: true };
  }
  return {
    content: " ",
    ephemeral: true,
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "Open WebUI",
            url: buildLink(ctx.publicBaseUrl, session.token),
          },
        ],
      },
    ],
  };
}

const manageCommand = definePluginCommand({
  name: "example-manage",
  description: "Open the example plugin's admin / manage UI",
  scope: "guild",
  integrationTypes: ["guild_install"],
  contexts: ["Guild"],
  requiredCapability: MANAGE_CAP,
  defaultEphemeral: true,
  async handler(ctx) {
    return withSessionLink(
      ctx,
      "manage",
      (base, token) => buildSpaLink(base, token, { surface: "manage" }),
      `You need plugin:${PLUGIN_KEY}:${MANAGE_CAP} to open the manage UI. Ask an admin.`,
    );
  },
});

const chatCommand = definePluginCommand({
  name: "example-chat",
  description: "Open a webui that mirrors this channel's chat in real time",
  scope: "guild",
  integrationTypes: ["guild_install"],
  contexts: ["Guild"],
  defaultEphemeral: true,
  async handler(ctx) {
    if (!ctx.channelId) {
      return {
        content: "This command must be invoked inside a channel.",
        ephemeral: true,
      };
    }
    return withSessionLink(
      ctx,
      "session",
      (base, token) =>
        buildSpaLink(base, token, { surface: "chat", c: ctx.channelId! }),
      "Couldn't mint a session token (server may be unavailable).",
    );
  },
});

const stickyCommand = definePluginCommand({
  name: "example-sticky",
  description: "Open your personal sticky-note for this server",
  scope: "guild",
  integrationTypes: ["guild_install"],
  contexts: ["Guild"],
  defaultEphemeral: true,
  async handler(ctx) {
    return withSessionLink(
      ctx,
      "session",
      (base, token) => buildSpaLink(base, token, { surface: "sticky" }),
      "Couldn't mint a session token.",
    );
  },
});

const showcaseCommand = definePluginCommand({
  name: "example-showcase",
  description: "Browse every @karyl-chan/ui component (admins only)",
  scope: "guild",
  integrationTypes: ["guild_install"],
  contexts: ["Guild"],
  requiredCapability: MANAGE_CAP,
  defaultEphemeral: true,
  async handler(ctx) {
    return withSessionLink(
      ctx,
      "manage",
      (base, token) => buildSpaLink(base, token, { surface: "showcase" }),
      `You need plugin:${PLUGIN_KEY}:${MANAGE_CAP} to open the showcase.`,
    );
  },
});

const benchCommand = definePluginCommand({
  name: "example-bench",
  description: "Open the UI stress-test page (admins only)",
  scope: "guild",
  integrationTypes: ["guild_install"],
  contexts: ["Guild"],
  requiredCapability: MANAGE_CAP,
  defaultEphemeral: true,
  async handler(ctx) {
    return withSessionLink(
      ctx,
      "manage",
      (base, token) => buildSpaLink(base, token, { surface: "bench" }),
      `You need plugin:${PLUGIN_KEY}:${MANAGE_CAP} to open the bench.`,
    );
  },
});

const exampleFeature = defineGuildFeature({
  key: FEATURE_KEY,
  name: "Example",
  description:
    "Reference feature: manage UI, user-bound chat webui, sticky notes, component showcase.",
  enabledByDefault: false,
  // Subscribe to plain-text messages so /example-chat's webui can
  // mirror Discord-side replies live. Bot delivers events to /events
  // (HMAC-signed by the SDK); the actual handler is wired below via
  // `definePlugin.eventHandlers` so the SDK owns dispatch + HMAC and
  // we don't roll our own /events route.
  eventsSubscribed: [Events.GuildMessageCreate],
  commands: [
    manageCommand,
    chatCommand,
    stickyCommand,
    showcaseCommand,
    benchCommand,
  ],
});

export const plugin = definePlugin({
  key: PLUGIN_KEY,
  name: "Karyl Example",
  version: "0.1.0",
  description:
    "Reference plugin demonstrating manage UI, user-bound chat, sticky notes, and component showcase.",

  rpcMethodsUsed: [
    // `interactions.respond` / `interactions.followup` / `me.log` /
    // `me.metrics` are auto-derived by the manifest builder (one
    // command ⇒ those scopes are guaranteed needed). We list the rest
    // that the auto-deriver can't see from declarative signals:
    "auth.session",
    "messages.send",
    // members.get gives us per-guild nickname + per-guild avatar
    // overrides when the surface has a guild context.
    "members.get",
    // users.get is the guildless companion — used for /api/me's
    // no-guild fallback (DM / private-channel / user-install) and
    // for the showcase's richer UserCard (banner + accent + username).
    "users.get",
  ],

  capabilities: [
    definePluginCapability({
      key: MANAGE_CAP,
      description: "Open the example plugin's manage / showcase / bench UIs.",
    }),
  ],

  guildFeatures: [exampleFeature],

  // Workpack C demonstration —
  // Lifecycle: onStart fires after register, onStop on SIGTERM. Both
  // get a PluginContext with structured logger / botEventLog / metrics
  // accessors so this plugin participates in the admin UI's observability
  // panel without bespoke RPC plumbing.
  async onStart(ctx: PluginContext): Promise<void> {
    startupCounter = ctx.metrics.counter("example_starts_total");
    commandCounter = ctx.metrics.counter("example_commands_total", {
      kind: "any",
    });
    startupCounter.inc();
    ctx.botEventLog.emit({
      level: "info",
      message: "plugin started",
      eventKey: "started",
    });
  },
  async onStop(ctx: PluginContext): Promise<void> {
    ctx.botEventLog.emit({
      level: "info",
      message: "plugin shutting down",
      eventKey: "stopping",
    });
  },
  async onEnable(ctx: PluginContext, guildId: string): Promise<void> {
    ctx.botEventLog.emit({
      level: "info",
      message: `example feature enabled in guild ${guildId}`,
      context: { guildId },
    });
  },
  async onDisable(ctx: PluginContext, guildId: string): Promise<void> {
    ctx.botEventLog.emit({
      level: "info",
      message: `example feature disabled in guild ${guildId}`,
      context: { guildId },
    });
  },
  // Health producer — the bot polls /health/detail every 60 s. Simple
  // example: report healthy unconditionally with the count of /example-*
  // commands invoked since startup as additional context.
  async healthCheck(): Promise<{ status: "healthy"; message: string }> {
    return {
      status: "healthy",
      message: "example plugin nominal",
    };
  },

  // Discord → WebUI message relay. The bot signs every outbound
  // dispatch with the plugin's HMAC key; the SDK auto-mounts
  // `/events`, verifies the HMAC, parses the envelope, and routes by
  // `type` to the handler keyed by `Events.GuildMessageCreate`. The
  // plugin doesn't roll its own `/events` route, doesn't re-verify
  // HMAC, and can't accidentally subscribe to a non-canonical name —
  // the build-time check warns on dead subscriptions.
  eventHandlers: {
    [Events.GuildMessageCreate]: async (_ctx, raw) => {
      const data = raw as
        | {
            channel_id?: string;
            author?: {
              id?: string;
              username?: string;
              global_name?: string;
              bot?: boolean;
            };
            content?: string;
          }
        | undefined;
      if (
        !data?.channel_id ||
        !data?.author?.id ||
        typeof data.content !== "string" ||
        data.author.bot
      ) {
        return;
      }
      const event: ChatEvent = {
        ts: Date.now(),
        source: "discord",
        authorId: data.author.id,
        authorName:
          data.author.global_name || data.author.username || data.author.id,
        content: data.content,
      };
      publish(data.channel_id, event);
    },
  },

  async onReady(server) {
    await registerWebRoutes(server, PLUGIN_KEY, MANAGE_CAP);
  },
});

/**
 * Wire deferred getters from the started plugin into web-routes.
 * Plugin start() resolves with the lifecycle client; until then the
 * register-only values (session-verify key, bot RPC, public base URL)
 * aren't available. plugin.ts → index.ts pattern, same as radio.
 */
export function wireStarted(started: {
  botRpc: (path: string, body?: unknown) => Promise<unknown | null>;
  getSessionVerifyPublicKey: () => string | null;
  getPublicBaseUrl: () => string | undefined;
}): void {
  setBotRpc((path, body) => started.botRpc(path, body));
  setSessionVerifyKey(started.getSessionVerifyPublicKey);
  setPublicBaseUrl(started.getPublicBaseUrl);
}
