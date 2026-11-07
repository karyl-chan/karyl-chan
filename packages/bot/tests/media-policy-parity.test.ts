/**
 * #158 — the bot's up-front media check (`assertPublicMediaTarget`) and
 * the voice media proxy's policy (`resolvePublicMediaTarget`, what every
 * ffmpeg request is vetted with) must agree on every host. Both run the
 * shared gate and rule from @karyl-chan/voice/net; this pins that they
 * stay that way, over literals of every address class, metadata
 * hostnames, bracketed IPv6, bad hosts and bad ports.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("dns/promises", () => ({
  lookup: vi.fn(),
}));

const { lookup } = await import("dns/promises");
const { assertPublicMediaTarget, HostPolicyError } = await import(
  "../src/utils/host-policy.js"
);
const { resolvePublicMediaTarget, TargetRefusedError } = await import(
  "@karyl-chan/voice/net"
);

/** DNS for the hostnames in the table (both sides answer from this). */
const DNS: Record<string, Array<{ address: string; family: number }>> = {
  "cdn.example.com": [{ address: "93.184.216.34", family: 4 }],
  "dual.example.com": [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1::1", family: 6 },
  ],
  "lan.example.com": [{ address: "192.168.1.10", family: 4 }],
  "mixed.example.com": [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.5", family: 4 },
  ],
  "loop.example.com": [{ address: "127.0.0.1", family: 4 }],
  "empty.example.com": [],
};

async function fakeLookup(host: string) {
  const answers = DNS[host];
  if (!answers) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return answers;
}

vi.mocked(lookup).mockImplementation(fakeLookup as never);

const CASES: Array<[host: string, port: number, allowed: boolean]> = [
  // public literals
  ["8.8.8.8", 443, true],
  ["2606:4700:4700::1111", 443, true],
  ["[2606:4700:4700::1111]", 443, true],
  // every refused class, as literals
  ["127.0.0.1", 80, false],
  ["::1", 80, false],
  ["[::1]", 80, false],
  ["10.0.0.5", 80, false],
  ["172.16.0.1", 80, false],
  ["192.168.1.1", 80, false],
  ["100.64.0.1", 80, false],
  ["fd00::1", 80, false],
  ["169.254.169.254", 80, false],
  ["fe80::1", 80, false],
  ["168.63.129.16", 80, false],
  ["100.100.100.200", 80, false],
  ["fd00:ec2::254", 80, false],
  ["0.0.0.0", 80, false],
  ["::", 80, false],
  ["198.18.0.1", 80, false],
  ["224.0.0.1", 80, false],
  ["240.0.0.1", 80, false],
  ["ff02::1", 80, false],
  ["fec0::1", 80, false],
  ["::7f00:1", 80, false],
  ["64:ff9b::808:808", 80, false],
  ["2002:808:808::1", 80, false],
  ["::ffff:127.0.0.1", 80, false],
  ["::ffff:8.8.8.8", 80, true],
  // metadata hostnames, any spelling
  ["metadata.google.internal", 80, false],
  ["Metadata.Google.Internal.", 80, false],
  ["metadata", 80, false],
  ["metadata.azure.com", 80, false],
  // hostnames via DNS
  ["cdn.example.com", 443, true],
  ["dual.example.com", 443, true],
  ["lan.example.com", 443, false],
  ["mixed.example.com", 443, false],
  ["loop.example.com", 443, false],
  ["empty.example.com", 443, false],
  ["gone.example.com", 443, false],
  // bad hosts / ports
  ["bad host", 80, false],
  ["-lead.example.com", 80, false],
  ["", 80, false],
  ["8.8.8.8", 0, false],
  ["8.8.8.8", -1, false],
  ["8.8.8.8", 65536, false],
  ["8.8.8.8", 80.5, false],
  ["8.8.8.8", 65535, true],
];

async function botAllows(host: string, port: number): Promise<boolean> {
  try {
    await assertPublicMediaTarget(host, port);
    return true;
  } catch (err) {
    expect(err).toBeInstanceOf(HostPolicyError);
    return false;
  }
}

async function proxyAllows(host: string, port: number): Promise<boolean> {
  try {
    await resolvePublicMediaTarget(host, port, { lookup: fakeLookup });
    return true;
  } catch (err) {
    expect(err).toBeInstanceOf(TargetRefusedError);
    return false;
  }
}

describe("bot media check ↔ voice media proxy policy parity", () => {
  afterEach(() => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
  });

  it.each(CASES)("%s:%d → allowed=%s on both sides", async (host, port, allowed) => {
    expect(await botAllows(host, port)).toBe(allowed);
    expect(await proxyAllows(host, port)).toBe(allowed);
  });

  it("agrees under the legacy WEBHOOK_ALLOW_PRIVATE hatch too", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE = "true";
    for (const [host, port] of CASES) {
      expect(await botAllows(host, port), `${host}:${port}`).toBe(
        await proxyAllows(host, port),
      );
    }
    // …and the hatch really changed something.
    expect(await botAllows("10.0.0.5", 80)).toBe(true);
    expect(await botAllows("127.0.0.1", 80)).toBe(false);
  });
});
