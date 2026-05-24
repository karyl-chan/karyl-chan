/**
 * Readiness state for the bot's "fully booted" signal.
 *
 * Liveness ("am I still alive?") is trivially true if the process can
 * answer an HTTP request — checked by /api/health/live.
 *
 * Readiness ("am I ready to serve real traffic?") is gated on two
 * boot-phase signals:
 *   - db:          sequelize.sync() finished — schema is in place
 *                  (sync() is the single source of truth; the old
 *                  migration layer has been removed)
 *   - bot:         Discord client emitted 'ready' (gateway up,
 *                  guild snapshot fetched)
 *
 * Each signal is set once during boot. Readiness probes
 * (/api/health/ready and /api/health for backwards compatibility)
 * return 503 until both flip true. This lets sibling containers
 * use `depends_on: { condition: service_healthy }` and trust that
 * the bot is genuinely ready to handle their requests.
 */

export type ReadinessSignal = "db" | "bot";

const state: Record<ReadinessSignal, boolean> = {
  db: false,
  bot: false,
};

export function setReady(signal: ReadinessSignal, value: boolean): void {
  state[signal] = value;
}

export function getReadiness(): {
  db: boolean;
  bot: boolean;
  ready: boolean;
} {
  return {
    db: state.db,
    bot: state.bot,
    ready: state.db && state.bot,
  };
}
