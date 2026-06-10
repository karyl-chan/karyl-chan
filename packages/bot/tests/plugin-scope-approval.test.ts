/**
 * PM-3.1 — plugin RPC scope approval model.
 *
 * The manifest's declared `rpc_methods_used` are *requested* scopes; the
 * issued token is signed with only the admin-*approved* subset
 * (`plugins.approvedRpcScopes`). Coverage:
 *   1. auto-approve ON (default): requested scopes are granted on register
 *   2. auto-approve OFF, first register: nothing approved, all pending,
 *      token carries no scopes
 *   3. approveAllScopes: persists + updates the live token immediately
 *   4. approval is sticky across re-register; a newly-added scope stays
 *      pending while already-approved scopes stay granted
 *   5. dropping a requested scope on re-register removes it from approved
 *   6. setApprovedScopes clamps to the requested set (can't grant an
 *      undeclared scope)
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
});

// Mock host-policy so validateManifest doesn't SSRF-reject localhost.
vi.mock("../src/utils/host-policy.js", () => ({
  assertPluginTarget: vi.fn().mockResolvedValue(undefined),
  HostPolicyError: class HostPolicyError extends Error {},
}));

// Mock the event bridge so register() doesn't need the full event system.
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

// Mock pluginCommandRegistry so register() doesn't try to hit Discord.
vi.mock(
  "../src/modules/plugin-system/plugin-command-registry.service.js",
  () => ({
    pluginCommandRegistry: {
      assertNoCollisions: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      unregisterAll: vi.fn().mockResolvedValue(undefined),
      syncFeatureCommandsForGuild: vi.fn().mockResolvedValue(undefined),
    },
    ManifestCommandError: class ManifestCommandError extends Error {},
  }),
);

import { config } from "../src/config.js";
import { sequelize } from "../src/db.js";
import { Plugin } from "../src/modules/plugin-system/models/plugin.model.js";
import {
  PluginRegistry,
  type RegisterResult,
} from "../src/modules/plugin-system/plugin-registry.service.js";
import { PluginAuthStore } from "../src/modules/plugin-system/plugin-auth.service.js";

function makeManifest(scopes: string[], pluginKey = "scope-plugin") {
  return {
    schema_version: "1",
    plugin: {
      id: pluginKey,
      name: "Scope Plugin",
      version: "1.0.0",
      url: "http://localhost:9999",
    },
    rpc_methods_used: scopes,
  };
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
  // Restore the default; individual tests flip it as needed.
  config.plugin.autoApproveScopes = true;
});

/** Scopes the live token for `result` actually carries. */
function tokenScopes(result: RegisterResult): string[] {
  const rec = auth.verify(result.token);
  return rec ? [...rec.scopes].sort() : [];
}

describe("1. auto-approve ON (default)", () => {
  it("grants every requested scope on first register", async () => {
    const res = await registry.register(
      makeManifest(["messages.send", "config.get"]),
    );
    expect(tokenScopes(res)).toEqual(["config.get", "messages.send"]);

    const state = await registry.getScopeState(res.plugin.id);
    expect(state).toEqual({
      requested: ["messages.send", "config.get"],
      approved: ["messages.send", "config.get"],
      pending: [],
    });
  });
});

describe("2. auto-approve OFF, first register", () => {
  beforeEach(() => {
    config.plugin.autoApproveScopes = false;
  });

  it("approves nothing, marks all pending, issues a scope-less token", async () => {
    const res = await registry.register(
      makeManifest(["messages.send", "config.get"]),
    );
    expect(tokenScopes(res)).toEqual([]);

    const state = await registry.getScopeState(res.plugin.id);
    expect(state?.approved).toEqual([]);
    expect(state?.pending).toEqual(["messages.send", "config.get"]);
  });
});

describe("3. approveAllScopes", () => {
  beforeEach(() => {
    config.plugin.autoApproveScopes = false;
  });

  it("persists approval and updates the live token in place", async () => {
    const res = await registry.register(makeManifest(["messages.send"]));
    // Before approval the live token carries nothing.
    expect(tokenScopes(res)).toEqual([]);

    const state = await registry.approveAllScopes(res.plugin.id);
    expect(state).toEqual({
      requested: ["messages.send"],
      approved: ["messages.send"],
      pending: [],
    });
    // Same token string, scopes now present — no re-register needed.
    expect(tokenScopes(res)).toEqual(["messages.send"]);
    // And it's persisted.
    const reread = await registry.getScopeState(res.plugin.id);
    expect(reread?.approved).toEqual(["messages.send"]);
  });
});

describe("4. approval is sticky across re-register", () => {
  beforeEach(() => {
    config.plugin.autoApproveScopes = false;
  });

  it("keeps approved scopes and leaves a newly-added scope pending", async () => {
    const first = await registry.register(makeManifest(["messages.send"]));
    await registry.approveAllScopes(first.plugin.id);

    // Plugin re-registers asking for an extra scope.
    const second = await registry.register(
      makeManifest(["messages.send", "messages.delete"]),
    );
    // Already-approved scope still granted; the new one is withheld.
    expect(tokenScopes(second)).toEqual(["messages.send"]);

    const state = await registry.getScopeState(second.plugin.id);
    expect(state?.approved).toEqual(["messages.send"]);
    expect(state?.pending).toEqual(["messages.delete"]);
  });
});

describe("5. dropping a requested scope on re-register", () => {
  beforeEach(() => {
    config.plugin.autoApproveScopes = false;
  });

  it("removes the dropped scope from the approved set", async () => {
    const first = await registry.register(
      makeManifest(["messages.send", "config.get"]),
    );
    await registry.approveAllScopes(first.plugin.id);

    // Re-register without config.get.
    const second = await registry.register(makeManifest(["messages.send"]));
    expect(tokenScopes(second)).toEqual(["messages.send"]);

    const state = await registry.getScopeState(second.plugin.id);
    expect(state?.approved).toEqual(["messages.send"]);
    expect(state?.requested).toEqual(["messages.send"]);
  });
});

describe("6. setApprovedScopes clamps to the requested set", () => {
  beforeEach(() => {
    config.plugin.autoApproveScopes = false;
  });

  it("ignores scopes the manifest never declared", async () => {
    const res = await registry.register(makeManifest(["messages.send"]));
    // Admin tries to approve an extra, undeclared scope.
    const state = await registry.setApprovedScopes(res.plugin.id, [
      "messages.send",
      "messages.delete",
    ]);
    expect(state?.approved).toEqual(["messages.send"]);
    expect(tokenScopes(res)).toEqual(["messages.send"]);
  });
});
