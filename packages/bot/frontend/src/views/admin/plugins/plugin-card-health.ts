/**
 * PluginCard health-badge logic (PM-7.9.2), extracted pure so the
 * thresholds are unit-testable.
 *
 * Liveness (heartbeat) and dispatch health are deliberately separate
 * signals: in the 2026-06-11 incident every dispatch 401'd for hours
 * while heartbeats stayed green. The card keeps the status dot as the
 * liveness signal and badges dispatch/SDK problems independently.
 */
import type {
  PluginDispatchHealth,
  PluginSdkCompat,
} from "../../../api/plugins";

/**
 * Consecutive failures before the card alarms. One-off failures happen
 * legitimately (plugin redeploy window, transient network) — a streak
 * is what distinguishes "broken path" from noise.
 */
export const DISPATCH_FAILING_THRESHOLD = 3;

export interface DispatchProblem {
  /**
   * `rejected401` — the latest failure was an HMAC rejection: almost
   * always the bot and the plugin SDK disagree on the signature scheme
   * (version mismatch). Gets the explicit hint in the UI.
   */
  kind: "rejected401" | "failing";
  streak: number;
  detail: string;
}

export function dispatchProblem(
  dispatch: PluginDispatchHealth | null | undefined,
): DispatchProblem | null {
  if (!dispatch || dispatch.consecutiveFailures < DISPATCH_FAILING_THRESHOLD) {
    return null;
  }
  const latest = dispatch.recent[0];
  return {
    kind: latest?.failureClass === "rejected_401" ? "rejected401" : "failing",
    streak: dispatch.consecutiveFailures,
    detail: latest?.message ?? "",
  };
}

export interface SdkCompatProblem {
  /** `tooOld` — stamped version below the floor. `unknown` — no stamp
   *  on a plugin that HAS registered (pre-0.9 SDK). */
  kind: "tooOld" | "unknown";
  sdkVersion: string | null;
  minCompatible: string;
}

export function sdkCompatProblem(
  compat: PluginSdkCompat | undefined,
  pluginVersion: string,
): SdkCompatProblem | null {
  if (!compat) return null;
  if (compat.status === "below_minimum") {
    return {
      kind: "tooOld",
      sdkVersion: compat.sdkVersion,
      minCompatible: compat.minCompatible,
    };
  }
  // `unknown` on a placeholder row (setup secret minted, never
  // registered — version stays 0.0.0) is expected, not a problem.
  if (compat.status === "unknown" && pluginVersion !== "0.0.0") {
    return {
      kind: "unknown",
      sdkVersion: null,
      minCompatible: compat.minCompatible,
    };
  }
  return null;
}
