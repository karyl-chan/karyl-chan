/**
 * Pure (Redis-free) helpers for the Streams event transport.
 *
 * Everything here is a plain function over data the consumer already
 * pulled off the wire — no ioredis import — so the parsing / DLQ-routing
 * / lag-computation logic is unit-testable without a live Redis.
 *
 * Wire contract (set by the bot producer in
 * `adapters/redis/plugin-event-bus.ts`):
 *
 *   stream key:  karyl:plugin:<pluginKey>:events   (the plugin's mailbox)
 *   fields:
 *     type        → event type string
 *     data        → JSON-encoded payload (verbatim from the dispatcher)
 *     trace       → traceparent header value
 *     traceparent → same value under the canonical header name
 *
 * PM-8: the producer XADDs into ONE PRIVATE stream per plugin, after
 * the bot's reach gates (feature-enablement per guild, approved global
 * grants) have passed for that plugin. The previous shared
 * stream-per-event-type model let any consumer read the full firehose
 * regardless of what the bot decided — per-plugin mailboxes make the
 * enforcement hold on this transport too. The consumer group still
 * gives the plugin an independent cursor + pending-entries list.
 */

/** All plugin mailbox streams live under this prefix (PM-8). Keep in
 *  sync with the bot's `PLUGIN_STREAM_PREFIX` (adapters/redis). */
export const PLUGIN_STREAM_PREFIX = "karyl:plugin:";

/** Suffix appended to a stream key to form its dead-letter stream. */
export const DLQ_SUFFIX = ":dlq";

/** Build a plugin's private mailbox stream key. */
export function pluginStreamKeyFor(pluginKey: string): string {
  return `${PLUGIN_STREAM_PREFIX}${pluginKey}:events`;
}

/** Build a plugin mailbox's dead-letter stream key. */
export function pluginDlqKeyFor(pluginKey: string): string {
  return `${pluginStreamKeyFor(pluginKey)}${DLQ_SUFFIX}`;
}

/**
 * A single decoded stream entry. `id` is the Redis entry id
 * (`<ms>-<seq>`); `type` / `data` come from the fields. `raw` keeps the
 * original flat field array so a DLQ re-XADD can preserve every field
 * (including ones a future producer adds) without lossy re-encoding.
 */
export interface ParsedStreamEntry {
  id: string;
  type: string;
  data: unknown;
  traceparent: string | null;
  raw: string[];
}

/**
 * Decode one XREADGROUP / XAUTOCLAIM entry: `[id, [f1, v1, f2, v2, …]]`.
 *
 * Returns null when the entry is structurally unusable (missing id,
 * odd field count, no `type`, or `data` that isn't valid JSON) — the
 * caller treats a null as a poison entry and routes it straight to the
 * DLQ rather than redelivering it forever.
 */
export function parseStreamEntry(
  entry: [string, string[]] | unknown,
): ParsedStreamEntry | null {
  if (!Array.isArray(entry) || entry.length < 2) return null;
  const [id, fields] = entry as [unknown, unknown];
  if (typeof id !== "string" || id.length === 0) return null;
  if (!Array.isArray(fields) || fields.length % 2 !== 0) return null;

  const map: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const k = fields[i];
    const v = fields[i + 1];
    if (typeof k === "string" && typeof v === "string") map[k] = v;
  }

  const type = map.type;
  if (typeof type !== "string" || type.length === 0) return null;

  // `data` is optional on the wire (an event with no payload is legal),
  // but if present it must be valid JSON — a malformed body is poison.
  let data: unknown = {};
  if (typeof map.data === "string") {
    try {
      data = JSON.parse(map.data);
    } catch {
      return null;
    }
  }

  const traceparent =
    typeof map.traceparent === "string"
      ? map.traceparent
      : typeof map.trace === "string"
        ? map.trace
        : null;

  return {
    id,
    type,
    data,
    traceparent,
    raw: fields.filter((f): f is string => typeof f === "string"),
  };
}

/**
 * Decision for a pending (already-delivered-but-unacked) entry surfaced
 * by `XAUTOCLAIM`. We compare the entry's delivery count against the
 * configured ceiling.
 *
 *   - `retry`: still under the ceiling — re-run the handler.
 *   - `dlq`: hit the ceiling — move it to the dead-letter stream and
 *     XACK it off the source so it stops blocking the group's PEL.
 *
 * A poison entry (parse failure) is always `dlq` regardless of count;
 * that decision is made by the caller, which calls this only for
 * parseable entries.
 */
export type RedeliveryDecision = "retry" | "dlq";

export function decideRedelivery(
  deliveryCount: number,
  maxDeliveries: number,
): RedeliveryDecision {
  // `deliveryCount` is XAUTOCLAIM's per-entry delivery counter, which is
  // 1 on the first (re)claim. We DLQ once it has been delivered at
  // least `maxDeliveries` times — i.e. the handler has had that many
  // chances and still never acked.
  return deliveryCount >= maxDeliveries ? "dlq" : "retry";
}

/**
 * Consumer-group lag = entries added to the stream but not yet acked by
 * this group. Redis 7's `XINFO GROUPS` exposes `lag` directly, but on
 * older servers (or when the stream was trimmed under the group's
 * cursor) it can be null; in that case we fall back to
 * `entries-read`-vs-length math the caller supplies.
 *
 * Pure: takes the already-fetched numbers, returns a non-negative lag.
 */
export function computeLag(input: {
  /** `lag` from XINFO GROUPS, or null if the server didn't report it. */
  reportedLag: number | null;
  /** Current XLEN of the stream. */
  streamLength: number;
  /** Entries the group has read (`entries-read` from XINFO GROUPS). */
  entriesRead: number | null;
}): number {
  if (input.reportedLag !== null && Number.isFinite(input.reportedLag)) {
    return Math.max(0, input.reportedLag);
  }
  if (input.entriesRead !== null && Number.isFinite(input.entriesRead)) {
    return Math.max(0, input.streamLength - input.entriesRead);
  }
  // No usable signal — report the whole stream length as worst-case lag
  // so the operator at least sees "something is unconsumed".
  return Math.max(0, input.streamLength);
}
