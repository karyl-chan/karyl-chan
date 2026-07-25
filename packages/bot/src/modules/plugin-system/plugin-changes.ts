/**
 * Plugin Change notifier (#27) — the in-process seam between the modules
 * that OWN plugin mutations and the caches that must react to them.
 *
 * Mutation owners (plugin registry register/deregister/setEnabled/reaper,
 * the admin feature-write routes, hard delete) emit; subscribers — the
 * feature-reach cache and the event-dispatch index — invalidate or
 * re-index themselves. Emitters never name a cache; a new cache
 * subscribes here instead of adding another call site to every mutation.
 *
 * Payload semantics:
 *   - `guildId` present  → a one-guild feature write. Plugin-wide state
 *     is untouched.
 *   - `row` a PluginRow  → a plugin-lifecycle mutation; this is the
 *     post-mutation row (register, enable/disable, revive, grant change).
 *   - `row` null         → the plugin is gone from dispatch (hard delete,
 *     graceful deregister, heartbeat expiry).
 *   - `row` undefined, no `guildId` → plugin-wide config change that
 *     doesn't alter the row itself (e.g. an operator feature-default
 *     write).
 *
 * Fan-out is synchronous — the emitting mutation completes with every
 * cache already invalidated, preserving the read-after-write behavior
 * the direct invalidation calls used to give. A throwing subscriber is
 * isolated: it never breaks the mutation or starves other subscribers.
 */

import type { PluginRow } from "./models/plugin.model.js";
import { moduleLogger } from "../../logger.js";

const log = moduleLogger("plugin-changes");

export interface PluginChange {
  pluginId: number;
  /** Present for a one-guild feature write; absent for plugin-wide changes. */
  guildId?: string;
  /** Post-mutation row for lifecycle changes; null when the plugin is
   *  gone; undefined when the row itself didn't change. */
  row?: PluginRow | null;
}

type PluginChangeSubscriber = (change: PluginChange) => void;

const subscribers = new Set<PluginChangeSubscriber>();

/** Subscribe to Plugin Changes. Returns an unsubscribe function. */
export function onPluginChange(fn: PluginChangeSubscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Notify every subscriber of a Plugin Change. Never throws. */
export function emitPluginChange(change: PluginChange): void {
  for (const fn of subscribers) {
    try {
      fn(change);
    } catch (err) {
      log.error({ err, pluginId: change.pluginId }, "plugin-change subscriber failed");
    }
  }
}
