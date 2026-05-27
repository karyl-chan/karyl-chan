/**
 * Central factory for every adapter. Code that wants a store calls
 * `getXxxStore()` instead of importing a specific implementation.
 *
 * Boot-time env selection: each factory looks at a single env var
 * (e.g. `SESSION_STORE`) and routes accordingly. Unset / `inprocess`
 * → the in-process default; future Phase 1+ values like
 * `redis://host:port` select the Redis adapter (not yet implemented).
 *
 * The factories are lazy singletons — the first caller decides the
 * implementation for the process lifetime. Tests can reset state
 * with `__resetAdaptersForTests()` (test-only export).
 */

import {
  type PluginHealthStore,
  InProcessPluginHealthStore,
} from "./plugin-health-store.js";
import {
  type PluginMetricsStore,
  InProcessPluginMetricsStore,
} from "./plugin-metrics-store.js";
import {
  type DistributedLock,
  InProcessDistributedLock,
} from "./distributed-lock.js";
import {
  type RateLimitStoreFactory,
  InProcessRateLimitStoreFactory,
} from "./rate-limit-store.js";
import {
  type VoiceStateStore,
  InProcessVoiceStateStore,
} from "./voice-state-store.js";
import { type SessionStore } from "./session-store.js";
import { InProcessSessionStore } from "./in-process-session-store.js";
import { type PluginEventBus } from "./plugin-event-bus.js";
import { RedisPluginMetricsStore } from "./redis/plugin-metrics-store.js";
import { RedisPluginHealthStore } from "./redis/plugin-health-store.js";
import { RedisDistributedLock } from "./redis/distributed-lock.js";
import { RedisRateLimitStoreFactory } from "./redis/rate-limit-store.js";
import { RedisSessionStore } from "./redis/session-store.js";
import { RedisStreamsPluginEventBus } from "./redis/plugin-event-bus.js";

interface AdapterCache {
  pluginMetricsStore?: PluginMetricsStore;
  pluginHealthStore?: PluginHealthStore;
  distributedLock?: DistributedLock;
  rateLimitStoreFactory?: RateLimitStoreFactory;
  voiceStateStore?: VoiceStateStore;
  sessionStore?: SessionStore;
  pluginEventBus?: PluginEventBus;
}

const cache: AdapterCache = {};

// Static imports of the Redis impls are intentional: loading the JS
// module is cheap, and the actual Redis TCP connection only opens on
// first `getRedisClient()` call (see redis/client.ts). The original
// dynamic-require pattern broke under ESM (ReferenceError: require is
// not defined) and silently sank Phase 1 in production.

function envChoice(envVar: string): string {
  return (process.env[envVar] ?? "").trim().toLowerCase();
}

function unknownImpl(envVar: string, value: string): never {
  throw new Error(
    `Unknown ${envVar} implementation: '${value}'. ` +
      `Set ${envVar}=inprocess (or unset) for the single-host default. ` +
      `Other values are reserved for Phase 1+ implementations.`,
  );
}

export function getPluginMetricsStore(): PluginMetricsStore {
  if (cache.pluginMetricsStore) return cache.pluginMetricsStore;
  const choice = envChoice("PLUGIN_METRICS_STORE");
  if (choice === "" || choice === "inprocess") {
    cache.pluginMetricsStore = new InProcessPluginMetricsStore();
  } else if (choice === "redis") {
    cache.pluginMetricsStore = new RedisPluginMetricsStore();
  } else {
    unknownImpl("PLUGIN_METRICS_STORE", choice);
  }
  return cache.pluginMetricsStore;
}

export function getPluginHealthStore(): PluginHealthStore {
  if (cache.pluginHealthStore) return cache.pluginHealthStore;
  const choice = envChoice("PLUGIN_HEALTH_STORE");
  if (choice === "" || choice === "inprocess") {
    cache.pluginHealthStore = new InProcessPluginHealthStore();
  } else if (choice === "redis") {
    cache.pluginHealthStore = new RedisPluginHealthStore();
  } else {
    unknownImpl("PLUGIN_HEALTH_STORE", choice);
  }
  return cache.pluginHealthStore;
}

export function getDistributedLock(): DistributedLock {
  if (cache.distributedLock) return cache.distributedLock;
  const choice = envChoice("DISTRIBUTED_LOCK");
  if (choice === "" || choice === "inprocess") {
    cache.distributedLock = new InProcessDistributedLock();
  } else if (choice === "redis") {
    cache.distributedLock = new RedisDistributedLock();
  } else {
    unknownImpl("DISTRIBUTED_LOCK", choice);
  }
  return cache.distributedLock;
}

export function getRateLimitStoreFactory(): RateLimitStoreFactory {
  if (cache.rateLimitStoreFactory) return cache.rateLimitStoreFactory;
  const choice = envChoice("RATE_LIMIT_STORE");
  if (choice === "" || choice === "inprocess") {
    cache.rateLimitStoreFactory = new InProcessRateLimitStoreFactory();
  } else if (choice === "redis") {
    cache.rateLimitStoreFactory = new RedisRateLimitStoreFactory();
  } else {
    unknownImpl("RATE_LIMIT_STORE", choice);
  }
  return cache.rateLimitStoreFactory;
}

export function getSessionStore(): SessionStore {
  if (cache.sessionStore) return cache.sessionStore;
  const choice = envChoice("SESSION_STORE");
  if (choice === "" || choice === "inprocess") {
    cache.sessionStore = new InProcessSessionStore();
  } else if (choice === "redis") {
    cache.sessionStore = new RedisSessionStore();
  } else {
    unknownImpl("SESSION_STORE", choice);
  }
  return cache.sessionStore;
}

export function getVoiceStateStore(): VoiceStateStore {
  if (cache.voiceStateStore) return cache.voiceStateStore;
  const choice = envChoice("VOICE_STATE_STORE");
  if (choice === "" || choice === "inprocess") {
    cache.voiceStateStore = new InProcessVoiceStateStore();
  } else {
    unknownImpl("VOICE_STATE_STORE", choice);
  }
  return cache.voiceStateStore;
}

/**
 * Test-only — drop every cached singleton so the next call rebuilds
 * with the current env. Do NOT call from production code; the
 * adapters hold open resources (DB connections in later phases).
 */
/**
 * Optional event bus — `null` is a valid answer here meaning "use
 * the legacy HTTP fan-out path baked into plugin-event-bridge".
 * Phase 2.2 ships the Redis Streams producer; the SDK consumer ships
 * in a follow-up. Until then, setting EVENT_BUS=redis-streams should
 * be paired with an SDK ≥ 0.8 consumer or events go into the void.
 */
export function getPluginEventBus(): PluginEventBus | null {
  if (cache.pluginEventBus) return cache.pluginEventBus;
  const choice = envChoice("EVENT_BUS");
  if (choice === "" || choice === "http" || choice === "inprocess") {
    // The legacy HTTP path lives inside plugin-event-bridge directly,
    // so the bus pointer stays null and that module's existing logic
    // runs unchanged.
    return null;
  }
  if (choice === "redis-streams") {
    cache.pluginEventBus = new RedisStreamsPluginEventBus();
    return cache.pluginEventBus;
  }
  unknownImpl("EVENT_BUS", choice);
}

export function __resetAdaptersForTests(): void {
  cache.pluginMetricsStore = undefined;
  cache.pluginHealthStore = undefined;
  cache.distributedLock = undefined;
  cache.rateLimitStoreFactory = undefined;
  cache.voiceStateStore = undefined;
  cache.sessionStore = undefined;
  cache.pluginEventBus = undefined;
}
