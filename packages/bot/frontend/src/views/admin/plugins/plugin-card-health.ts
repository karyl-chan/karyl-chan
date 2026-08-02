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
  PluginEventSubscriptionCheck,
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
  if (!dispatch) return null;
  // A probe rejected_401 alarms IMMEDIATELY — it is deterministic
  // (signature verification doesn't flake) and the register-time
  // probe only ever records one attempt, so a streak threshold would
  // never fire for it. Real-traffic failures keep the streak
  // threshold to ride out one-off blips.
  if (
    dispatch.lastProbe &&
    !dispatch.lastProbe.ok &&
    dispatch.lastProbe.failureClass === "rejected_401"
  ) {
    return {
      kind: "rejected401",
      streak: Math.max(1, dispatch.consecutiveFailures),
      detail: dispatch.lastProbe.message ?? "",
    };
  }
  if (dispatch.consecutiveFailures < DISPATCH_FAILING_THRESHOLD) {
    return null;
  }
  const latest = dispatch.recent[0];
  return {
    kind: latest?.failureClass === "rejected_401" ? "rejected401" : "failing",
    streak: dispatch.consecutiveFailures,
    detail: latest?.message ?? "",
  };
}

export interface LifecycleProblem {
  /** Failure class of the last onEnable/onDisable dispatch (e.g.
   *  rejected_401, timeout, unreachable) — drives the detail hint. */
  failureClass: string | null;
  detail: string;
}

/**
 * The last onEnable/onDisable dispatch to this plugin FAILED, so a
 * feature toggle the admin already committed never reached the plugin's
 * hook — its effective state may be out of sync with the bot until a
 * later lifecycle dispatch succeeds. Kept independent of the dispatch
 * streak: healthy event/command traffic does not clear it (a stale
 * onEnable stays a problem even while ordinary dispatches flow fine).
 */
export function lifecycleProblem(
  dispatch: PluginDispatchHealth | null | undefined,
): LifecycleProblem | null {
  const last = dispatch?.lastLifecycle;
  if (!last || last.ok) return null;
  return {
    failureClass: last.failureClass ?? null,
    detail: last.message ?? "",
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

export interface UnknownEventProblem {
  /**
   *  - `typo`: every unrecognized name came from an SDK this build
   *    already knows in full — nothing will ever be delivered for them.
   *  - `maybeNewerSdk`: every one came from a manifest newer than this
   *    build's Event Ceiling — upgrading the bot may be the fix.
   *  - `mixed`: both, so neither single sentence is honest.
   */
  kind: "typo" | "maybeNewerSdk" | "mixed";
  /** The offending names — a warning that doesn't name them is noise. */
  events: string[];
  /** The bot's own reason text, joined; rendered as the detail line. */
  detail: string;
}

/**
 * The plugin's manifest subscribes to event names this bot build does
 * not recognize (#29 decisions 4/6/7). Independent of dispatch health:
 * these subscriptions produce no traffic at all, so no failure streak
 * will ever surface them.
 *
 * The bot decides what the names mean; this only picks the wording.
 * Whether the register was actually refused is `check.enforced` — false
 * for the warn-only phase, when the card is the only place an operator
 * would ever see this.
 */
export function unknownEventProblem(
  check: PluginEventSubscriptionCheck | undefined,
): UnknownEventProblem | null {
  if (!check || check.unknown.length === 0) return null;
  const typos = check.unknown.filter((u) => u.verdict === "reject").length;
  return {
    kind:
      typos === check.unknown.length
        ? "typo"
        : typos === 0
          ? "maybeNewerSdk"
          : "mixed",
    events: check.unknown.map((u) => u.event),
    detail: check.unknown.map((u) => u.message).join(" "),
  };
}
