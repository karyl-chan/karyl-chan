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

interface AdapterCache {
  pluginMetricsStore?: PluginMetricsStore;
  pluginHealthStore?: PluginHealthStore;
  distributedLock?: DistributedLock;
  rateLimitStoreFactory?: RateLimitStoreFactory;
  voiceStateStore?: VoiceStateStore;
  sessionStore?: SessionStore;
}

const cache: AdapterCache = {};

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
    // Dynamic require to avoid pulling ioredis into a process that
    // never asks for Redis. Top-level import would always load the
    // module at boot.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RedisSessionStore } = require("./redis/session-store.js") as {
      RedisSessionStore: new () => SessionStore;
    };
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
export function __resetAdaptersForTests(): void {
  cache.pluginMetricsStore = undefined;
  cache.pluginHealthStore = undefined;
  cache.distributedLock = undefined;
  cache.rateLimitStoreFactory = undefined;
  cache.voiceStateStore = undefined;
  cache.sessionStore = undefined;
}
