import { describe, expect, it } from "vitest";
import { classifyAddress } from "../src/utils/ip-address.js";

describe("classifyAddress", () => {
  it.each([
    // IPv4
    ["8.8.8.8", "public"],
    ["203.0.113.10", "public"],
    ["100.63.255.255", "public"],
    ["100.128.0.1", "public"],
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "reserved"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.255", "loopback"],
    ["169.254.169.254", "linkLocal"],
    ["169.254.0.1", "linkLocal"],
    ["168.63.129.16", "metadata"],
    ["100.100.100.200", "metadata"],
    ["192.0.0.192", "metadata"],
    ["10.0.0.5", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.2.40", "private"],
    ["100.64.0.1", "private"],
    ["100.127.255.255", "private"],
    ["198.18.0.1", "reserved"],
    ["198.19.255.255", "reserved"],
    ["198.20.0.1", "public"],
    ["224.0.0.1", "reserved"],
    ["239.255.255.255", "reserved"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    // IPv6
    ["2606:4700:4700::1111", "public"],
    ["::", "unspecified"],
    ["0:0:0:0:0:0:0:0", "unspecified"],
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["fe80::1", "linkLocal"],
    ["febf::1", "linkLocal"],
    ["fec0::1", "reserved"],
    ["feff::1", "reserved"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["fd00:ec2::254", "metadata"],
    ["ff02::1", "reserved"],
    ["::7f00:1", "reserved"],
    ["64:ff9b::a9fe:a9fe", "transition"],
    ["64:ff9b:1::1", "transition"],
    ["2002:c0a8:0101::1", "transition"],
    // IPv4-mapped IPv6 — classified as the embedded IPv4, in every spelling
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["0:0:0:0:0:ffff:7f00:1", "loopback"],
    ["::ffff:169.254.169.254", "linkLocal"],
    ["::ffff:10.0.0.5", "private"],
    ["::ffff:8.8.8.8", "public"],
    // brackets and zone ids are tolerated
    ["[::1]", "loopback"],
    ["fe80::1%eth0", "linkLocal"],
  ])("%s → %s", (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected);
  });

  it("returns null for anything that is not an IP literal", () => {
    expect(classifyAddress("example.com")).toBeNull();
    expect(classifyAddress("256.0.0.1")).toBeNull();
    expect(classifyAddress("1.2.3")).toBeNull();
    expect(classifyAddress("::1::2")).toBeNull();
  });
});
