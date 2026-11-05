import { describe, expect, it } from "vitest";
import { parseAllowlistEntries } from "../src/utils/webhook-allowlist.js";

describe("parseAllowlistEntries", () => {
  it("accepts hostnames, bare IPs and CIDRs", () => {
    expect(() =>
      parseAllowlistEntries(["nas.latte.lan", "192.168.2.40", "10.0.0.0/8", "fd12::/16"]),
    ).not.toThrow();
  });

  it.each([
    "192.168.0.0/33",
    "fd12::/129",
    "10.0.0.0/",
    "not a host",
    "*.latte.lan",
    "http://nas.latte.lan",
    "192.168.0.0/16/1",
  ])("rejects malformed entry %s", (entry) => {
    expect(() => parseAllowlistEntries([entry])).toThrow(/WEBHOOK_PRIVATE_ALLOWLIST/);
  });
});
