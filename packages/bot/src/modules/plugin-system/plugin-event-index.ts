/**
 * Pure in-memory event subscription index.
 *
 * Owns `event_type → Set<pluginId>` forward lookup AND `pluginId →
 * Set<event_type>` reverse lookup. The reverse lookup is what lets
 * an incremental update know which entries to remove on unsubscribe
 * without scanning the full forward map.
 *
 * No DB / network / fastify imports — keep this module pure so it
 * can be unit-tested under hosts that can't load sqlite3 natives.
 * The DB-driven entry points (rebuildEventIndex, applyPluginChange)
 * live in `plugin-event-bridge.service.ts` and feed into here.
 */

import type { PluginManifest } from "./plugin-sdk-types.js";

export class EventIndex {
  private map = new Map<string, Set<number>>();
  private perPlugin = new Map<number, Set<string>>();

  /** Full replace — used at startup. Internal state is reset. */
  setAll(
    map: Map<string, Set<number>>,
    perPlugin: Map<number, Set<string>>,
  ): void {
    this.map = map;
    this.perPlugin = perPlugin;
  }

  subscribers(eventType: string): number[] {
    const s = this.map.get(eventType);
    return s ? Array.from(s) : [];
  }

  hasSubscribers(eventType: string): boolean {
    const s = this.map.get(eventType);
    return !!s && s.size > 0;
  }

  size(): number {
    return this.map.size;
  }

  /**
   * Replace plugin `id`'s subscriptions with `events`. If `events` is
   * empty, every existing entry for this plugin is removed and the
   * per-plugin record is dropped. O(|prev ∪ next|) — no full table scan.
   */
  applyPlugin(id: number, events: Set<string>): void {
    const prev = this.perPlugin.get(id) ?? new Set<string>();
    for (const ev of prev) {
      if (events.has(ev)) continue;
      const set = this.map.get(ev);
      if (set) {
        set.delete(id);
        if (set.size === 0) this.map.delete(ev);
      }
    }
    for (const ev of events) {
      let set = this.map.get(ev);
      if (!set) {
        set = new Set();
        this.map.set(ev, set);
      }
      set.add(id);
    }
    if (events.size === 0) {
      this.perPlugin.delete(id);
    } else {
      this.perPlugin.set(id, new Set(events));
    }
  }

  /** Test/debug — read both directions of the index. */
  snapshot(): {
    map: Map<string, Set<number>>;
    perPlugin: Map<number, Set<string>>;
  } {
    return { map: this.map, perPlugin: this.perPlugin };
  }
}

/**
 * Pull every `event_type` the manifest subscribes to (top-level
 * `events_subscribed_global` + per-feature `events_subscribed`).
 * Pure helper — no DB.
 */
export function collectSubscribedEvents(manifest: PluginManifest): Set<string> {
  const out = new Set<string>();
  for (const e of manifest.events_subscribed_global ?? []) {
    if (typeof e === "string" && e.length > 0) out.add(e);
  }
  for (const f of manifest.guild_features ?? []) {
    for (const e of f.events_subscribed ?? []) {
      if (typeof e === "string" && e.length > 0) out.add(e);
    }
  }
  return out;
}

/** Parse a stored manifest JSON safely. Returns null on invalid JSON. */
export function parseManifestJson(json: string): PluginManifest | null {
  try {
    return JSON.parse(json) as PluginManifest;
  } catch {
    return null;
  }
}
