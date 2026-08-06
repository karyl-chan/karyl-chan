import { KV_VALUE_MAX_BYTES, quotaForGuildKv } from "./plugin-kv-quota.js";
import {
  getKv,
  incrementKv,
  setKv,
  sumGuildBytes,
  withGuildKvLock,
} from "./models/plugin-kv.model.js";

/**
 * Guild-KV quota *accounting*: the checked write, the counter increment's
 * usage read-back, and the usage report. One of exactly two service
 * extractions the plugin-facing RPC surface gets (#56) — the storage
 * routes keep transport (schema, scope check, status codes) and this
 * module owns the read-usage → check-budget → write → report sequence.
 *
 * Deliberately a sibling of `plugin-kv-quota.ts`, not part of it. That
 * module's name promises the quota *derivation* — a leaf both route
 * families share precisely so neither has to import the other (#46), and
 * Plugin Admin imports it for its usage read. Accounting, by contrast,
 * orchestrates writes on the plugin-facing surface; folding it into the
 * derivation module would hang write orchestration off the shared leaf
 * and hand Plugin Admin a dependency on plugin-actor behaviour.
 *
 * Behaviour notes, preserved verbatim from the handlers:
 *   - The per-row hard cap measures the *serialised* UTF-8 byte length
 *     (a JSON Schema string constraint counts characters, not bytes).
 *   - The budget check runs under the per-(plugin,guild) mutex so two
 *     concurrent writes to different keys can't both observe a stale
 *     total and slip past the quota.
 *   - Overwrites subtract the key's current bytes from the projection —
 *     writing at exactly the quota is allowed (`projected > quota`
 *     refuses, `===` passes).
 *   - `incrementGuildKv` does NOT enforce the guild quota — it never
 *     has; a counter's post-increment size drift is bounded by the
 *     per-key increment mutex and reported, not refused. Adding a check
 *     would be a behaviour change outside a refactor's licence.
 */

export type GuildKvWriteOutcome =
  | { ok: true; bytes: number; total_bytes: number; quota_bytes: number }
  | { ok: false; error: string };

/**
 * The checked write behind `storage.kv_set`. Refusals carry the exact
 * historical texts (both are 413s at the route): the per-row hard cap,
 * then — under the guild lock — the projected-total quota check.
 */
export async function writeGuildKv(
  pluginId: number,
  guildId: string,
  key: string,
  value: string,
): Promise<GuildKvWriteOutcome> {
  const incomingBytes = Buffer.byteLength(value, "utf8");
  if (incomingBytes > KV_VALUE_MAX_BYTES) {
    return {
      ok: false,
      error: `value exceeds per-row hard cap (${KV_VALUE_MAX_BYTES}B)`,
    };
  }
  return withGuildKvLock<GuildKvWriteOutcome>(pluginId, guildId, async () => {
    const quota = await quotaForGuildKv(pluginId);
    const currentTotal = await sumGuildBytes(pluginId, guildId);
    const existing = await getKv(pluginId, guildId, key);
    const projected = currentTotal - (existing?.bytes ?? 0) + incomingBytes;
    if (projected > quota) {
      return {
        ok: false,
        error: `would exceed plugin guild_kv quota (${projected}B / ${quota}B)`,
      };
    }
    const row = await setKv(pluginId, guildId, key, value);
    return {
      ok: true,
      bytes: row.bytes,
      total_bytes: currentTotal - (existing?.bytes ?? 0) + row.bytes,
      quota_bytes: quota,
    };
  });
}

/**
 * The counter increment behind `storage.kv_increment`, plus its usage
 * read-back. Model errors propagate — the route maps the
 * not-a-finite-number text to 422 (caller bug) and the rest to 500.
 */
export async function incrementGuildKv(
  pluginId: number,
  guildId: string,
  key: string,
  delta: number,
): Promise<{
  value: number;
  bytes: number;
  total_bytes: number;
  quota_bytes: number;
}> {
  const result = await incrementKv(pluginId, guildId, key, delta);
  const totalBytes = await sumGuildBytes(pluginId, guildId);
  const quotaBytes = await quotaForGuildKv(pluginId);
  return {
    value: result.value,
    bytes: result.row.bytes,
    total_bytes: totalBytes,
    quota_bytes: quotaBytes,
  };
}

/** The usage report behind `me.kv_usage`. */
export async function guildKvUsage(
  pluginId: number,
  guildId: string,
): Promise<{ used_bytes: number; quota_bytes: number }> {
  const used = await sumGuildBytes(pluginId, guildId);
  const quota = await quotaForGuildKv(pluginId);
  return { used_bytes: used, quota_bytes: quota };
}
