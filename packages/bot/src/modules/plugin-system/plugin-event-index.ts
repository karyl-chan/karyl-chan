/**
 * Pure in-memory event subscription index (PM-8: route-aware).
 *
 * Owns `event_type → (pluginId → EventScope[])` forward lookup AND
 * `pluginId → route map` reverse lookup. Every subscription carries the
 * SCOPE it was declared under, because delivery semantics differ:
 *
 *   - `{ featureKey }` — declared on `guild_features[].events_subscribed`.
 *     Delivered only for guild-scoped events whose guild has that
 *     feature effectively enabled (3-tier resolution at dispatch time).
 *   - `"global"` — declared on `events_subscribed_global` AND approved
 *     by the operator (or PLUGIN_AUTO_APPROVE). Delivered regardless of
 *     guild — DM events, guild-less events, and explicit firehose
 *     grants. Approval is resolved at INDEX BUILD time: unapproved
 *     global subscriptions produce no route at all.
 *
 * No DB / network / fastify imports — keep this module pure so it can
 * be unit-tested under hosts that can't load sqlite3 natives. The
 * DB-driven entry points (rebuildEventIndex, applyPluginChange) live in
 * `plugin-event-bridge.service.ts` and feed into here.
 */

import type { PluginManifest } from "./plugin-sdk-types.js";

export type EventScope = "global" | { featureKey: string };

/** All routes one plugin holds for one event type. */
export interface PluginEventRoutes {
  pluginId: number;
  scopes: EventScope[];
}

export class EventIndex {
  /** eventType → (pluginId → scopes). */
  private map = new Map<string, Map<number, EventScope[]>>();
  /** pluginId → (eventType → scopes) — lets applyPlugin remove stale
   *  entries without scanning the full forward map. */
  private perPlugin = new Map<number, Map<string, EventScope[]>>();

  /** Full replace — used at startup. */
  setAll(perPlugin: Map<number, Map<string, EventScope[]>>): void {
    this.map = new Map();
    this.perPlugin = new Map();
    for (const [id, routes] of perPlugin) {
      this.applyPlugin(id, routes);
    }
  }

  /** Plugins subscribed to this type, with the scopes each holds. */
  routes(eventType: string): PluginEventRoutes[] {
    const inner = this.map.get(eventType);
    if (!inner) return [];
    return Array.from(inner, ([pluginId, scopes]) => ({ pluginId, scopes }));
  }

  /** Plugin-id list (scope-blind) — kept for diagnostics/tests. */
  subscribers(eventType: string): number[] {
    const inner = this.map.get(eventType);
    return inner ? Array.from(inner.keys()) : [];
  }

  hasSubscribers(eventType: string): boolean {
    const inner = this.map.get(eventType);
    return !!inner && inner.size > 0;
  }

  size(): number {
    return this.map.size;
  }

  /**
   * Replace plugin `id`'s routes. An empty map removes the plugin
   * entirely. O(|prev ∪ next|) — no full table scan.
   */
  applyPlugin(id: number, routes: Map<string, EventScope[]>): void {
    const prev = this.perPlugin.get(id);
    if (prev) {
      for (const ev of prev.keys()) {
        if (routes.has(ev)) continue;
        const inner = this.map.get(ev);
        if (inner) {
          inner.delete(id);
          if (inner.size === 0) this.map.delete(ev);
        }
      }
    }
    for (const [ev, scopes] of routes) {
      let inner = this.map.get(ev);
      if (!inner) {
        inner = new Map();
        this.map.set(ev, inner);
      }
      inner.set(id, scopes);
    }
    if (routes.size === 0) {
      this.perPlugin.delete(id);
    } else {
      this.perPlugin.set(id, new Map(routes));
    }
  }

  /** Test/debug — read both directions of the index. */
  snapshot(): {
    map: Map<string, Map<number, EventScope[]>>;
    perPlugin: Map<number, Map<string, EventScope[]>>;
  } {
    return { map: this.map, perPlugin: this.perPlugin };
  }
}

/**
 * Build the route map for one plugin from its manifest + the approved
 * global subscription set. Pure helper — no DB.
 *
 * `approvedGlobal` is the ALREADY-RESOLVED grant set: the caller passes
 * every declared global subscription when PLUGIN_AUTO_APPROVE is on, or
 * the persisted `approvedGlobalEventSubs ∩ declared` when it's off. A
 * declared-but-unapproved global subscription yields no route.
 *
 * The same event type may carry several scopes for one plugin (owned by
 * multiple features, or feature-owned AND globally approved) — each
 * scope is an independent delivery condition, checked at dispatch.
 */
export function collectEventRoutes(
  manifest: PluginManifest,
  approvedGlobal: ReadonlySet<string>,
): Map<string, EventScope[]> {
  const out = new Map<string, EventScope[]>();
  const push = (ev: unknown, scope: EventScope) => {
    if (typeof ev !== "string" || ev.length === 0) return;
    const scopes = out.get(ev);
    if (scopes) {
      scopes.push(scope);
    } else {
      out.set(ev, [scope]);
    }
  };
  for (const f of manifest.guild_features ?? []) {
    for (const e of f.events_subscribed ?? []) {
      push(e, { featureKey: f.key });
    }
  }
  for (const e of manifest.events_subscribed_global ?? []) {
    if (typeof e === "string" && approvedGlobal.has(e)) {
      push(e, "global");
    }
  }
  return out;
}

/**
 * Pull every `event_type` the manifest subscribes to (top-level
 * `events_subscribed_global` + per-feature `events_subscribed`),
 * approval-blind. Pure helper — used for "what does this plugin
 * declare?" surfaces (admin UI, pending-grant derivation), NOT for
 * routing.
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
