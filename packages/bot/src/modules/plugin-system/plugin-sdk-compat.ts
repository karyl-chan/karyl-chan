/**
 * SDK ↔ bot wire-format compatibility policy (PM-7.9.3).
 *
 * The bot, not the admin UI, owns the judgement of "is this plugin's
 * SDK still speaking our wire format" — the UI only renders the
 * verdict. What that judgement is measured against is the Compat Floor,
 * and the floor is a property of the wire, not of this module: it is
 * defined once as `COMPAT_FLOOR` in `@karyl-chan/plugin-wire` and read
 * from there by everyone who has an opinion about it (this verdict, and
 * the SDK's cross-version alias pin). See that constant for why the
 * floor sits where it does today.
 *
 * `manifest.sdk_version` is stamped by the SDK's buildManifest since
 * 0.9.0 and format-validated at register; absence means the SDK
 * predates the stamp (or the manifest is a placeholder row that never
 * registered) — callers must treat `unknown` accordingly.
 */

import { COMPAT_FLOOR } from "@karyl-chan/plugin-wire";

export interface SdkCompat {
  /** As stamped in the registered manifest; null when absent. */
  sdkVersion: string | null;
  minCompatible: string;
  /**
   *  - `ok`: sdk_version >= the floor.
   *  - `below_minimum`: sdk_version present but older than the floor —
   *    every dispatch to this plugin will be rejected until rebuilt.
   *  - `unknown`: no sdk_version in the manifest (pre-0.9 SDK or a
   *    setup-secret placeholder row that never completed register).
   */
  status: "ok" | "below_minimum" | "unknown";
}

/**
 * Compare two `x.y.z` / `x.y.z-pre` strings (the format register
 * validation enforces). Returns <0, 0, >0. A prerelease sorts below
 * its release (`0.10.0-beta < 0.10.0`); two prereleases compare as
 * plain strings — exact ordering between them doesn't matter for a
 * floor check.
 */
export function compareSdkVersions(a: string, b: string): number {
  const [aCore, aPre] = splitPrerelease(a);
  const [bCore, bPre] = splitPrerelease(b);
  const an = aCore.split(".").map(Number);
  const bn = bCore.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (an[i] ?? 0) - (bn[i] ?? 0);
    if (d !== 0) return d;
  }
  if (aPre === null && bPre === null) return 0;
  if (aPre === null) return 1;
  if (bPre === null) return -1;
  return aPre < bPre ? -1 : aPre > bPre ? 1 : 0;
}

function splitPrerelease(v: string): [string, string | null] {
  const dash = v.indexOf("-");
  return dash === -1 ? [v, null] : [v.slice(0, dash), v.slice(dash + 1)];
}

export function evaluateSdkCompat(
  sdkVersion: string | null | undefined,
): SdkCompat {
  if (sdkVersion === null || sdkVersion === undefined || sdkVersion === "") {
    return {
      sdkVersion: null,
      minCompatible: COMPAT_FLOOR,
      status: "unknown",
    };
  }
  return {
    sdkVersion,
    minCompatible: COMPAT_FLOOR,
    status:
      compareSdkVersions(sdkVersion, COMPAT_FLOOR) >= 0
        ? "ok"
        : "below_minimum",
  };
}

/** Convenience for routes that hold the raw manifestJson column. */
export function evaluateSdkCompatFromManifestJson(
  manifestJson: string,
): SdkCompat {
  let sdkVersion: unknown;
  try {
    sdkVersion = (JSON.parse(manifestJson) as { sdk_version?: unknown })
      .sdk_version;
  } catch {
    sdkVersion = null;
  }
  return evaluateSdkCompat(
    typeof sdkVersion === "string" ? sdkVersion : null,
  );
}
