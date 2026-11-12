/**
 * `effectivePort` (@karyl-chan/voice/net) is the one place the bot turns a
 * parsed URL into the port a host policy vets: plugin register / dispatch
 * preflight / health probe / proxy / reply files, voice.play on the
 * plugin's own origin, and the public-media and webhook policies (#183).
 * This pins the contract those callers rely on.
 */
import { describe, expect, it } from "vitest";
import { effectivePort } from "@karyl-chan/voice/net";

describe("effectivePort", () => {
  it("uses the explicit port when the URL has one", () => {
    expect(effectivePort(new URL("http://plugin:3000/x"))).toBe(3000);
    expect(effectivePort(new URL("https://plugin:8443/"))).toBe(8443);
  });

  it("defaults to 443 for https and 80 for http", () => {
    expect(effectivePort(new URL("https://plugin/"))).toBe(443);
    expect(effectivePort(new URL("http://plugin/"))).toBe(80);
  });

  it("treats a port equal to the scheme default as the default (WHATWG drops it)", () => {
    expect(effectivePort(new URL("https://plugin:443/"))).toBe(443);
    expect(effectivePort(new URL("http://plugin:80/"))).toBe(80);
  });

  it("does not mistake an IPv6 literal's colons for a port", () => {
    expect(effectivePort(new URL("http://[::1]/"))).toBe(80);
    expect(effectivePort(new URL("http://[::1]:9000/"))).toBe(9000);
  });
});
