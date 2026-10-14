import { describe, expect, it } from "vitest";
import type { PluginManifest } from "@karyl-chan/plugin-wire";
import {
  EventTransportNegotiationError,
  negotiateEventTransport,
} from "../src/modules/plugin-system/plugin-event-transport.js";

function manifest(withEvents: boolean): PluginManifest {
  return {
    plugin: {
      id: "transport-test",
      name: "Transport Test",
      version: "1.0.0",
      url: "http://transport-test:3000",
    },
    ...(withEvents
      ? { events_subscribed_global: ["guild.message_create"] }
      : {}),
  };
}

describe("event transport negotiation", () => {
  it("accepts a current SDK when the bot selection is advertised", () => {
    expect(
      negotiateEventTransport(
        manifest(true),
        { available: ["http", "redis-streams"] },
        "redis-streams",
      ),
    ).toEqual({ selected: "redis-streams", consumerRequired: true });
  });

  it("accepts a legacy event subscriber only in HTTP mode", () => {
    expect(negotiateEventTransport(manifest(true), undefined, "http")).toEqual({
      selected: "http",
      consumerRequired: false,
    });
    expect(() =>
      negotiateEventTransport(manifest(true), undefined, "redis-streams"),
    ).toThrow(EventTransportNegotiationError);
  });

  it("returns the replica's missing configuration in a mismatch", () => {
    expect(() =>
      negotiateEventTransport(
        manifest(true),
        {
          available: ["http"],
          unavailable: { "redis-streams": "REDIS_URL is not set" },
        },
        "redis-streams",
      ),
    ).toThrow(/REDIS_URL is not set/);
  });

  it("does not require a consumer for a plugin with no subscriptions", () => {
    expect(
      negotiateEventTransport(manifest(false), undefined, "redis-streams"),
    ).toEqual({ selected: "redis-streams", consumerRequired: false });
  });
});
