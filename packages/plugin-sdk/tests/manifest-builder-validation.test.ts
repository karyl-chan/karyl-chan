/**
 * `buildManifest` runs the wire contract's protocol validation on what
 * it just built, so an author learns about a malformed manifest when
 * their plugin starts — not from a 400 the bot returns at register.
 * Same rules, same code, both sides of the wire.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildManifest } from "../src/manifest-builder.js";
import type { PluginConfig } from "../src/plugin.js";

function cfg(over: Partial<PluginConfig> = {}): PluginConfig {
  return {
    key: "demo",
    name: "Demo",
    version: "1.0.0",
    ...over,
  } as PluginConfig;
}

const URL_ = "http://demo:3000";

describe("buildManifest: wire protocol validation", () => {
  it("builds a valid config without complaint", () => {
    const m = buildManifest(cfg(), URL_);
    assert.equal(m.plugin.id, "demo");
  });

  it("rejects a plugin key that is not a legal plugin.id", () => {
    assert.throws(
      () => buildManifest(cfg({ key: "Demo_Plugin" }), URL_),
      /manifest\.plugin\.id must match/,
    );
  });

  it("rejects a plugin URL that is not http(s)", () => {
    assert.throws(
      () => buildManifest(cfg(), "ftp://demo:3000"),
      /manifest\.plugin\.url must be http\(s\)/,
    );
  });

  it("rejects more than 32 capabilities", () => {
    assert.throws(
      () =>
        buildManifest(
          cfg({
            capabilities: Array.from({ length: 33 }, (_, i) => ({
              key: `c${i}`,
              description: "d",
            })),
          }),
          URL_,
        ),
      /at most 32 allowed \(got 33\)/,
    );
  });

  it("rejects a duplicate capability key", () => {
    assert.throws(
      () =>
        buildManifest(
          cfg({
            capabilities: [
              { key: "dup", description: "a" },
              { key: "dup", description: "b" },
            ],
          }),
          URL_,
        ),
      /capabilities\[dup\]\.key is declared more than once/,
    );
  });

  it("rejects a config_schema default whose type does not match", () => {
    assert.throws(
      () =>
        buildManifest(
          cfg({
            configSchema: [
              { key: "n", type: "number", label: "N", default: "3" },
            ],
          }),
          URL_,
        ),
      /config_schema\[n\]: default value type string does not match/,
    );
  });

  it("rejects a plugin command that violates a V-C axis rule", () => {
    assert.throws(
      () =>
        buildManifest(
          cfg({
            pluginCommands: [
              {
                name: "ping",
                description: "Ping",
                scope: "guild",
                integrationTypes: ["guild_install"],
                contexts: ["Guild", "BotDM"],
                handler: async () => ({ content: "pong" }),
              },
            ],
          } as Partial<PluginConfig>),
          URL_,
        ),
      /V-C1/,
    );
  });
});
