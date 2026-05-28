/**
 * Typed `storage.kv_*` namespace.
 *
 * Wraps the bot's per-guild key-value store with an opinionated JSON
 * codec — every prior plugin re-implemented stringify/parse, key
 * conventions, and quota-error narrowing by hand. The wire shape stays
 * `{ value: string }` (the bot enforces a per-row byte cap on the
 * serialised form) but the facade narrows that into `T` for the caller.
 *
 * Per-guild only. The bot has no global namespace; cross-guild indexes
 * must be built outside KV (e.g. a per-process Set seeded from
 * `me.enabledGuilds()`).
 */

import type { RpcCaller } from "./index.js";

/** Hard cap on key length the bot will accept (see `KV_KEY_MAX`). */
export const KV_KEY_MAX = 256;
/** Hard cap on serialised value bytes (see `KV_VALUE_MAX_BYTES`). */
export const KV_VALUE_MAX_BYTES = 64 * 1024;

export interface KvListOptions {
  prefix?: string;
  limit?: number;
  offset?: number;
}

export interface KvEntry<T> {
  key: string;
  value: T;
  bytes: number;
}

export interface KvSetResult {
  bytes: number;
  totalBytes: number;
  quotaBytes: number;
}

export interface KvIncrementResult {
  value: number;
  bytes: number;
  totalBytes: number;
  quotaBytes: number;
}

/**
 * Typed per-guild KV handle. Generic over the value shape — call sites
 * pick `T` per logical key family:
 *
 * ```ts
 * interface Reminder { id: string; dueAtMs: number; text: string }
 * const kv = ctx.kv.guild<Reminder>(guildId);
 * await kv.set(`r:${row.id}`, row);
 * const all = await kv.listValues({ prefix: "r:" });
 * ```
 *
 * Reads parse JSON; writes stringify and check the per-row byte cap
 * before the network call (a clear thrown error beats a 413 round-trip
 * for obviously-too-big payloads). The bot still enforces the cap and
 * the per-guild quota authoritatively.
 */
export interface GuildKv<T> {
  get(key: string): Promise<T | null>;
  set(key: string, value: T): Promise<KvSetResult>;
  delete(key: string): Promise<boolean>;
  /**
   * Numeric increment. The stored value must parse as a finite number.
   * Atomic via a per-(plugin, guild, key) mutex on the bot side.
   * `T` is ignored — increment always reads/writes a number.
   */
  increment(key: string, delta?: number): Promise<KvIncrementResult>;
  /** Keys only — cheap. Use `listValues` when you also need the payloads. */
  list(options?: KvListOptions): Promise<{ keys: string[]; total: number }>;
  /** Keys + parsed values in one call. Replaces the legacy N+1 pattern. */
  listValues(options?: KvListOptions): Promise<{
    entries: KvEntry<T>[];
    total: number;
  }>;
  /** Quota probe. Cheap; no row payloads read. */
  usage(): Promise<{ usedBytes: number; quotaBytes: number }>;
}

export interface Kv {
  /** Per-guild handle. `T` defaults to `unknown` when omitted. */
  guild<T = unknown>(guildId: string): GuildKv<T>;
}

function assertKeyLength(key: string): void {
  if (key.length === 0) {
    throw new Error("kv: key must be non-empty");
  }
  if (key.length > KV_KEY_MAX) {
    throw new Error(
      `kv: key length ${key.length} exceeds KV_KEY_MAX (${KV_KEY_MAX})`,
    );
  }
}

function assertValueSize(value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > KV_VALUE_MAX_BYTES) {
    throw new Error(
      `kv: serialised value ${bytes}B exceeds KV_VALUE_MAX_BYTES (${KV_VALUE_MAX_BYTES})`,
    );
  }
}

export function createKv(call: RpcCaller): Kv {
  return {
    guild<T = unknown>(guildId: string): GuildKv<T> {
      return {
        async get(key) {
          assertKeyLength(key);
          const res = (await call("/api/plugin/storage.kv_get", {
            guild_id: guildId,
            key,
          })) as { found?: boolean; value?: string | null };
          if (!res.found || typeof res.value !== "string") return null;
          try {
            return JSON.parse(res.value) as T;
          } catch {
            // Stored value isn't JSON — surface as null rather than
            // throwing inside hot scheduler loops. The caller can
            // inspect `list()` if they need to investigate.
            return null;
          }
        },
        async set(key, value) {
          assertKeyLength(key);
          const serialised = JSON.stringify(value);
          assertValueSize(serialised);
          const res = (await call("/api/plugin/storage.kv_set", {
            guild_id: guildId,
            key,
            value: serialised,
          })) as {
            bytes?: number;
            total_bytes?: number;
            quota_bytes?: number;
          };
          return {
            bytes: typeof res.bytes === "number" ? res.bytes : 0,
            totalBytes:
              typeof res.total_bytes === "number" ? res.total_bytes : 0,
            quotaBytes:
              typeof res.quota_bytes === "number" ? res.quota_bytes : 0,
          };
        },
        async delete(key) {
          assertKeyLength(key);
          const res = (await call("/api/plugin/storage.kv_delete", {
            guild_id: guildId,
            key,
          })) as { removed?: boolean };
          return res.removed === true;
        },
        async increment(key, delta) {
          assertKeyLength(key);
          const res = (await call("/api/plugin/storage.kv_increment", {
            guild_id: guildId,
            key,
            ...(delta !== undefined ? { delta } : {}),
          })) as {
            value?: number;
            bytes?: number;
            total_bytes?: number;
            quota_bytes?: number;
          };
          return {
            value: typeof res.value === "number" ? res.value : 0,
            bytes: typeof res.bytes === "number" ? res.bytes : 0,
            totalBytes:
              typeof res.total_bytes === "number" ? res.total_bytes : 0,
            quotaBytes:
              typeof res.quota_bytes === "number" ? res.quota_bytes : 0,
          };
        },
        async list(options) {
          const res = (await call("/api/plugin/storage.kv_list", {
            guild_id: guildId,
            ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
            ...(options?.limit !== undefined ? { limit: options.limit } : {}),
            ...(options?.offset !== undefined ? { offset: options.offset } : {}),
          })) as { keys?: string[]; total?: number };
          return {
            keys: Array.isArray(res.keys)
              ? res.keys.filter((k): k is string => typeof k === "string")
              : [],
            total: typeof res.total === "number" ? res.total : 0,
          };
        },
        async listValues(options) {
          const res = (await call("/api/plugin/storage.kv_list_values", {
            guild_id: guildId,
            ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
            ...(options?.limit !== undefined ? { limit: options.limit } : {}),
            ...(options?.offset !== undefined ? { offset: options.offset } : {}),
          })) as {
            entries?: { key: string; value: string; bytes: number }[];
            total?: number;
          };
          const entries: KvEntry<T>[] = [];
          for (const e of res.entries ?? []) {
            try {
              entries.push({
                key: e.key,
                value: JSON.parse(e.value) as T,
                bytes: e.bytes,
              });
            } catch {
              // Skip rows with non-JSON payloads — they were written
              // by a different code path (raw string via `botRpc`)
              // and don't fit `T`. List-with-keys still surfaces them.
            }
          }
          return {
            entries,
            total: typeof res.total === "number" ? res.total : 0,
          };
        },
        async usage() {
          const res = (await call("/api/plugin/me/kv_usage", {
            guild_id: guildId,
          })) as { used_bytes?: number; quota_bytes?: number };
          return {
            usedBytes: typeof res.used_bytes === "number" ? res.used_bytes : 0,
            quotaBytes:
              typeof res.quota_bytes === "number" ? res.quota_bytes : 0,
          };
        },
      };
    },
  };
}
