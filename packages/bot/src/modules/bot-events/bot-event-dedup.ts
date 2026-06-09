/**
 * In-memory dedup window for high-frequency BotEvent emissions.
 * Returns true if the key hasn't been seen within windowMs.
 *
 * State is purely in-memory — the window resets on process restart,
 * which is acceptable for rate-limit / flood-protection log suppression.
 */

import { config } from "../../config.js";

const DEFAULT_WINDOW_MS = config.botEvents.dedupWindowMs;
const MAX_KEYS = config.botEvents.dedupMaxKeys;

/** key → timestamp of last recorded emission */
const seen = new Map<string, number>();

export function shouldRecord(
  key: string,
  windowMs: number = DEFAULT_WINDOW_MS,
): boolean {
  const now = Date.now();
  const last = seen.get(key);
  if (last !== undefined && now - last < windowMs) {
    // Still inside the window → suppress. Refresh recency (delete + re-set
    // moves the key to the tail) WITHOUT changing its timestamp, so the
    // window is still measured from the last record — a frequently-recurring
    // key just stays "recently used" and won't be cap-evicted out from under
    // its own window.
    seen.delete(key);
    seen.set(key, last);
    return false;
  }
  // (Re-)record. Cap-eviction must drop the least-recently-USED key, not the
  // first-inserted one: `Map.set` on an existing key keeps its original
  // position, so the previous FIFO scheme could evict a fresh recurring key
  // (stranded at the head) while expired keys sat behind it — silently
  // bypassing dedup under high-cardinality churn (e.g. an IP-keyed flood).
  // Deleting then re-inserting on every access makes iteration order track
  // recency, so the head is the genuinely-oldest (expired/inactive) entry —
  // the correct victim.
  seen.delete(key);
  if (seen.size >= MAX_KEYS) {
    const lruKey = seen.keys().next().value as string;
    seen.delete(lruKey);
  }
  seen.set(key, now);
  return true;
}
