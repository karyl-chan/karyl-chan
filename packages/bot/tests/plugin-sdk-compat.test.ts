/**
 * PM-7.9.3 — SDK wire-format compatibility verdict.
 *
 * The Compat Floor (`COMPAT_FLOOR`, owned by @karyl-chan/plugin-wire) is
 * set by the nonced dispatch HMAC scheme: an SDK below it registers and
 * heartbeats green while rejecting every dispatch with 401. These tests
 * lock the verdict the admin UI badge and the register-time warning are
 * built on — asserting against the wire constant rather than a literal,
 * so a floor bump doesn't need this file edited.
 */
import { describe, it, expect } from "vitest";
import { COMPAT_FLOOR, compareSemver } from "@karyl-chan/plugin-wire";
import {
  evaluateSdkCompat,
  evaluateSdkCompatFromManifestJson,
} from "../src/modules/plugin-system/plugin-sdk-compat.js";

// The comparison is wire-owned since #60 (the bot's local copy was
// deleted). These cases are the ones the bot's verdict depends on —
// kept here as a parity lock on the wire helper from the bot's side.
describe("compareSemver (wire-owned, backs the verdict)", () => {
  it("orders core versions numerically, not lexically", () => {
    expect(compareSemver("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareSemver("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareSemver("0.10.0", "0.10.0")).toBe(0);
    expect(compareSemver("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareSemver("0.10.1", "0.10.0")).toBeGreaterThan(0);
  });

  it("sorts a prerelease below its release", () => {
    expect(compareSemver("0.10.0-beta.1", "0.10.0")).toBeLessThan(0);
    expect(compareSemver("0.10.0", "0.10.0-rc.2")).toBeGreaterThan(0);
  });

  it("orders numeric prerelease identifiers numerically, not lexically", () => {
    // The deleted bot-local comparison treated the prerelease tail as a
    // plain string and got this backwards ("rc.10" < "rc.9").
    expect(compareSemver("1.0.0-rc.9", "1.0.0-rc.10")).toBeLessThan(0);
    expect(compareSemver("1.0.0-rc.10", "1.0.0-rc.9")).toBeGreaterThan(0);
  });
});

describe("evaluateSdkCompat", () => {
  it("flags versions below the floor", () => {
    const v = evaluateSdkCompat("0.9.0");
    expect(v.status).toBe("below_minimum");
    expect(v.sdkVersion).toBe("0.9.0");
    expect(v.minCompatible).toBe(COMPAT_FLOOR);
  });

  it("accepts the floor itself and anything above", () => {
    expect(evaluateSdkCompat(COMPAT_FLOOR).status).toBe("ok");
    expect(evaluateSdkCompat("0.11.0").status).toBe("ok");
    expect(evaluateSdkCompat("1.0.0").status).toBe("ok");
  });

  it("flags a prerelease of the floor as below it", () => {
    expect(evaluateSdkCompat(`${COMPAT_FLOOR}-beta.1`).status).toBe(
      "below_minimum",
    );
  });

  it("returns unknown when the stamp is missing", () => {
    expect(evaluateSdkCompat(null).status).toBe("unknown");
    expect(evaluateSdkCompat(undefined).status).toBe("unknown");
    expect(evaluateSdkCompat("").status).toBe("unknown");
    expect(evaluateSdkCompat(null).sdkVersion).toBeNull();
  });
});

describe("evaluateSdkCompatFromManifestJson", () => {
  it("reads sdk_version out of the manifest JSON", () => {
    expect(
      evaluateSdkCompatFromManifestJson(
        JSON.stringify({ sdk_version: "0.10.0", plugin: { id: "x" } }),
      ).status,
    ).toBe("ok");
    expect(
      evaluateSdkCompatFromManifestJson(
        JSON.stringify({ sdk_version: "0.8.2" }),
      ).status,
    ).toBe("below_minimum");
  });

  it("treats placeholder/invalid manifests as unknown", () => {
    expect(evaluateSdkCompatFromManifestJson("{}").status).toBe("unknown");
    expect(evaluateSdkCompatFromManifestJson("not json").status).toBe(
      "unknown",
    );
    // Non-string stamp (defensive — register validation forbids this).
    expect(
      evaluateSdkCompatFromManifestJson(JSON.stringify({ sdk_version: 10 }))
        .status,
    ).toBe("unknown");
  });
});
