/**
 * Ticketed SSE channel with reconnect + optional polling fallback.
 *
 * EventSource can't send `Authorization` headers, so the canonical
 * plugin pattern is:
 *   1. POST to `/api/.../sse-ticket` (authed via Bearer) → returns
 *      a single-use opaque ticket (server-side TTL ~20s).
 *   2. `new EventSource(<sseUrl>?ticket=<ticket>)` — the SSE GET is
 *      unauthenticated; the server consumes the ticket on first read
 *      and binds the stream to the user/session it was minted for.
 *
 * On every reconnect we mint a fresh ticket (the previous one was
 * single-use and is now stale anyway). The 30s upstream timeout on the
 * bot's reverse proxy means the server should also be sending periodic
 * comment lines (`: ping\n\n`) every ~20s, otherwise the proxy will
 * cut the stream mid-flow.
 *
 * After 4 consecutive errors with no successful message in between, we
 * give up on SSE and degrade to polling (caller-supplied `poll` fn) at
 * `pollIntervalMs`. This is the same threshold quest-game/xiangqi
 * arrived at empirically.
 */

export interface SseChannelOptions<T> {
  /** Full URL for the SSE stream (the `ticket` query param is appended). */
  url: string;
  /** Mint a fresh single-use ticket; should hit your `sse-ticket` route. */
  fetchTicket: () => Promise<string | null>;
  /** Called for each parsed event. The default `event:` is `message`. */
  onEvent: (data: T) => void;
  /** Called when the EventSource transitions to OPEN. */
  onOpen?: () => void;
  /** Called when reconnect attempts are exhausted (after 4 in a row). */
  onGiveUp?: () => void;
  /** Called when access is denied (ticket mint returned null). */
  onDenied?: () => void;
  /** Optional fallback poll used after SSE gives up. */
  poll?: () => Promise<T | null>;
  /** Polling interval once SSE has given up. Default 4000 ms. */
  pollIntervalMs?: number;
  /** Custom event name; default 'message'. */
  eventName?: string;
  /** Initial backoff ms between SSE retries. Default 1500. */
  retryBackoffMs?: number;
  /** Errors-in-a-row before giving up. Default 4. */
  giveUpAfterErrors?: number;
}

export interface SseChannel {
  /** Tear down: close any open EventSource + stop polling. */
  stop(): void;
}

/**
 * Open a ticketed SSE channel.
 *
 * Returns a handle whose `.stop()` releases resources. Callers should
 * call `.stop()` from `onUnmounted` in a Vue composable wrapper.
 */
export function openSseChannel<T = unknown>(
  opts: SseChannelOptions<T>,
): SseChannel {
  const {
    url,
    fetchTicket,
    onEvent,
    onOpen,
    onGiveUp,
    onDenied,
    poll,
    pollIntervalMs = 4000,
    eventName = "message",
    retryBackoffMs = 1500,
    giveUpAfterErrors = 4,
  } = opts;

  let disposed = false;
  let es: EventSource | null = null;
  let pollTimer: number | null = null;
  let retryTimer: number | null = null;
  let errors = 0;

  function clearTimers(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function closeEs(): void {
    if (es) {
      es.close();
      es = null;
    }
  }

  async function startPolling(): Promise<void> {
    if (!poll) return;
    const tick = async (): Promise<void> => {
      try {
        const data = await poll();
        if (disposed) return;
        if (data !== null) onEvent(data);
      } catch {
        // swallow — polling tolerates transient failures
      }
    };
    pollTimer = window.setInterval(tick, pollIntervalMs);
    void tick();
  }

  async function connect(): Promise<void> {
    if (disposed) return;
    let ticket: string | null;
    try {
      ticket = await fetchTicket();
    } catch {
      ticket = null;
    }
    if (disposed) return;
    if (!ticket) {
      onDenied?.();
      return;
    }
    const sep = url.includes("?") ? "&" : "?";
    const fullUrl = `${url}${sep}ticket=${encodeURIComponent(ticket)}`;
    es = new EventSource(fullUrl);

    es.addEventListener(eventName, (event) => {
      const ev = event as MessageEvent<string>;
      errors = 0; // Successful message resets the error counter.
      try {
        const parsed = JSON.parse(ev.data) as T;
        onEvent(parsed);
      } catch {
        // Ignore unparseable frames — server-side bug, not a transport one.
      }
    });

    es.onopen = () => {
      onOpen?.();
    };

    es.onerror = () => {
      if (disposed) return;
      closeEs();
      errors += 1;
      if (errors >= giveUpAfterErrors) {
        onGiveUp?.();
        if (poll) void startPolling();
        return;
      }
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void connect();
      }, retryBackoffMs);
    };
  }

  void connect();

  return {
    stop() {
      disposed = true;
      clearTimers();
      closeEs();
    },
  };
}
