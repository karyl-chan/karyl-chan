/**
 * PM-7.9.3 — SDK wire-format compatibility verdict.
 *
 * The floor (MIN_COMPAT_SDK_VERSION) is set by the nonced dispatch
 * HMAC scheme: an SDK below it registers and heartbeats green while
 * rejecting every dispatch with 401. These tests lock the verdict the
 * admin UI badge and the register-time warning are built on.
 */
import { describe, it, expect } from "vitest";
import {
  MIN_COMPAT_SDK_VERSION,
  compareSdkVersions,
  evaluateSdkCompat,
  evaluateSdkCompatFromManifestJson,
} from "../src/modules/plugin-system/plugin-sdk-compat.js";

describe("compareSdkVersions", () => {
  it("orders core versions numerically, not lexically", () => {
    expect(compareSdkVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareSdkVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareSdkVersions("0.10.0", "0.10.0")).toBe(0);
    expect(compareSdkVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareSdkVersions("0.10.1", "0.10.0")).toBeGreaterThan(0);
  });

  it("sorts a prerelease below its release", () => {
    expect(compareSdkVersions("0.10.0-beta.1", "0.10.0")).toBeLessThan(0);
    expect(compareSdkVersions("0.10.0", "0.10.0-rc.2")).toBeGreaterThan(0);
  });
});

describe("evaluateSdkCompat", () => {
  it("flags versions below the floor", () => {
    const v = evaluateSdkCompat("0.9.0");
    expect(v.status).toBe("below_minimum");
    expect(v.sdkVersion).toBe("0.9.0");
    expect(v.minCompatible).toBe(MIN_COMPAT_SDK_VERSION);
  });

  it("accepts the floor itself and anything above", () => {
    expect(evaluateSdkCompat(MIN_COMPAT_SDK_VERSION).status).toBe("ok");
    expect(evaluateSdkCompat("0.11.0").status).toBe("ok");
    expect(evaluateSdkCompat("1.0.0").status).toBe("ok");
  });

  it("flags a prerelease of the floor as below it", () => {
    expect(evaluateSdkCompat(`${MIN_COMPAT_SDK_VERSION}-beta.1`).status).toBe(
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
