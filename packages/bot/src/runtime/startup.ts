import { sequelize } from "../db.js";
import {
  botEventsSequelize,
  botEventsSharesMainDb,
} from "../modules/bot-events/bot-events-db.js";
import { getSessionStore } from "../adapters/registry.js";
import { config } from "../config.js";
import { moduleLogger } from "../logger.js";
import { setVoiceClient } from "../modules/voice/voice-backend.js";
import { installVoiceGatewayRelay } from "../modules/voice/voice-gateway-relay.js";
import { startWebServer } from "../modules/web-core/server.js";
import { setBotSkipped, setReady } from "../modules/web-core/readiness.js";
import {
  setMetricsBotClient,
  botEventLogWritesTotal,
  auditLogWritesTotal,
} from "../modules/web-core/metrics.js";
import { setBotEventLogMetric } from "../modules/bot-events/bot-event-log.js";
import { setAuditLogMetric } from "../modules/admin/admin-audit.service.js";
import { dmInboxService } from "../modules/dm-inbox/dm-inbox.service.js";
import {
  auditStoredCapabilities,
  seedDefaultRoles,
} from "../modules/admin/authorized-user.service.js";
import {
  botEventLog,
  startBotEventLogPruner,
} from "../modules/bot-events/bot-event-log.js";
import { ensureSystemBehaviors } from "../modules/behavior/system-seed.service.js";
import { ensureFixedScopeTabs } from "../modules/behavior/scope-tab-seed.service.js";
import { runMigrations } from "../db-migrations.js";
import { initJwtSigningAuthority } from "../modules/web-core/jwt.service.js";
import { pluginRegistry } from "../modules/plugin-system/plugin-registry.service.js";
import { rebuildEventIndex } from "../modules/plugin-system/plugin-event-bridge.service.js";
import { startPluginHealthPoller } from "../modules/plugin-system/plugin-health-poller.service.js";
import { setPluginCommandBotClient } from "../modules/plugin-system/plugin-command-registry.service.js";
import { bootstrapInProcessFeatures } from "../bootstrap-in-process.js";
import { bootstrapEventHandlers } from "../bootstrap-events.js";
import type { RuntimeContext } from "./context.js";

const log = moduleLogger("main");

export async function runStartup(ctx: RuntimeContext): Promise<void> {
  const { bot } = ctx;
  try {
    bootstrapEventHandlers(bot);
    bootstrapInProcessFeatures();
    // sync() is the single source of truth for the DB schema — the
    // sync() handles fresh-DB initial table creation. It CREATEs
    // missing tables but never ALTERs an existing one, so schema
    // evolution on long-lived DBs has to go through umzug below.
    await sequelize.sync();
    // bot_events lives in its own SQLite file (when the main DB is
    // SQLite) so its high-rate writes don't fight the main DB's write
    // lock. Under Postgres the model is registered on the main
    // sequelize instance, so the sync() above already created the
    // table — skip the redundant call.
    if (!botEventsSharesMainDb) {
      await botEventsSequelize.sync();
    }
    // Incremental schema/data migrations (src/migrations/). Runs
    // every boot; already-applied migrations are skipped via the
    // SequelizeMeta record. See src/migrations/README.md for the
    // workflow when adding new schema changes.
    await runMigrations(sequelize, "main");
    setReady("db", true);
    ctx.dbReady = true;
    // Load (or, on a fresh DB, generate + persist) the JWT signing key
    // before any route is served. Routes (login exchange, plugin
    // register/heartbeat) call jwtService.{sign,verify,publicKeyPem}.
    await initJwtSigningAuthority();
    // System behavior seed（admin-login / manual / break）：idempotent
    // 補建 source='system' rows，必須在 reconcileAll（bot ready handler
    // 內）之前完成，否則 CommandReconciler 的 desired set 不含 /login，
    // Discord 不會註冊。
    await ensureFixedScopeTabs();
    await ensureSystemBehaviors().catch((err: unknown) => {
      log.error({ err }, "ensureSystemBehaviors failed");
    });
    // behavior_session.expiresAt legacy fixup now lives in
    // src/migrations/000-migrate-legacy-expires-at.ts — applied via
    // runMigrations() above and recorded in SequelizeMeta so future
    // boots skip the scan entirely.
    await seedDefaultRoles();
    await auditStoredCapabilities();

    // Session store: in-process by default (single-machine, zero deps),
    // or Redis when SESSION_STORE=redis (cross-shard SSO). The in-process
    // store owns its own refresh-token durability wiring in init(); the
    // Redis store keeps its state in Redis. Resolve once and reuse the
    // same instance for shutdown.
    ctx.sessionStore = getSessionStore();
    await ctx.sessionStore.init();

    // Plugin heartbeat reaper. Marks plugins inactive after 75s with
    // no heartbeat (their own cadence is 30s, so a single dropped
    // beat doesn't trigger). Runs in-process; unref'd so it doesn't
    // hold the event loop alive on shutdown.
    //
    // Multi-shard: only shard 0 runs the reaper. The DB update is
    // idempotent but every shard would otherwise emit one
    // `Plugin marked inactive` bot-event log per expiry — same pattern
    // as the global slash-command reconcile gate above.
    if (config.bot.shardId === 0) {
      pluginRegistry.startReaper();
    } else {
      log.info(
        { shardId: config.bot.shardId },
        "skipping plugin reaper (only shard 0 runs)",
      );
    }
    // Bound the bot_events table — see bot-event-log.ts for the
    // rationale + caps. Runs in-process every 10 minutes, unref'd.
    startBotEventLogPruner();
    // Probe each plugin's /health/detail endpoint every 60 s and stash
    // the result in plugin-health-store for the admin UI to read. Runs
    // in-process; unref'd timer.
    startPluginHealthPoller();
    // Build the in-memory event subscription index from rows already
    // in the plugins table. Without this, plugins that registered
    // before the last bot restart wouldn't receive events until they
    // re-registered (next heartbeat). With this, events flow as soon
    // as plugins are alive again.
    await rebuildEventIndex();
    // Wire the bot client into the plugin command registry now that
    // we have it; reconcile slash commands once the bot reports
    // ready (deferred to the 'ready' handler below).
    setPluginCommandBotClient(bot);
    setMetricsBotClient(bot);
    // In-process voice backend resolves each guild's gateway adapter off
    // this client (see voice-backend.ts). A remote voice service ignores it.
    setVoiceClient(() => bot);
    // Full-split only: relay the bot's own VOICE_STATE_UPDATE +
    // VOICE_SERVER_UPDATE to the standalone voice service so its bridge
    // adapter can complete the voice handshake. No-op unless
    // VOICE_SERVICE_URL + VOICE_HMAC_SECRET are set.
    installVoiceGatewayRelay(bot);
    setBotEventLogMetric(botEventLogWritesTotal);
    setAuditLogMetric(auditLogWritesTotal);

    const webPort = config.web.port;
    const webHost = config.web.host;
    ctx.webServer = await startWebServer({
      port: webPort,
      host: webHost,
      bot,
      dmInbox: dmInboxService,
      reconciler: ctx.commandReconciler,
    });
    const isHttps = !!(config.web.sslCertPath && config.web.sslKeyPath);
    botEventLog.record("info", "web", `Web server started on :${webPort}`, {
      port: webPort,
      https: isHttps,
      host: webHost,
    });
    log.info({ port: webPort, host: webHost }, "web server listening");

    // Local-only escape hatch — when set, start the web server + plugin
    // lifecycle but skip the Discord gateway. The intended use is
    // driving the admin webui locally against a shared dev DB without
    // fighting a running prod bot for the gateway session (two clients
    // on the same BOT_TOKEN bump each other off). Hard-gated on
    // non-production so a stray prod env can never silently disable
    // Discord — `config.env === "production"` already requires the
    // explicit NODE_ENV=production set by the deploy pipeline.
    const skipDiscord =
      config.env !== "production" && process.env.BOT_SKIP_DISCORD === "true";
    if (skipDiscord) {
      log.warn(
        "BOT_SKIP_DISCORD=true — skipping Discord gateway login (dev only)",
      );
      // No gateway will ever fire `ready`, so satisfy the bot signal
      // here — otherwise /api/health/ready stays 503 forever and any
      // sibling `depends_on: service_healthy` deadlocks (PM-7.5).
      setBotSkipped();
    } else {
      await bot.login(config.bot.token);
    }
  } catch (ex) {
    log.error({ err: ex }, "startup failed");
    const errorType = ex instanceof Error ? ex.constructor.name : "unknown";
    botEventLog.record("error", "web", "Startup failed", {
      phase: "main",
      errorType,
    });
    // Fire-and-forget retry loop, exactly as before the split: run()'s
    // catch kicked off resetBot() without awaiting, and resetBot() re-ran
    // run() the same way. Nothing awaits the entry point.
    void resetBot(ctx);
  }
}

export async function resetBot(
  ctx: RuntimeContext,
  reason = "unknown",
): Promise<void> {
  botEventLog.record("error", "bot", `Bot reset triggered: ${reason}`, {
    phase: "startup",
  });
  ctx.bot.destroy();
  if (ctx.webServer) {
    await ctx.webServer.close();
    ctx.webServer = null;
  }
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, 10000);
  });
  log.warn({ stage: "restart" }, "bot restarting");
  void runStartup(ctx);
}
