import type { FastifyInstance } from "fastify";
import type { Client } from "discord.js";
import { config } from "../../config.js";
import { getVerificationKeys } from "../../utils/secrets.js";
import { requireAnyCapability } from "./route-guards.js";
import { avatarUrlFor } from "./message-mapper.js";
import type { DmInboxStore } from "../dm-inbox/dm-inbox.service.js";
import type { CommandReconciler } from "../command-system/reconcile.service.js";

import { registerDmRoutes } from "../dm-inbox/dm-routes.js";
import { registerDiscordRoutes } from "./discord-routes.js";
import { registerGuildsRoutes } from "../guild-management/guilds-routes.js";
import { registerGuildChannelRoutes } from "../guild-management/guild-channel-routes.js";
import { registerGuildManagementRoutes } from "../guild-management/guild-management-routes.js";
import { registerSystemRoutes } from "./system-routes.js";
import { registerAdminManagementRoutes } from "../admin/admin-management-routes.js";
import { registerAdminLoginStatusRoutes } from "../admin/admin-login-status-routes.js";
import { registerAdminSystemSettingsRoutes } from "../admin/admin-system-settings-routes.js";
import { registerBotEventRoutes } from "../bot-events/bot-event-routes.js";
import { registerBehaviorRoutes } from "../behavior/behavior-routes.js";
import { registerScopeTabRoutes } from "../behavior/scope-tab-routes.js";
import { registerPluginRoutes } from "../plugin-system/plugin-routes.js";
import { registerBotFeatureRoutes } from "../feature-toggle/bot-feature-routes.js";
import { registerPluginRpcRoutes } from "../plugin-system/plugin-rpc-routes.js";
import { registerVoiceRpcRoutes } from "../voice/voice-rpc.js";
import { registerVoiceInternalRoutes } from "../voice/voice-internal-routes.js";
import { registerShardForwardRoutes } from "../plugin-system/shard-forward-routes.js";

/**
 * Dependencies the business modules need to mount their routes. The web
 * server (`createWebServer`) owns the Fastify instance, auth/throttle
 * hooks, auth routes, metrics, and static serving; it delegates all
 * business-module route registration to this single aggregator so it no
 * longer enumerates every module itself (PM-4 module-boundary convergence).
 */
export interface ModuleRouteDeps {
  bot?: Client;
  reconciler?: CommandReconciler;
  dmInbox?: DmInboxStore;
  /** Injected DM rate limiter for tests; production uses the singleton. */
  dmLimiter?: { isRateLimited(key: string): boolean };
}

/**
 * Bot identity route. Feeds the chat composer ("is this me?") and the
 * dashboard, so any of the read capabilities is enough. Only mounted when
 * a Discord client is present.
 */
function registerBotStatusRoute(server: FastifyInstance, bot: Client): void {
  server.get("/api/bot/status", async (request, reply) => {
    if (
      !requireAnyCapability(request, reply, [
        "dm.message",
        "guild.message",
        "guild.manage",
        "system.read",
      ])
    )
      return;
    const ready = bot.isReady();
    const user = ready ? bot.user : null;
    return {
      ready,
      userTag: user?.tag ?? null,
      userId: user?.id ?? null,
      username: user?.username ?? null,
      globalName: user?.globalName ?? null,
      avatarUrl: user ? avatarUrlFor(user.id, user.avatar) : null,
      guildCount: bot.guilds.cache.size,
      uptimeMs: bot.uptime ?? 0,
    };
  });
}

/**
 * Mount every business module's HTTP routes onto the server. Registration
 * order is preserved from the original inline block in server.ts; route
 * matching is path/method based so the order is not load-bearing, but
 * keeping it stable makes the move a pure relocation.
 */
export async function registerModuleRoutes(
  server: FastifyInstance,
  deps: ModuleRouteDeps,
): Promise<void> {
  const { bot, reconciler, dmInbox, dmLimiter } = deps;

  await registerAdminManagementRoutes(server, { bot });
  await registerAdminLoginStatusRoutes(server);
  await registerAdminSystemSettingsRoutes(server);
  await registerBotEventRoutes(server);
  await registerBehaviorRoutes(server, { bot, reconciler });
  await registerScopeTabRoutes(server);
  await registerPluginRoutes(server, { bot, reconciler });
  await registerPluginRpcRoutes(server, { bot, dmLimiter });
  await registerVoiceRpcRoutes(server, { bot });
  // Reverse channel from the standalone voice service (PR-2.3 full split).
  // Only meaningful when VOICE_SERVICE_URL is set; the routes self-guard
  // (503 when no shared secret), so they're harmless to mount unconditionally.
  await registerVoiceInternalRoutes(server, {
    bot,
    // Rotation-aware + read per request (not snapshotted at boot) so the
    // SecretProvider's live re-read lets VOICE_HMAC_SECRET be rolled without
    // a synchronized bot+voice restart.
    secrets: () => getVerificationKeys("VOICE_HMAC_SECRET"),
  });
  // Cross-shard forward relay (PR-3.3). Self-guards (503 without a
  // shared secret); harmless to mount in the single-shard default where
  // nothing ever forwards to it.
  await registerShardForwardRoutes(server, {
    secrets: () => {
      const s = config.shard.hmacSecret;
      return s ? [s] : [];
    },
  });
  await registerBotFeatureRoutes(server, { bot });

  if (bot) {
    registerBotStatusRoute(server, bot);
    await registerDmRoutes(server, { bot, inbox: dmInbox });
    await registerDiscordRoutes(server, { bot });
    await registerGuildsRoutes(server, { bot });
    await registerGuildChannelRoutes(server, { bot });
    await registerGuildManagementRoutes(server, { bot });
    await registerSystemRoutes(server, { bot, dmInbox });
  } else {
    await registerSystemRoutes(server, { dmInbox });
  }
}
