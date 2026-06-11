/**
 * PM-7.9.2 — PluginCard alarm thresholds.
 *
 * The badge must fire on the 2026-06-11 incident shape (heartbeat
 * green, every dispatch 401) and stay quiet on one-off failures and on
 * setup-secret placeholder rows that simply never registered.
 */
import { describe, it, expect } from "vitest";
import {
  dispatchProblem,
  sdkCompatProblem,
  DISPATCH_FAILING_THRESHOLD,
} from "./plugin-card-health";
import type {
  PluginDispatchHealth,
  PluginDispatchAttempt,
  PluginSdkCompat,
} from "../../../api/plugins";

function health(
  streak: number,
  latest?: Partial<PluginDispatchAttempt>,
): PluginDispatchHealth {
  return {
    total: streak + 1,
    okCount: 1,
    consecutiveFailures: streak,
    lastOkAt: streak === 0 ? Date.now() : null,
    recent: [
      {
        at: Date.now(),
        ok: streak === 0,
        source: "command",
        ...latest,
      },
    ],
  };
}

describe("dispatchProblem", () => {
  it("is quiet with no data or below the streak threshold", () => {
    expect(dispatchProblem(null)).toBeNull();
    expect(dispatchProblem(undefined)).toBeNull();
    expect(
      dispatchProblem(health(DISPATCH_FAILING_THRESHOLD - 1)),
    ).toBeNull();
  });

  it("fires the 401 hint on an HMAC-rejection streak", () => {
    const p = dispatchProblem(
      health(DISPATCH_FAILING_THRESHOLD, {
        ok: false,
        status: 401,
        failureClass: "rejected_401",
        message: "/plex-help: Unauthorized",
      }),
    );
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("rejected401");
    expect(p!.streak).toBe(DISPATCH_FAILING_THRESHOLD);
    expect(p!.detail).toContain("plex-help");
  });

  it("fires the generic alarm for non-401 streaks", () => {
    const p = dispatchProblem(
      health(5, { ok: false, failureClass: "network" }),
    );
    expect(p!.kind).toBe("failing");
  });
});

describe("sdkCompatProblem", () => {
  const compat = (status: PluginSdkCompat["status"], v: string | null = null): PluginSdkCompat => ({
    sdkVersion: v,
    minCompatible: "0.10.0",
    status,
  });

  it("flags a stamped version below the floor regardless of plugin version", () => {
    const p = sdkCompatProblem(compat("below_minimum", "0.9.0"), "1.2.3");
    expect(p!.kind).toBe("tooOld");
    expect(p!.sdkVersion).toBe("0.9.0");
  });

  it("flags a missing stamp only on plugins that actually registered", () => {
    // Placeholder row (setup secret minted, never registered).
    expect(sdkCompatProblem(compat("unknown"), "0.0.0")).toBeNull();
    // Registered plugin without a stamp = pre-0.9 SDK.
    expect(sdkCompatProblem(compat("unknown"), "1.0.0")!.kind).toBe("unknown");
  });

  it("is quiet when compatible or when the bot didn't send a verdict", () => {
    expect(sdkCompatProblem(compat("ok", "0.10.0"), "1.0.0")).toBeNull();
    expect(sdkCompatProblem(undefined, "1.0.0")).toBeNull();
  });
});
