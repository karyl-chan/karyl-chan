/**
 * #103 — address ranges the host policies used to let through:
 * 0/8, 198.18/15, 224/4, 240/4, fec0::/10, multicast, IPv4-compatible
 * ::/96, and the NAT64 / 6to4 transition prefixes that embed an IPv4.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dns/promises", () => ({
  lookup: vi.fn(),
}));

const { lookup } = await import("dns/promises");
const { assertExternalTarget, assertPluginTarget, assertAllowedTarget, HostPolicyError } =
  await import("../src/utils/host-policy.js");

const mockedLookup = vi.mocked(lookup);

function stubResolve(address: string, family: 4 | 6 = 4) {
  mockedLookup.mockResolvedValue([{ address, family }] as unknown as Awaited<
    ReturnType<typeof lookup>
  >);
}

const NON_ROUTABLE = [
  "0.1.2.3", // 0/8 ("this network"), not just 0.0.0.0
  "198.18.0.1", // 198.18/15 benchmarking
  "198.19.255.254",
  "224.0.0.1", // 224/4 multicast
  "239.255.255.250",
  "240.0.0.1", // 240/4 reserved
  "255.255.255.255", // limited broadcast
  "fec0::1", // site-local (deprecated)
  "ff02::1", // IPv6 multicast
  "::7f00:1", // IPv4-compatible ::/96 (= ::127.0.0.1)
];

const TRANSITION = [
  "64:ff9b::808:808", // NAT64 well-known → 8.8.8.8
  "64:ff9b::a9fe:a9fe", // NAT64 → 169.254.169.254
  "64:ff9b:1::1", // NAT64 local-use
  "2002:c0a8:0101::1", // 6to4 → 192.168.1.1
];

const origNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  mockedLookup.mockReset();
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
  process.env.NODE_ENV = "development";
});

afterEach(() => {
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
  process.env.NODE_ENV = origNodeEnv;
});

describe("assertExternalTarget — newly blocked ranges", () => {
  it.each([...NON_ROUTABLE, ...TRANSITION])("blocks literal %s", async (ip) => {
    await expect(assertExternalTarget(ip, 443)).rejects.toBeInstanceOf(
      HostPolicyError,
    );
  });

  it.each([...NON_ROUTABLE, ...TRANSITION])(
    "blocks a hostname resolving to %s",
    async (ip) => {
      stubResolve(ip, ip.includes(":") ? 6 : 4);
      await expect(
        assertExternalTarget("sneaky.example.com", 443),
      ).rejects.toBeInstanceOf(HostPolicyError);
    },
  );

  it("still blocks them with the legacy WEBHOOK_ALLOW_PRIVATE hatch on", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE = "true";
    for (const ip of [...NON_ROUTABLE, ...TRANSITION]) {
      await expect(assertExternalTarget(ip, 443)).rejects.toBeInstanceOf(
        HostPolicyError,
      );
    }
  });

  it("blocks the AWS IPv6 metadata endpoint fd00:ec2::254", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE = "true";
    await expect(
      assertExternalTarget("fd00:ec2::254", 80),
    ).rejects.toBeInstanceOf(HostPolicyError);
  });

  it("blocks the expanded IPv4-mapped spelling of loopback", async () => {
    await expect(
      assertExternalTarget("0:0:0:0:0:ffff:7f00:1", 80),
    ).rejects.toBeInstanceOf(HostPolicyError);
  });
});

describe("assertPluginTarget — newly blocked ranges", () => {
  it.each(NON_ROUTABLE)("blocks non-routable literal %s", async (ip) => {
    await expect(assertPluginTarget(ip, 3000)).rejects.toBeInstanceOf(
      HostPolicyError,
    );
  });

  it("blocks IPv6 link-local fe80::/10", async () => {
    await expect(assertPluginTarget("fe80::1", 3000)).rejects.toBeInstanceOf(
      HostPolicyError,
    );
  });

  it("blocks the AWS IPv6 metadata endpoint fd00:ec2::254", async () => {
    await expect(
      assertPluginTarget("fd00:ec2::254", 3000),
    ).rejects.toBeInstanceOf(HostPolicyError);
  });

  it("blocks metadata smuggled through NAT64 / 6to4", async () => {
    await expect(
      assertPluginTarget("64:ff9b::a9fe:a9fe", 3000),
    ).rejects.toBeInstanceOf(HostPolicyError);
    await expect(
      assertPluginTarget("2002:a9fe:a9fe::1", 3000),
    ).rejects.toBeInstanceOf(HostPolicyError);
  });

  it("blocks loopback smuggled through NAT64 in production", async () => {
    process.env.NODE_ENV = "production";
    await expect(
      assertPluginTarget("64:ff9b::7f00:1", 3000),
    ).rejects.toBeInstanceOf(HostPolicyError);
  });

  it("keeps allowing what plugins legitimately use", async () => {
    await expect(assertPluginTarget("172.18.0.5", 3000)).resolves.toBeUndefined();
    await expect(assertPluginTarget("fd12:3456::5", 3000)).resolves.toBeUndefined();
    await expect(assertPluginTarget("64:ff9b::a00:5", 3000)).resolves.toBeUndefined();
    await expect(assertPluginTarget("127.0.0.1", 3000)).resolves.toBeUndefined();
  });
});

describe("assertAllowedTarget (RCON) — metadata through IPv6 spellings", () => {
  it.each(["fd00:ec2::254", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1"])(
    "blocks %s",
    async (ip) => {
      await expect(assertAllowedTarget(ip, 25575)).rejects.toBeInstanceOf(
        HostPolicyError,
      );
    },
  );

  it("still allows RFC1918 and loopback RCON hosts", async () => {
    await expect(assertAllowedTarget("192.168.1.10", 25575)).resolves.toBeUndefined();
    await expect(assertAllowedTarget("127.0.0.1", 25575)).resolves.toBeUndefined();
  });
});
