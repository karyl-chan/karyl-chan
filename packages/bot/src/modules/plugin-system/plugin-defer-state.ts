/**
 * In-memory tracker for "was this interaction deferred ephemeral or public?".
 *
 * Discord locks ephemerality at defer time — once `deferReply({ ephemeral })`
 * fires, `@original`'s flags can't be changed by later edits. The bot defers
 * BEFORE the plugin HTTP handler runs (3-second ack budget), so when the
 * plugin later calls `/api/plugin/interactions.respond`, the bot needs to
 * know what shape `@original` is in to route correctly:
 *
 *   - plugin wants the same ephemerality as defer → PATCH @original (happy path)
 *   - plugin wants the opposite → POST a follow-up with the desired
 *     ephemerality + DELETE @original (cleaner than leaving a placeholder)
 *
 * Per-interaction state is small (one boolean), short-lived (Discord tokens
 * are 15 min), and only meaningful to the same bot process that deferred —
 * a Map in memory is sufficient. No cross-process or persistent storage.
 *
 * TTL 16 min covers the full Discord token lifetime plus a grace second so
 * a respond arriving right at the edge can still find its state. Periodic
 * sweep keeps the map bounded under steady load.
 */

interface DeferEntry {
  ephemeral: boolean;
  expiresAt: number;
}

const TOKEN_TTL_MS = 16 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60_000;

const deferStates = new Map<string, DeferEntry>();
let sweepTimer: NodeJS.Timeout | null = null;

function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of deferStates) {
      if (entry.expiresAt < now) deferStates.delete(token);
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function recordPluginDeferEphemeral(
  interactionToken: string,
  ephemeral: boolean,
): void {
  ensureSweep();
  deferStates.set(interactionToken, {
    ephemeral,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
}

/**
 * Returns the recorded defer ephemerality, or null when no record exists
 * (the bot didn't defer this token, or the record was swept after TTL).
 * Callers fall back to a conservative default — usually `true` to match
 * the bot's defer default — when the answer is unknown.
 */
export function readPluginDeferEphemeral(
  interactionToken: string,
): boolean | null {
  const entry = deferStates.get(interactionToken);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    deferStates.delete(interactionToken);
    return null;
  }
  return entry.ephemeral;
}

/**
 * Drop the record once the respond endpoint has used it. The token is
 * still valid for follow-ups (15-min window), but those use the
 * `interactions.followup` endpoint where the plugin sends its own
 * ephemeral flag — no need to remember the defer state past the first
 * respond. Cuts memory pressure on long-running plugin sessions.
 */
export function clearPluginDeferEphemeral(interactionToken: string): void {
  deferStates.delete(interactionToken);
}

/** Tests only — wipe the map between cases. */
export function _resetPluginDeferStateForTests(): void {
  deferStates.clear();
}
