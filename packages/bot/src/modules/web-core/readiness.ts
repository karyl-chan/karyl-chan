/**
 * Readiness state for the bot's "fully booted" signal AND the
 * graceful-drain signal.
 *
 * Liveness ("am I still alive?") is trivially true if the process can
 * answer an HTTP request — checked by /api/health/live.
 *
 * Readiness ("am I ready to serve real traffic?") is the AND of:
 *   - db:         sequelize.sync() finished — schema is in place
 *   - bot:        Discord client emitted 'ready' (gateway up, guilds fetched)
 *   - !draining:  graceful shutdown has NOT been triggered yet
 *
 * The `draining` flag is set BEFORE the HTTP server closes during
 * `gracefulShutdown`. Health probes flip to 503 immediately so an
 * upstream reverse proxy / load balancer can stop routing new
 * traffic to this instance before fastify starts closing sockets —
 * closing this gap is what [[bot-plugin-proxy-recreate-race]]
 * documented as the dropped-traffic window during a rolling restart.
 *
 * Each boot signal is set once during boot. The drain signal is
 * one-way: once a process starts draining, it shuts down; it does
 * not come back.
 */

export type ReadinessSignal = "db" | "bot";

const state: Record<ReadinessSignal, boolean> = {
  db: false,
  bot: false,
};

let draining = false;

/**
 * How the `bot` signal got satisfied. "gateway" = the real Discord
 * ready event; "skipped" = BOT_SKIP_DISCORD dev mode, where there is
 * no gateway to wait for — readiness then means "web + db are up"
 * (PM-7.5; previously skip mode could never turn ready and wedged
 * any sibling container using `depends_on: service_healthy`).
 */
export type BotReadyMode = "gateway" | "skipped";

let botMode: BotReadyMode = "gateway";

export function setReady(signal: ReadinessSignal, value: boolean): void {
  state[signal] = value;
}

/** BOT_SKIP_DISCORD dev mode: satisfy the bot signal without a gateway. */
export function setBotSkipped(): void {
  botMode = "skipped";
  state.bot = true;
}

/**
 * Mark the instance as draining. Once set, readiness probes return
 * 503 even if the boot signals are still healthy. Idempotent —
 * calling twice is harmless.
 */
export function setDraining(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

export function getReadiness(): {
  db: boolean;
  bot: boolean;
  botMode: BotReadyMode;
  draining: boolean;
  ready: boolean;
} {
  return {
    db: state.db,
    bot: state.bot,
    botMode,
    draining,
    ready: state.db && state.bot && !draining,
  };
}

/**
 * Test-only — reset both boot signals and the drain flag. Production
 * code does not need this; the only state transitions are boot →
 * ready and ready → draining → exit.
 */
export function __resetReadinessForTests(): void {
  state.db = false;
  state.bot = false;
  botMode = "gateway";
  draining = false;
}
