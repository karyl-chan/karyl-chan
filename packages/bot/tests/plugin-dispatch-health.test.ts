/**
 * PM-7.9.1 — per-plugin dispatch-path health tracker.
 *
 * Locks the aggregate semantics the admin UI builds its degraded badge
 * on: consecutive-failure streaks reset on any success, the recent
 * window is newest-first and capped, and the failure classifier names
 * the 2026-06-11 incident signature (401 = signature rejected) and the
 * PM-7.6 awaiting-register 503 distinctly from generic HTTP errors.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordDispatchAttempt,
  getDispatchHealth,
  clearDispatchHealth,
  classifyDispatchHttpFailure,
  classifyDispatchFetchError,
  DISPATCH_RECENT_CAP,
  __resetDispatchHealthForTests,
} from "../src/modules/plugin-system/plugin-dispatch-health.service.js";

beforeEach(() => {
  __resetDispatchHealthForTests();
});

describe("recordDispatchAttempt / getDispatchHealth", () => {
  it("returns null for a plugin with no attempts", () => {
    expect(getDispatchHealth("never-dispatched")).toBeNull();
  });

  it("counts totals and tracks the consecutive-failure streak", () => {
    recordDispatchAttempt("p", { ok: true, source: "command", status: 204 });
    recordDispatchAttempt("p", {
      ok: false,
      source: "command",
      status: 401,
      failureClass: "rejected_401",
    });
    recordDispatchAttempt("p", {
      ok: false,
      source: "event",
      failureClass: "network",
    });

    const s = getDispatchHealth("p");
    expect(s).not.toBeNull();
    expect(s!.total).toBe(3);
    expect(s!.okCount).toBe(1);
    expect(s!.consecutiveFailures).toBe(2);
    expect(s!.lastOkAt).not.toBeNull();
    // Newest-first window.
    expect(s!.recent[0]!.failureClass).toBe("network");
    expect(s!.recent[2]!.ok).toBe(true);
  });

  it("resets the streak on any success", () => {
    for (let i = 0; i < 4; i++) {
      recordDispatchAttempt("p", {
        ok: false,
        source: "command",
        status: 401,
        failureClass: "rejected_401",
      });
    }
    expect(getDispatchHealth("p")!.consecutiveFailures).toBe(4);
    recordDispatchAttempt("p", { ok: true, source: "command", status: 200 });
    expect(getDispatchHealth("p")!.consecutiveFailures).toBe(0);
  });

  it("caps the recent window and keeps totals beyond it", () => {
    for (let i = 0; i < DISPATCH_RECENT_CAP + 7; i++) {
      recordDispatchAttempt("p", { ok: true, source: "event", status: 200 });
    }
    const s = getDispatchHealth("p")!;
    expect(s.recent).toHaveLength(DISPATCH_RECENT_CAP);
    expect(s.total).toBe(DISPATCH_RECENT_CAP + 7);
  });

  it("truncates long messages", () => {
    recordDispatchAttempt("p", {
      ok: false,
      source: "modal",
      failureClass: "network",
      message: "x".repeat(1000),
    });
    expect(getDispatchHealth("p")!.recent[0]!.message!.length).toBe(200);
  });

  it("keeps plugins isolated and supports clear", () => {
    recordDispatchAttempt("a", { ok: true, source: "command", status: 200 });
    recordDispatchAttempt("b", {
      ok: false,
      source: "command",
      status: 500,
      failureClass: "http_error",
    });
    expect(getDispatchHealth("a")!.okCount).toBe(1);
    expect(getDispatchHealth("b")!.consecutiveFailures).toBe(1);
    clearDispatchHealth("b");
    expect(getDispatchHealth("b")).toBeNull();
    expect(getDispatchHealth("a")).not.toBeNull();
  });
});

describe("classifyDispatchHttpFailure", () => {
  it("names 401 as a signature rejection (version-mismatch signature)", () => {
    expect(classifyDispatchHttpFailure(401, "")).toBe("rejected_401");
    expect(classifyDispatchHttpFailure(401, "Unauthorized")).toBe(
      "rejected_401",
    );
  });

  it("names the awaiting-register 503 distinctly", () => {
    expect(
      classifyDispatchHttpFailure(
        503,
        '{"error":"dispatch HMAC key not available"}',
      ),
    ).toBe("awaiting_register");
    // 503 without the marker body is just an HTTP error (e.g. event
    // path, where the failure outcome carries no body).
    expect(classifyDispatchHttpFailure(503, "")).toBe("http_error");
  });

  it("classifies everything else as http_error", () => {
    expect(classifyDispatchHttpFailure(403, "")).toBe("http_error");
    expect(classifyDispatchHttpFailure(500, "boom")).toBe("http_error");
  });
});

describe("classifyDispatchFetchError", () => {
  it("maps our AbortController deadline to timeout", () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    expect(classifyDispatchFetchError(abort)).toBe("timeout");
  });

  it("maps anything else to network", () => {
    expect(classifyDispatchFetchError(new Error("ECONNREFUSED"))).toBe(
      "network",
    );
    expect(classifyDispatchFetchError("weird")).toBe("network");
  });
});

describe("recordDispatchUnreachable", () => {
  it("records a pre-flight failure as an unreachable attempt", async () => {
    const { recordDispatchUnreachable } = await import(
      "../src/modules/plugin-system/plugin-dispatch-health.service.js"
    );
    recordDispatchUnreachable("p", "command", "my-cmd", "getaddrinfo ENOTFOUND plugin");
    const s = getDispatchHealth("p")!;
    expect(s.consecutiveFailures).toBe(1);
    expect(s.recent[0]).toMatchObject({
      ok: false,
      source: "command",
      failureClass: "unreachable",
    });
    expect(s.recent[0]!.message).toContain("ENOTFOUND");
  });
});

describe("recordProbeResult", () => {
  it("sets lastProbe without touching counters, window, or streak", async () => {
    const { recordProbeResult } = await import(
      "../src/modules/plugin-system/plugin-dispatch-health.service.js"
    );
    recordDispatchAttempt("p", {
      ok: false,
      source: "command",
      status: 500,
      failureClass: "http_error",
    });
    recordProbeResult("p", { ok: true, status: 400, message: "probe ok" });
    const s = getDispatchHealth("p")!;
    expect(s.lastProbe).toMatchObject({ ok: true, source: "probe", status: 400 });
    expect(s.consecutiveFailures).toBe(1);
    expect(s.total).toBe(1);
    expect(s.recent).toHaveLength(1);

    // And a probe failure doesn't build the streak either.
    recordProbeResult("p", {
      ok: false,
      failureClass: "rejected_401",
      message: "probe rejected",
    });
    expect(getDispatchHealth("p")!.consecutiveFailures).toBe(1);
    expect(getDispatchHealth("p")!.lastProbe!.failureClass).toBe("rejected_401");
  });

  it("creates state for a plugin with no traffic yet", async () => {
    const { recordProbeResult } = await import(
      "../src/modules/plugin-system/plugin-dispatch-health.service.js"
    );
    recordProbeResult("fresh", { ok: false, failureClass: "rejected_401" });
    const s = getDispatchHealth("fresh")!;
    expect(s.total).toBe(0);
    expect(s.lastProbe!.failureClass).toBe("rejected_401");
  });
});
