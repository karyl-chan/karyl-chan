/**
 * Build-time validation in the v2 plugin constructors:
 *   - definePluginCommand: name format + non-empty description
 *   - defineGuildFeature: key format + non-empty name
 *   - definePlugin: command names unique across pluginCommands AND
 *     every guildFeatures[].commands[] (they share one /commands/:name
 *     dispatch map)
 *
 * Also covers PluginClient.getPublicBaseUrl() — parsing from register
 * and heartbeat responses.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import {
  definePlugin,
  definePluginCommand,
  defineGuildFeature,
} from "../src/plugin.js";
import { startPluginClient } from "../src/client.js";

const okCmd = (name: string) =>
  definePluginCommand({
    name,
    description: "test command",
    scope: "guild",
    integrationTypes: ["guild_install"],
    contexts: ["Guild"],
    handler: async () => "ok",
  });

describe("definePluginCommand validation", () => {
  it("accepts a well-formed command", () => {
    assert.equal(okCmd("radio").name, "radio");
    assert.equal(okCmd("foo-bar2").name, "foo-bar2");
  });
  it("rejects a bad name", () => {
    assert.throws(() => okCmd("Radio"), /must match/i); // uppercase
    assert.throws(() => okCmd("has space"), /must match/i);
    assert.throws(() => okCmd(""), /must match/i);
    assert.throws(() => okCmd("x".repeat(33)), /must match/i); // too long
  });
  it("rejects an empty description", () => {
    assert.throws(
      () =>
        definePluginCommand({
          name: "x",
          description: "  ",
          scope: "guild",
          integrationTypes: ["guild_install"],
          contexts: ["Guild"],
          handler: async () => "ok",
        }),
      /description/i,
    );
  });
});

describe("defineGuildFeature validation", () => {
  it("accepts a well-formed feature", () => {
    const f = defineGuildFeature({
      key: "radio",
      name: "Karyl Radio",
      enabledByDefault: false,
      commands: [okCmd("radio")],
    });
    assert.equal(f.key, "radio");
  });
  it("rejects a bad key", () => {
    assert.throws(
      () => defineGuildFeature({ key: "Radio", name: "X" }),
      /must match/i,
    );
    assert.throws(() => defineGuildFeature({ key: "", name: "X" }), /must match/i);
  });
  it("rejects an empty name", () => {
    assert.throws(
      () => defineGuildFeature({ key: "radio", name: "  " }),
      /name/i,
    );
  });
});

describe("definePlugin command-name uniqueness", () => {
  const base = {
    key: "test-plugin",
    name: "Test",
    version: "0.1.0",
    rpcMethodsUsed: [],
    storage: { guildKv: false },
  };

  it("accepts disjoint command names across pluginCommands + guildFeatures", () => {
    const p = definePlugin({
      ...base,
      pluginCommands: [okCmd("alpha")],
      guildFeatures: [
        defineGuildFeature({ key: "f1", name: "F1", commands: [okCmd("beta")] }),
        defineGuildFeature({ key: "f2", name: "F2", commands: [okCmd("gamma")] }),
      ],
    });
    assert.equal(p.config.key, "test-plugin");
  });

  it("throws on a duplicate name within guildFeatures", () => {
    assert.throws(
      () =>
        definePlugin({
          ...base,
          guildFeatures: [
            defineGuildFeature({ key: "f1", name: "F1", commands: [okCmd("dup")] }),
            defineGuildFeature({ key: "f2", name: "F2", commands: [okCmd("dup")] }),
          ],
        }),
      /duplicate command name "dup"/,
    );
  });

  it("throws when a guild-feature command collides with a pluginCommand", () => {
    assert.throws(
      () =>
        definePlugin({
          ...base,
          pluginCommands: [okCmd("clash")],
          guildFeatures: [
            defineGuildFeature({ key: "f1", name: "F1", commands: [okCmd("clash")] }),
          ],
        }),
      /duplicate command name "clash"/,
    );
  });
});

// ── PluginClient.getPublicBaseUrl() ──────────────────────────────────────────

describe("PluginClient.getPublicBaseUrl()", () => {
  // We intercept fetch to return controlled responses.
  const originalFetch = globalThis.fetch;

  type FetchFn = typeof fetch;
  let fetchImpl: FetchFn;

  before(() => {
    // Replace global fetch with a proxy that delegates to fetchImpl.
    (globalThis as unknown as Record<string, unknown>)["fetch"] = (
      ...args: Parameters<FetchFn>
    ) => fetchImpl(...args);
  });

  after(() => {
    (globalThis as unknown as Record<string, unknown>)["fetch"] = originalFetch;
  });

  function makeRegisterRes(body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function makeHeartbeatRes(body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("returns the publicBaseUrl from the register response", async () => {
    const registerBody = {
      token: "tok-abc",
      dispatchHmacKey: "key-abc",
      sessionVerifyPublicKey: "spki-abc",
      publicBaseUrl: "http://localhost:902/plugin/test-plugin",
      heartbeat: { interval_seconds: 999 },
    };
    let callCount = 0;
    fetchImpl = async () => {
      callCount++;
      return makeRegisterRes(registerBody);
    };

    const client = startPluginClient({
      botUrl: "http://bot",
      setupSecret: "secret",
      manifest: {
        plugin: { id: "test-plugin", name: "Test", version: "0.1.0", url: "http://test-plugin:3000" },
      },
    });

    // Wait for the async register to complete.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.equal(
      client.getPublicBaseUrl(),
      "http://localhost:902/plugin/test-plugin",
    );
    client.stop();
  });

  it("returns undefined when publicBaseUrl is absent from the register response", async () => {
    const registerBody = {
      token: "tok-xyz",
      dispatchHmacKey: "key-xyz",
      sessionVerifyPublicKey: "spki-xyz",
      // no publicBaseUrl field
      heartbeat: { interval_seconds: 999 },
    };
    fetchImpl = async () => makeRegisterRes(registerBody);

    const client = startPluginClient({
      botUrl: "http://bot",
      setupSecret: "secret",
      manifest: {
        plugin: { id: "test-plugin", name: "Test", version: "0.1.0", url: "http://test-plugin:3000" },
      },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.equal(client.getPublicBaseUrl(), undefined);
    client.stop();
  });

  it("updates publicBaseUrl from a heartbeat response", async () => {
    let callCount = 0;
    fetchImpl = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/heartbeat")) {
        callCount++;
        return makeHeartbeatRes({
          sessionVerifyPublicKey: "spki-hb",
          publicBaseUrl: "http://localhost:902/plugin/test-plugin-hb",
        });
      }
      // register
      return makeRegisterRes({
        token: "tok-hb",
        dispatchHmacKey: "key-hb",
        sessionVerifyPublicKey: "spki-hb",
        // publicBaseUrl absent on register
        heartbeat: { interval_seconds: 0.1 }, // 100 ms heartbeat for the test
      });
    };

    const client = startPluginClient({
      botUrl: "http://bot",
      setupSecret: "secret",
      // The server-returned 100 ms drives the heartbeat cadence.
      manifest: {
        plugin: { id: "test-plugin", name: "Test", version: "0.1.0", url: "http://test-plugin:3000" },
      },
    });

    // Wait for register (fast) + at least one heartbeat (100 ms cadence from server).
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    assert.equal(
      client.getPublicBaseUrl(),
      "http://localhost:902/plugin/test-plugin-hb",
    );
    assert.ok(callCount >= 1, "heartbeat should have been called at least once");
    client.stop();
  });

  it("clears publicBaseUrl when a heartbeat omits it", async () => {
    let beats = 0;
    fetchImpl = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/heartbeat")) {
        beats++;
        // Heartbeat no longer carries publicBaseUrl (e.g. WEB_BASE_URL was
        // unset on the bot) — the client must clear it.
        return makeHeartbeatRes({ sessionVerifyPublicKey: "spki-clr" });
      }
      // register: publicBaseUrl IS present
      return makeRegisterRes({
        token: "tok-clr",
        dispatchHmacKey: "key-clr",
        sessionVerifyPublicKey: "spki-clr",
        publicBaseUrl: "http://localhost:902/plugin/test-plugin",
        heartbeat: { interval_seconds: 0.1 }, // 100 ms heartbeat for the test
      });
    };

    const client = startPluginClient({
      botUrl: "http://bot",
      setupSecret: "secret",
      manifest: {
        plugin: { id: "test-plugin", name: "Test", version: "0.1.0", url: "http://test-plugin:3000" },
      },
    });

    // After register: present. After at least one heartbeat: cleared.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    assert.equal(client.getPublicBaseUrl(), undefined);
    assert.ok(beats >= 1, "heartbeat should have been called at least once");
    client.stop();
  });
});
