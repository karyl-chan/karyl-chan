/**
 * PM-7.1 — register response decoupled from Discord command sync.
 *
 * Incident (2026-06-11, first external plugin author): register()
 * awaited pluginCommandRegistry.sync() inside the HTTP handler; a
 * rate-limited Discord REST call wedged the response forever, the
 * plugin (pre-PM-7.2, no fetch timeout) hung with it, and every
 * dispatch was answered 503.
 *
 * Contract under test:
 *   1. register resolves with credentials while sync is still wedged
 *   2. single-flight: a register storm coalesces concurrent syncs,
 *      latest manifest wins, no concurrent sync for one pluginKey
 *   3. background sync failure → state "failed", register unaffected
 *   4. command-name collision rejects BEFORE anything is persisted
 *   5. RegisterThrottle sliding window math
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
});

vi.mock("../src/utils/host-policy.js", () => ({
  assertPluginTarget: vi.fn().mockResolvedValue(undefined),
  HostPolicyError: class HostPolicyError extends Error {},
}));

vi.mock("../src/modules/plugin-system/plugin-event-bridge.service.js", () => ({
  rebuildEventIndex: vi.fn().mockResolvedValue(undefined),
  dispatchEventToPlugins: vi.fn(),
  getEventIndexSize: vi.fn().mockReturnValue(0),
  applyPluginChange: vi.fn(),
  removePluginFromIndex: vi.fn(),
  dropDispatchPoolForPlugin: vi.fn(),
  getDispatchPoolSnapshot: vi.fn().mockReturnValue([]),
  stopDispatchPool: vi.fn().mockResolvedValue(undefined),
}));

const syncMock = vi.fn();
const assertNoCollisionsMock = vi.fn();
vi.mock(
  "../src/modules/plugin-system/plugin-command-registry.service.js",
  () => ({
    pluginCommandRegistry: {
      get sync() {
        return syncMock;
      },
      get assertNoCollisions() {
        return assertNoCollisionsMock;
      },
      unregisterAll: vi.fn().mockResolvedValue(undefined),
      syncFeatureCommandsForGuild: vi.fn().mockResolvedValue(undefined),
    },
    ManifestCommandError: class ManifestCommandError extends Error {},
  }),
);

import { sequelize } from "../src/db.js";
import { Plugin } from "../src/modules/plugin-system/models/plugin.model.js";
import { PluginRegistry } from "../src/modules/plugin-system/plugin-registry.service.js";
import { PluginAuthStore } from "../src/modules/plugin-system/plugin-auth.service.js";
import { ManifestCommandError } from "../src/modules/plugin-system/plugin-command-registry.service.js";
import { RegisterThrottle } from "../src/modules/plugin-system/plugin-routes.js";

function makeManifest(version = "1.0.0", pluginKey = "deferred-sync-plugin") {
  return {
    schema_version: "1",
    plugin: {
      id: pluginKey,
      name: "Deferred Sync Plugin",
      version,
      url: "http://localhost:9999",
    },
  };
}

/** A promise whose resolve/reject we control from the test body. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(cond()).toBe(true);
}

let auth: PluginAuthStore;
let registry: PluginRegistry;

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Plugin.destroy({ where: {} });
  auth = new PluginAuthStore();
  registry = new PluginRegistry(auth);
  syncMock.mockReset().mockResolvedValue(undefined);
  assertNoCollisionsMock.mockReset().mockResolvedValue(undefined);
});

describe("1. register resolves while sync is wedged", () => {
  it("returns credentials immediately; sync completes later", async () => {
    const gate = deferred();
    syncMock.mockReturnValue(gate.promise);

    const start = Date.now();
    const res = await registry.register(makeManifest());
    const elapsed = Date.now() - start;

    expect(res.token).toBeTruthy();
    expect(res.dispatchHmacKey).toBeTruthy();
    expect(elapsed).toBeLessThan(1_000);
    expect(
      registry.getCommandSyncState("deferred-sync-plugin")?.status,
    ).toBe("pending");

    gate.resolve();
    await waitFor(
      () =>
        registry.getCommandSyncState("deferred-sync-plugin")?.status === "ok",
    );
  });
});

describe("2. single-flight + latest-wins", () => {
  it("coalesces a register storm into ≤2 syncs, last manifest wins", async () => {
    const first = deferred();
    syncMock.mockReturnValueOnce(first.promise);

    await registry.register(makeManifest("1.0.0"));
    expect(syncMock).toHaveBeenCalledTimes(1);

    // Storm while the first sync is wedged: v2..v5 arrive.
    for (const v of ["2.0.0", "3.0.0", "4.0.0", "5.0.0"]) {
      await registry.register(makeManifest(v));
    }
    // Still only the first sync started — single-flight holds.
    expect(syncMock).toHaveBeenCalledTimes(1);

    first.resolve();
    await waitFor(
      () =>
        registry.getCommandSyncState("deferred-sync-plugin")?.status === "ok",
    );
    // Exactly one follow-up run for the coalesced storm, with the
    // LATEST manifest (5.0.0) — intermediates were dropped.
    expect(syncMock).toHaveBeenCalledTimes(2);
    const lastManifest = syncMock.mock.calls[1][1] as {
      plugin: { version: string };
    };
    expect(lastManifest.plugin.version).toBe("5.0.0");
  });
});

describe("3. background sync failure", () => {
  it("marks state failed with the error; register itself unaffected", async () => {
    syncMock.mockRejectedValue(new Error("discord exploded"));
    const res = await registry.register(makeManifest());
    expect(res.token).toBeTruthy();
    await waitFor(
      () =>
        registry.getCommandSyncState("deferred-sync-plugin")?.status ===
        "failed",
    );
    expect(
      registry.getCommandSyncState("deferred-sync-plugin")?.error,
    ).toContain("discord exploded");
  });
});

describe("4. collision rejects before persistence", () => {
  it("throws ManifestCommandError and leaves no row behind", async () => {
    assertNoCollisionsMock.mockRejectedValue(
      new ManifestCommandError("command 'login' is reserved"),
    );
    await expect(registry.register(makeManifest())).rejects.toThrow(
      /reserved/,
    );
    const row = await Plugin.findOne({
      where: { pluginKey: "deferred-sync-plugin" },
    });
    expect(row).toBeNull();
    expect(syncMock).not.toHaveBeenCalled();
  });
});

describe("5. RegisterThrottle", () => {
  it("allows `limit` hits per window, then 429s with Retry-After", () => {
    let now = 1_000_000;
    const throttle = new RegisterThrottle(3, 60_000, () => now);

    expect(throttle.hit("k")).toBeNull();
    expect(throttle.hit("k")).toBeNull();
    expect(throttle.hit("k")).toBeNull();
    const retryAfter = throttle.hit("k");
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    // Other keys have their own budget.
    expect(throttle.hit("other")).toBeNull();

    // Window slides: after 61s the oldest hits age out.
    now += 61_000;
    expect(throttle.hit("k")).toBeNull();
  });
});
