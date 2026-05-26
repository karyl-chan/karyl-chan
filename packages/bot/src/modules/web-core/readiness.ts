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
 * `gracefulShutdown` (SCALING_PLAN Phase 0.6). Health probes flip to
 * 503 immediately so an upstream reverse proxy / load balancer can
 * stop routing new traffic to this instance before fastify starts
 * closing sockets — closing this gap is what [[bot-plugin-proxy-recreate-race]]
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

export function setReady(signal: ReadinessSignal, value: boolean): void {
  state[signal] = value;
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
  draining: boolean;
  ready: boolean;
} {
  return {
    db: state.db,
    bot: state.bot,
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
  draining = false;
}
