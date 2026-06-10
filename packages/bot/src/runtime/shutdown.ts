import { sequelize } from "../db.js";
import {
  botEventsSequelize,
  botEventsSharesMainDb,
} from "../modules/bot-events/bot-events-db.js";
import { closeRedisClient } from "../adapters/redis/client.js";
import { shutdownOtel } from "../observability/otel.js";
import { moduleLogger } from "../logger.js";
import { setDraining } from "../modules/web-core/readiness.js";
import { pluginRegistry } from "../modules/plugin-system/plugin-registry.service.js";
import { stopDispatchPool } from "../modules/plugin-system/plugin-event-bridge.service.js";
import { shutdownAllRconConnections } from "../modules/builtin-features/rcon-forward/rcon-forward-channel.events.js";
import type { RuntimeContext } from "./context.js";

const log = moduleLogger("main");

const SHUTDOWN_TIMEOUT_MS = 30_000;
/**
 * How long to advertise 503 on /api/health/ready before we actually
 * start closing sockets. Gives an upstream reverse
 * proxy / load balancer a window to notice the drain and stop routing
 * new traffic to this instance. Container orchestrators typically
 * recheck health every 5-10s, so a 2s grace handles the most-common
 * docker / k8s defaults without dragging out shutdown.
 *
 * Override with `SHUTDOWN_DRAIN_GRACE_MS` (e.g. 0 for tests).
 */
const SHUTDOWN_DRAIN_GRACE_MS = Number.isFinite(
  Number(process.env.SHUTDOWN_DRAIN_GRACE_MS),
)
  ? Math.max(0, Number(process.env.SHUTDOWN_DRAIN_GRACE_MS))
  : 2_000;

export async function gracefulShutdown(
  ctx: RuntimeContext,
  signal: string,
): Promise<void> {
  if (ctx.shuttingDown) {
    // Second signal during shutdown = "I'm impatient, force exit now."
    // Common case: operator hits Ctrl+C twice when something hangs.
    log.warn({ signal }, "shutdown already in progress, forcing exit");
    process.exit(1);
  }
  ctx.shuttingDown = true;
  log.info({ signal }, "graceful shutdown begin");

  // Forced-exit guard: if any step hangs (SSE close, Discord WS handshake,
  // RCON socket close), we still die after SHUTDOWN_TIMEOUT_MS. We do NOT
  // .unref() the timer — its job is to fire even when other refs are gone.
  const timeout = setTimeout(() => {
    log.error("graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    // 0. Drain phase: flip readiness=false BEFORE closing the server.
    //    Upstream proxies polling /api/health/ready now see 503 and
    //    stop routing new requests. In-flight requests keep being
    //    served by fastify until we close in step 1.
    setDraining();
    if (SHUTDOWN_DRAIN_GRACE_MS > 0) {
      log.info(
        { graceMs: SHUTDOWN_DRAIN_GRACE_MS },
        "draining — waiting for upstream proxies to notice 503",
      );
      await new Promise<void>((resolve) =>
        setTimeout(resolve, SHUTDOWN_DRAIN_GRACE_MS).unref(),
      );
    }
    // 1. Stop accepting new HTTP requests; fastify drains in-flight ones.
    if (ctx.webServer) {
      await ctx.webServer.close();
    }
    // 2. Stop background timers / cleanup.
    pluginRegistry.stopReaper();
    ctx.sessionStore?.stop();
    // 2'. Drain the plugin dispatch pool (HTTP keep-alive sockets).
    await stopDispatchPool();
    // 3. Close RCON sockets (was registered as its own SIGTERM handler;
    // pulled in here so we don't race with this shutdown).
    await shutdownAllRconConnections();
    // 4. Close Discord gateway WS so the gateway flips us offline now.
    await ctx.bot.destroy();
    // 5. Close DB last — earlier steps may still be writing.
    await sequelize.close();
    // 5'. Close the bot_events DB — separate file when the main DB is
    //     SQLite. Under Postgres bot_events shares the main connection
    //     (#14 fix), so the close above already covered it.
    if (!botEventsSharesMainDb) {
      await botEventsSequelize.close();
    }
    // 5''. Close the shared Redis client if one was opened. Safe no-op
    //      when no adapter ever requested Redis.
    await closeRedisClient();
    // 6. Flush + shut down the OTel SDK last so spans emitted by the
    //    teardown steps above still get exported. No-op when OTel is
    //    disabled (the common single-machine default).
    await shutdownOtel();
    clearTimeout(timeout);
    log.info({ signal }, "graceful shutdown complete");
    process.exit(0);
  } catch (err) {
    clearTimeout(timeout);
    log.error({ err, signal }, "graceful shutdown failed");
    process.exit(1);
  }
}

/**
 * Register SIGTERM / SIGINT handlers. Use process.on (not once) so a
 * second signal during shutdown can hit the "force exit" branch above
 * instead of being silently dropped.
 */
export function installSignalHandlers(ctx: RuntimeContext): void {
  process.on("SIGTERM", () => {
    void gracefulShutdown(ctx, "SIGTERM");
  });
  process.on("SIGINT", () => {
    void gracefulShutdown(ctx, "SIGINT");
  });
}
