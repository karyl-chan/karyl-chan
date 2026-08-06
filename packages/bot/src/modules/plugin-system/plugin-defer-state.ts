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

/**
 * Two interaction kinds need different respond-time handling:
 *
 *   - `reply`: bot called `deferReply({ ephemeral })`. `@original` is the
 *     ephemeral/public "thinking…" placeholder. ephemerality is locked
 *     at defer time; mismatched plugin responses need follow-up + DELETE
 *     @original (see plugin-rpc-routes interactions.respond).
 *
 *   - `update`: bot called `deferUpdate()` (component clicks). NO
 *     "thinking…" message exists; `@original` is the message containing
 *     the clicked component. ANY respond/edit goes straight to that
 *     parent message — DELETE here would nuke the user's own message.
 *
 * The kind is recorded by the dispatcher that called the defer; the
 * respond endpoint routes purely on `kind` (and `ephemeral` only when
 * kind='reply').
 */
export type DeferKind = "reply" | "update";

export interface DeferState {
  kind: DeferKind;
  /** Only meaningful when kind='reply'; ignored for 'update'. */
  ephemeral: boolean;
}

interface DeferEntry extends DeferState {
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

/** Command dispatcher records a deferReply with its ephemeral choice. */
export function recordPluginDeferReply(
  interactionToken: string,
  ephemeral: boolean,
): void {
  ensureSweep();
  deferStates.set(interactionToken, {
    kind: "reply",
    ephemeral,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
}

/**
 * Component dispatcher records a deferUpdate. ephemeral=false here is a
 * placeholder — the field doesn't apply when the bot didn't create a
 * deferred reply; the respond endpoint checks kind first.
 */
export function recordPluginDeferUpdate(interactionToken: string): void {
  ensureSweep();
  deferStates.set(interactionToken, {
    kind: "update",
    ephemeral: false,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
}

/**
 * Returns the recorded defer state, or null when no record exists (TTL
 * eviction, bot restart between defer and respond, or an interaction
 * that predates this tracker). Callers fall back conservatively when
 * null — typically treat as `kind='reply'` with `ephemeral=true` (the
 * dispatcher's own default).
 */
export function readPluginDeferState(
  interactionToken: string,
): DeferState | null {
  const entry = deferStates.get(interactionToken);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    deferStates.delete(interactionToken);
    return null;
  }
  return { kind: entry.kind, ephemeral: entry.ephemeral };
}

/**
 * Drop the record once the respond endpoint has used it. The token is
 * still valid for follow-ups (15-min window), but those use the
 * `interactions.followup` endpoint where the plugin sends its own
 * ephemeral flag — no need to remember the defer state past the first
 * respond. Cuts memory pressure on long-running plugin sessions.
 */
export function clearPluginDeferState(interactionToken: string): void {
  deferStates.delete(interactionToken);
}

/** Tests only — wipe the map between cases. */
export function _resetPluginDeferStateForTests(): void {
  deferStates.clear();
}

/**
 * How a plugin's `interactions.respond` call must reach Discord, decided
 * from the recorded defer state. This module already owned the state and
 * its lifecycle (the dispatchers record, the respond route reads and
 * clears); #56 moves the *decision derived from it* here too, so the
 * defer → respond transition table has one owner and the route keeps
 * only the REST transport.
 */
export type PluginRespondPlan =
  /**
   * PATCH `@original`. Two cases collapse here:
   *   - kind='update' (component clicks): the bot called deferUpdate —
   *     no "thinking…" placeholder exists, @original IS the user's
   *     message hosting the clicked component. Straight PATCH; the
   *     mismatch logic must never run because its DELETE would nuke
   *     the user's own message.
   *   - kind='reply' with matching ephemerality: the happy path.
   *     `flags` is read-only on edit so Ephemeral (set at defer) stays.
   */
  | { action: "patch-original" }
  /**
   * kind='reply' and the plugin wants the OPPOSITE ephemerality of the
   * defer. Ephemerality is locked at defer time, so: POST a follow-up
   * with the desired ephemerality (`ephemeral` here), then best-effort
   * DELETE `@original` so the user sees one message of the right kind.
   */
  | { action: "followup-then-delete-original"; ephemeral: boolean };

/**
 * Resolve the respond route's plan for an interaction token.
 *
 * kind='reply' has four cases (defer=E/P × want=E/P): matching pairs
 * PATCH @original; mismatches follow up + delete. `requestedEphemeral`
 * carries the raw body field: `undefined` means "whatever the defer
 * was" (never a mismatch), and any other non-`false` value — any type —
 * means "ephemeral", preserving the historical truthiness rule.
 *
 * Null defer state (TTL eviction, restart, pre-tracker interactions)
 * falls back to `{kind:'reply', ephemeral:true}` — the dispatcher's
 * default. Matches old behaviour for commands; for components it would
 * force the wrong path, but the component dispatcher records state in
 * the same tick as deferUpdate so the only path to null-for-a-component
 * is the bot restarting mid-interaction, which is rare.
 *
 * Read-only: the caller consumes the state via `clearPluginDeferState`
 * only after Discord accepted the call, so a failed respond can retry
 * against the same state.
 */
export function planPluginRespond(
  interactionToken: string,
  requestedEphemeral: unknown,
): PluginRespondPlan {
  const deferState = readPluginDeferState(interactionToken) ?? {
    kind: "reply" as const,
    ephemeral: true,
  };
  if (deferState.kind === "update") return { action: "patch-original" };
  const wantsEphemeral =
    requestedEphemeral === undefined ? null : requestedEphemeral !== false;
  const effectiveEphemeral = wantsEphemeral ?? deferState.ephemeral;
  if (effectiveEphemeral === deferState.ephemeral) {
    return { action: "patch-original" };
  }
  return { action: "followup-then-delete-original", ephemeral: effectiveEphemeral };
}
