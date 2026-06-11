/**
 * PM-7.9.4 — signed dispatch probe.
 *
 * The probe's whole value is its verdict mapping: the SDK's command
 * route answers 401 before anything else when the signature scheme
 * mismatches (the 2026-06-11 incident), 503 while unregistered, and
 * 400 (missing user.id) once the signature gate passed — that last
 * one must count as success, and no real handler may ever run.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));
// Host policy: allow everything — SSRF coverage lives in its own tests.
vi.mock("../src/utils/host-policy.js", () => ({
  assertPluginTarget: vi.fn().mockResolvedValue(undefined),
  HostPolicyError: class HostPolicyError extends Error {},
}));

import {
  probePluginDispatch,
  PROBE_COMMAND_NAME,
} from "../src/modules/plugin-system/plugin-dispatch-probe.service.js";
import {
  getDispatchHealth,
  __resetDispatchHealthForTests,
} from "../src/modules/plugin-system/plugin-dispatch-health.service.js";
import type { PluginRow } from "../src/modules/plugin-system/models/plugin.model.js";

function row(overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id: 7,
    pluginKey: "probe-target",
    name: "Probe Target",
    version: "1.0.0",
    url: "http://plugin.internal:3000",
    status: "active",
    enabled: true,
    manifestJson: JSON.stringify({ plugin: { id: "probe-target" } }),
    dispatchHmacKey: "k".repeat(64),
    ...overrides,
  } as PluginRow;
}

function stubFetch(status: number, bodyText = "") {
  const mock = vi.fn().mockResolvedValue(
    new Response(bodyText, { status }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  __resetDispatchHealthForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probePluginDispatch", () => {
  it("treats the SDK's marked missing-user 400 as signature_ok, recorded on lastProbe only", async () => {
    const fetchMock = stubFetch(400, '{"error":"missing user.id"}');
    const v = await probePluginDispatch(row());
    expect(v).toEqual({ outcome: "signature_ok", status: 400 });

    // Probe payload must NOT carry a user — that's what guarantees the
    // SDK 400s before its handler lookup.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(`/commands/${PROBE_COMMAND_NAME}`);
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.user).toBeUndefined();
    expect(sent.command_name).toBe(PROBE_COMMAND_NAME);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(Object.keys(headers).join(",")).toMatch(/x-karyl/i);

    // Probe verdicts live on lastProbe and never touch the traffic
    // counters: a passing probe must not reset a real failure streak.
    const h = getDispatchHealth("probe-target")!;
    expect(h.lastProbe).toMatchObject({ ok: true, source: "probe", status: 400 });
    expect(h.total).toBe(0);
    expect(h.recent).toHaveLength(0);
  });

  it("does NOT trust a bare 400 (proxy/non-SDK endpoint): inconclusive", async () => {
    stubFetch(400, '{"error":"bad request"}');
    const v = await probePluginDispatch(row());
    expect(v.outcome).toBe("inconclusive");
    expect(getDispatchHealth("probe-target")!.lastProbe).toMatchObject({
      ok: false,
      failureClass: "http_error",
    });
  });

  it("a probe success never resets a real-traffic failure streak", async () => {
    const { recordDispatchAttempt } = await import(
      "../src/modules/plugin-system/plugin-dispatch-health.service.js"
    );
    for (let i = 0; i < 4; i++) {
      recordDispatchAttempt("probe-target", {
        ok: false,
        source: "command",
        status: 500,
        failureClass: "http_error",
      });
    }
    stubFetch(400, '{"error":"missing user.id"}');
    await probePluginDispatch(row());
    const h = getDispatchHealth("probe-target")!;
    expect(h.consecutiveFailures).toBe(4);
    expect(h.lastProbe!.ok).toBe(true);
  });

  it("maps 401 to rejected_401 on lastProbe without touching the streak", async () => {
    stubFetch(401, '{"error":"signature mismatch"}');
    const v = await probePluginDispatch(row());
    expect(v).toEqual({ outcome: "rejected_401" });
    const h = getDispatchHealth("probe-target")!;
    expect(h.lastProbe).toMatchObject({
      ok: false,
      source: "probe",
      failureClass: "rejected_401",
    });
    expect(h.consecutiveFailures).toBe(0);
    expect(h.recent).toHaveLength(0);
  });

  it("maps the unregistered 503 to awaiting_register", async () => {
    stubFetch(503, '{"error":"dispatch HMAC key not available"}');
    const v = await probePluginDispatch(row());
    expect(v).toEqual({ outcome: "awaiting_register" });
    expect(getDispatchHealth("probe-target")!.lastProbe!.failureClass).toBe(
      "awaiting_register",
    );
  });

  it("is inconclusive on other statuses and on network failure", async () => {
    stubFetch(500, "boom");
    expect((await probePluginDispatch(row())).outcome).toBe("inconclusive");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
    const v = await probePluginDispatch(row());
    expect(v.outcome).toBe("inconclusive");
    expect(getDispatchHealth("probe-target")!.lastProbe!.failureClass).toBe(
      "network",
    );
  });

  it("skips without a dispatch key and records nothing", async () => {
    const fetchMock = stubFetch(200);
    const v = await probePluginDispatch(row({ dispatchHmacKey: null }));
    expect(v.outcome).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDispatchHealth("probe-target")).toBeNull();
  });

  it("skips a fixed endpoint template (no {command_name} placeholder) without traffic", async () => {
    const fetchMock = stubFetch(400, '{"error":"missing user.id"}');
    const v = await probePluginDispatch(
      row({
        manifestJson: JSON.stringify({
          plugin: { id: "probe-target" },
          endpoints: { plugin_command: "/dispatch" },
        }),
      }),
    );
    expect(v.outcome).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors a manifest endpoint template override", async () => {
    const fetchMock = stubFetch(400, '{"error":"missing user.id"}');
    await probePluginDispatch(
      row({
        manifestJson: JSON.stringify({
          plugin: { id: "probe-target" },
          endpoints: { plugin_command: "/custom/{command_name}/go" },
        }),
      }),
    );
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      `/custom/${PROBE_COMMAND_NAME}/go`,
    );
  });
});
