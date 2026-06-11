/**
 * Per-plugin dispatch-path health tracker (PM-7.9.1).
 *
 * "Healthy" on the admin panel has historically meant *liveness* —
 * heartbeat fresh, `/health` answering. Neither of those goes through
 * the dispatch HMAC path, so a plugin whose signature verification
 * rejects every interaction (e.g. the 2026-06-11 incident: bot image
 * predating the nonced HMAC scheme dispatching to SDK ≥0.10.0 plugins)
 * shows green everywhere while every command fails with 401. The only
 * humans who could see the failure were Discord users pressing the
 * command.
 *
 * This module is the missing aggregation point. It does NOT sit on the
 * dispatch paths — there is no single chokepoint to sit on: slash /
 * autocomplete / component / modal dispatches use bare `fetch()` while
 * the event fan-out goes through `PluginDispatchPool`. Instead each of
 * those five call sites reports its outcome here, and the admin API
 * exposes the per-plugin aggregate next to `commandSync`.
 *
 * State is per-process and in-memory (same contract as the registry's
 * `commandSyncStates`): a bot restart clears it, `null` means "no
 * dispatch attempted since this process started". In multi-shard
 * deployments each shard sees only its own dispatches.
 */

export type DispatchSource =
  | "command"
  | "autocomplete"
  | "component"
  | "modal"
  | "event"
  | "lifecycle"
  | "probe";

export type DispatchFailureClass =
  /** Plugin answered 401 — it rejected our HMAC signature. After the
   *  nonce scheme change this almost always means the bot and the
   *  plugin SDK disagree on the signature format (version mismatch). */
  | "rejected_401"
  /** Plugin answered 503 "dispatch HMAC key not available" — it is up
   *  but has not completed its register handshake (PM-7.6 semantics). */
  | "awaiting_register"
  /** Any other non-2xx HTTP response. */
  | "http_error"
  /** The per-request deadline elapsed before headers/body arrived. */
  | "timeout"
  /** Network-layer failure: connect refused, DNS, reset, … */
  | "network"
  /** Pre-flight refused the dispatch before any request was sent:
   *  host-policy denial OR DNS-resolution failure (a removed/renamed
   *  plugin container), or an unresolvable endpoint URL. The dispatch
   *  never left the bot — but from the operator's view the path is
   *  just as broken as a network failure. */
  | "unreachable"
  /** Event-path circuit breaker short-circuited the dispatch. */
  | "breaker_open"
  /** Event-path in-flight cap shed the dispatch. */
  | "shed";

export interface DispatchAttempt {
  /** Epoch ms when the outcome was recorded. */
  at: number;
  ok: boolean;
  source: DispatchSource;
  /** HTTP status, when a response was received at all. */
  status?: number;
  failureClass?: DispatchFailureClass;
  /** Truncated human-readable detail (command name, error message …). */
  message?: string;
}

export interface DispatchHealthState {
  /** Attempts observed since this bot process started. */
  total: number;
  okCount: number;
  /** Current run of failures; reset to 0 by any success. */
  consecutiveFailures: number;
  lastOkAt: number | null;
  /** Newest-first window of recent attempts. */
  recent: DispatchAttempt[];
}

/** How many attempts the per-plugin window keeps (newest first). */
export const DISPATCH_RECENT_CAP = 20;
const MESSAGE_CAP = 200;

const states = new Map<string, DispatchHealthState>();

export function recordDispatchAttempt(
  pluginKey: string,
  attempt: Omit<DispatchAttempt, "at">,
): void {
  let state = states.get(pluginKey);
  if (!state) {
    state = {
      total: 0,
      okCount: 0,
      consecutiveFailures: 0,
      lastOkAt: null,
      recent: [],
    };
    states.set(pluginKey, state);
  }
  const full: DispatchAttempt = {
    ...attempt,
    ...(attempt.message !== undefined
      ? { message: attempt.message.slice(0, MESSAGE_CAP) }
      : {}),
    at: Date.now(),
  };
  state.total++;
  if (full.ok) {
    state.okCount++;
    state.consecutiveFailures = 0;
    state.lastOkAt = full.at;
  } else {
    state.consecutiveFailures++;
  }
  state.recent.unshift(full);
  if (state.recent.length > DISPATCH_RECENT_CAP) {
    state.recent.length = DISPATCH_RECENT_CAP;
  }
}

/** The standard ok-outcome recorder for a dispatch fetch. */
export function recordDispatchOk(pluginKey: string, source: DispatchSource, status: number): void {
  recordDispatchAttempt(pluginKey, { ok: true, source, status });
}

/** The standard non-2xx recorder: classifies the failure from status+body. */
export function recordDispatchHttpFailure(
  pluginKey: string,
  source: DispatchSource,
  label: string,
  status: number,
  bodyText: string,
): void {
  recordDispatchAttempt(pluginKey, {
    ok: false,
    source,
    status,
    failureClass: classifyDispatchHttpFailure(status, bodyText),
    message: `${label}: ${bodyText.slice(0, 120)}`,
  });
}

/**
 * Pre-flight failure recorder: the dispatch never left the bot
 * (host-policy refusal, DNS failure, unresolvable endpoint URL).
 * Without this, "plugin container is gone" — the most common failure
 * mode — left dispatch health frozen on its last happy state.
 */
export function recordDispatchUnreachable(
  pluginKey: string,
  source: DispatchSource,
  label: string,
  reason: string,
): void {
  recordDispatchAttempt(pluginKey, {
    ok: false,
    source,
    failureClass: "unreachable",
    message: `${label}: ${reason}`,
  });
}

/** The standard thrown-fetch recorder (timeout / connection refused / DNS). */
export function recordDispatchFetchFailure(pluginKey: string, source: DispatchSource, label: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  recordDispatchAttempt(pluginKey, {
    ok: false,
    source,
    failureClass: classifyDispatchFetchError(err),
    message: `${label}: ${msg}`,
  });
}

/** `null` = no dispatch attempted since this bot process started. */
export function getDispatchHealth(
  pluginKey: string,
): DispatchHealthState | null {
  return states.get(pluginKey) ?? null;
}

/** Forget a plugin's window — call when the plugin row is deleted. */
export function clearDispatchHealth(pluginKey: string): void {
  states.delete(pluginKey);
}

/**
 * Classify a non-2xx HTTP response from a plugin's dispatch endpoint.
 * `bodyText` feeds the awaiting-register detection; pass "" when the
 * body was not read (event path failures only carry the status).
 */
export function classifyDispatchHttpFailure(
  status: number,
  bodyText: string,
): DispatchFailureClass {
  if (status === 401) return "rejected_401";
  if (status === 503 && bodyText.includes("dispatch HMAC key")) {
    return "awaiting_register";
  }
  return "http_error";
}

/** Classify a thrown fetch error (abort = our deadline, rest = network). */
export function classifyDispatchFetchError(err: unknown): DispatchFailureClass {
  return err instanceof Error && err.name === "AbortError"
    ? "timeout"
    : "network";
}

export function __resetDispatchHealthForTests(): void {
  states.clear();
}
