/**
 * ServiceDiscovery (PR-3.2): in-process (DB-registry default) and DNS-SD
 * impls, plus the env-gated factory selection in the adapter registry.
 *
 * Pure logic with injected seams (extra-endpoint callback, DNS lookup,
 * clock) — no real DNS / DB / network.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  InProcessServiceDiscovery,
  DnsServiceDiscovery,
} from "../src/adapters/service-discovery.js";
import {
  getServiceDiscovery,
  __resetAdaptersForTests,
} from "../src/adapters/registry.js";

describe("InProcessServiceDiscovery", () => {
  it("returns just the primary url when there are no extra endpoints", async () => {
    const sd = new InProcessServiceDiscovery(() => []);
    expect(await sd.resolve("radio", "http://radio:3000")).toEqual([
      "http://radio:3000",
    ]);
  });

  it("strips a trailing slash on the primary url", async () => {
    const sd = new InProcessServiceDiscovery(() => []);
    expect(await sd.resolve("radio", "http://radio:3000/")).toEqual([
      "http://radio:3000",
    ]);
  });

  it("appends de-duplicated extra replica endpoints after the primary", async () => {
    const sd = new InProcessServiceDiscovery((key) =>
      key === "radio"
        ? ["http://radio:3000", "http://radio-b:3000/", "http://radio-c:3000"]
        : [],
    );
    expect(await sd.resolve("radio", "http://radio:3000")).toEqual([
      "http://radio:3000",
      "http://radio-b:3000",
      "http://radio-c:3000",
    ]);
  });
});

describe("DnsServiceDiscovery", () => {
  it("rebuilds one base url per resolved A record, preserving scheme+port", async () => {
    const sd = new DnsServiceDiscovery({
      lookup: async () => ["10.0.1.5", "10.0.1.6"],
    });
    expect(await sd.resolve("radio", "http://radio-svc:3000")).toEqual([
      "http://10.0.1.5:3000",
      "http://10.0.1.6:3000",
    ]);
  });

  it("brackets IPv6 addresses", async () => {
    const sd = new DnsServiceDiscovery({
      lookup: async () => ["fd00::1"],
    });
    expect(await sd.resolve("p", "https://p-svc")).toEqual(["https://[fd00::1]"]);
  });

  it("returns the primary url unchanged for a literal IP host", async () => {
    let called = false;
    const sd = new DnsServiceDiscovery({
      lookup: async () => {
        called = true;
        return ["1.2.3.4"];
      },
    });
    expect(await sd.resolve("p", "http://10.0.0.9:3000")).toEqual([
      "http://10.0.0.9:3000",
    ]);
    expect(called).toBe(false);
  });

  it("falls back to the primary url when DNS resolution throws", async () => {
    const sd = new DnsServiceDiscovery({
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(await sd.resolve("p", "http://p-svc:3000")).toEqual([
      "http://p-svc:3000",
    ]);
  });

  it("falls back to the primary url when DNS returns no records", async () => {
    const sd = new DnsServiceDiscovery({ lookup: async () => [] });
    expect(await sd.resolve("p", "http://p-svc:3000")).toEqual([
      "http://p-svc:3000",
    ]);
  });

  it("caches a resolution within the TTL, re-resolves after it lapses", async () => {
    let calls = 0;
    let t = 1_000_000;
    const sd = new DnsServiceDiscovery({
      cacheTtlMs: 5_000,
      now: () => t,
      lookup: async () => {
        calls++;
        return [`10.0.0.${calls}`];
      },
    });
    const a = await sd.resolve("p", "http://p-svc:3000");
    const b = await sd.resolve("p", "http://p-svc:3000"); // cached
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    t += 6_000; // TTL lapsed
    const c = await sd.resolve("p", "http://p-svc:3000");
    expect(calls).toBe(2);
    expect(c).not.toEqual(a);
  });
});

describe("getServiceDiscovery() factory selection", () => {
  afterEach(() => {
    delete process.env.SERVICE_DISCOVERY;
    __resetAdaptersForTests();
  });

  it("defaults to the in-process impl when SERVICE_DISCOVERY is unset", () => {
    __resetAdaptersForTests();
    const sd = getServiceDiscovery();
    expect(sd).toBeInstanceOf(InProcessServiceDiscovery);
  });

  it("selects the DNS impl for SERVICE_DISCOVERY=dns", () => {
    process.env.SERVICE_DISCOVERY = "dns";
    __resetAdaptersForTests();
    expect(getServiceDiscovery()).toBeInstanceOf(DnsServiceDiscovery);
  });

  it("accepts k8s as an alias for dns", () => {
    process.env.SERVICE_DISCOVERY = "k8s";
    __resetAdaptersForTests();
    expect(getServiceDiscovery()).toBeInstanceOf(DnsServiceDiscovery);
  });

  it("throws on an unknown SERVICE_DISCOVERY value", () => {
    process.env.SERVICE_DISCOVERY = "consul-magic";
    __resetAdaptersForTests();
    expect(() => getServiceDiscovery()).toThrow(/Unknown SERVICE_DISCOVERY/);
  });
});
