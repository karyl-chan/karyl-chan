import { moduleLogger } from "../logger.js";
import { botEventLog } from "../modules/bot-events/bot-event-log.js";
import type { RuntimeContext } from "./context.js";

const log = moduleLogger("main");

// 4s flush window covers SQLite busy_timeout (3000 ms) so the bot_events
// row has a chance to land even when there's lock contention. We don't
// .unref() the timer — we want it to keep the event loop alive for the
// full window even if other refs (Discord WS, http server) have torn down.
const FATAL_FLUSH_MS = 4_000;

/**
 * Register process-level error handlers exactly once. Call before
 * startup so a crash during boot is still captured.
 *
 * Before sync() finishes we log-only (DB table may not exist yet);
 * after that (`ctx.dbReady`) we also persist to bot_events. We never
 * schedule a fatal exit while a graceful shutdown is already in flight
 * (`ctx.shuttingDown`) — that 4s timer would race shutdown's 30s budget
 * and could cut the cleanup short.
 */
export function installProcessErrorHandlers(ctx: RuntimeContext): void {
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "Unhandled promise rejection");
    if (ctx.shuttingDown) return;
    if (ctx.dbReady) {
      // Stack stays in pino server log only. botEventLog feeds the
      // admin UI, which serializes context as-is — putting the stack
      // there would just relocate the leak issue 8.1 was meant to fix.
      botEventLog.record("error", "error", "Unhandled promise rejection", {
        errorType:
          reason instanceof Error ? reason.constructor.name : typeof reason,
      });
    }
    setTimeout(() => process.exit(1), FATAL_FLUSH_MS);
  });

  process.on("uncaughtException", (error) => {
    log.error({ err: error }, "Uncaught exception");
    if (ctx.shuttingDown) return;
    if (ctx.dbReady) {
      botEventLog.record("error", "error", "Uncaught exception", {
        errorType: error.constructor.name,
      });
    }
    setTimeout(() => process.exit(1), FATAL_FLUSH_MS);
  });
}
