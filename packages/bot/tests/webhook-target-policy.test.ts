/**
 * #100 — behavior webhook target policy: the operator's private-network
 * allowlist (WEBHOOK_PRIVATE_ALLOWLIST), the https rule, and readable,
 * coded refusals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dns/promises", () => ({
  lookup: vi.fn(),
}));

const { lookup } = await import("dns/promises");
const { resolveWebhookTarget, HostPolicyError } = await import(
  "../src/utils/host-policy.js"
);
const { parseAllowlistEntries } = await import("../src/utils/ip-address.js");

const mockedLookup = vi.mocked(lookup);

function stubResolve(...addresses: string[]) {
  mockedLookup.mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    })) as unknown as Awaited<ReturnType<typeof lookup>>,
  );
}

const allow = (...entries: string[]) => parseAllowlistEntries(entries);

async function refusal(
  url: string,
  allowlist = allow(),
): Promise<InstanceType<typeof HostPolicyError>> {
  try {
    await resolveWebhookTarget(url, allowlist);
  } catch (err) {
    if (err instanceof HostPolicyError) return err;
    throw err;
  }
  throw new Error(`expected ${url} to be refused`);
}

beforeEach(() => {
  mockedLookup.mockReset();
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
});

afterEach(() => {
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
});

describe("parseAllowlistEntries", () => {
  it("accepts hostnames, bare IPs and CIDRs", () => {
    expect(() =>
      allow("nas.latte.lan", "192.168.2.40", "10.0.0.0/8", "fd12::/16"),
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
    expect(() => allow(entry)).toThrow(/WEBHOOK_PRIVATE_ALLOWLIST/);
  });
});

describe("resolveWebhookTarget — private targets", () => {
  it("refuses a private IP that is not allowlisted, naming the setting", async () => {
    const err = await refusal("http://192.168.2.40/hook");
    expect(err.code).toBe("private_not_allowlisted");
    expect(err.message).toContain("192.168.2.40");
    expect(err.message).toContain("WEBHOOK_PRIVATE_ALLOWLIST");
  });

  it("allows a private IP inside an allowlisted CIDR, over plain http", async () => {
    await expect(
      resolveWebhookTarget("http://192.168.2.40:8080/hook", allow("192.168.0.0/16")),
    ).resolves.toMatchObject({ addresses: [{ address: "192.168.2.40", family: 4 }] });
  });

  it("allows an allowlisted bare IP but not its neighbour", async () => {
    const list = allow("192.168.2.40");
    await expect(
      resolveWebhookTarget("http://192.168.2.40/hook", list),
    ).resolves.toMatchObject({ addresses: [{ address: "192.168.2.40" }] });
    expect((await refusal("http://192.168.2.41/hook", list)).code).toBe(
      "private_not_allowlisted",
    );
  });

  it("allows an allowlisted hostname whatever private address it resolves to", async () => {
    stubResolve("192.168.2.40");
    await expect(
      resolveWebhookTarget("http://NAS.latte.lan/hook", allow("nas.latte.lan")),
    ).resolves.toMatchObject({ addresses: [{ address: "192.168.2.40", family: 4 }] });
  });

  it("allows a hostname whose answer falls in an allowlisted CIDR", async () => {
    stubResolve("10.1.2.3");
    await expect(
      resolveWebhookTarget("http://svc.internal/hook", allow("10.0.0.0/8")),
    ).resolves.toMatchObject({ addresses: [{ address: "10.1.2.3" }] });
  });

  it("refuses a non-allowlisted hostname resolving to a private address", async () => {
    stubResolve("192.168.2.40");
    const err = await refusal("https://nas.latte.lan/hook");
    expect(err.code).toBe("private_not_allowlisted");
    expect(err.message).toContain("nas.latte.lan");
    expect(err.message).toContain("192.168.2.40");
  });

  it("matches IPv6 ULA CIDRs", async () => {
    await expect(
      resolveWebhookTarget("http://[fd12:3456::5]/hook", allow("fd12::/16")),
    ).resolves.toMatchObject({ addresses: [{ address: "fd12:3456::5", family: 6 }] });
  });

  it("matches an IPv4-mapped answer against an IPv4 CIDR", async () => {
    stubResolve("::ffff:192.168.2.40");
    await expect(
      resolveWebhookTarget("http://nas.example/hook", allow("192.168.0.0/16")),
    ).resolves.toMatchObject({ addresses: [{ address: "::ffff:192.168.2.40" }] });
  });

  it("keeps honouring the legacy WEBHOOK_ALLOW_PRIVATE hatch", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE = "true";
    await expect(
      resolveWebhookTarget("http://192.168.2.40/hook", allow()),
    ).resolves.toMatchObject({ addresses: [{ address: "192.168.2.40" }] });
  });
});

describe("resolveWebhookTarget — never allowlistable", () => {
  it.each([
    ["http://127.0.0.1/hook", "127.0.0.0/8", "blocked_loopback"],
    ["http://[::1]/hook", "::/0", "blocked_loopback"],
    ["http://169.254.169.254/latest", "169.254.0.0/16", "blocked_metadata"],
    ["http://100.100.100.200/", "100.64.0.0/10", "blocked_metadata"],
    ["http://[fd00:ec2::254]/", "fd00::/8", "blocked_metadata"],
    ["http://224.0.0.1/", "224.0.0.0/4", "blocked_reserved"],
    ["http://0.1.2.3/", "0.0.0.0/8", "blocked_reserved"],
    ["http://[64:ff9b::c0a8:228]/", "64:ff9b::/96", "blocked_reserved"],
  ])("%s stays refused even with %s allowlisted", async (url, cidr, code) => {
    const err = await refusal(url, allow(cidr));
    expect(err.code).toBe(code);
  });

  it("refuses an allowlisted hostname that resolves to loopback", async () => {
    stubResolve("127.0.0.1");
    const err = await refusal("http://nas.latte.lan/", allow("nas.latte.lan"));
    expect(err.code).toBe("blocked_loopback");
  });

  it("refuses the metadata hostnames", async () => {
    const err = await refusal(
      "http://metadata.google.internal/",
      allow("metadata.google.internal"),
    );
    expect(err.code).toBe("blocked_metadata");
  });

  it("refuses when any one DNS answer is blocked", async () => {
    stubResolve("192.168.2.40", "169.254.169.254");
    const err = await refusal("http://nas.latte.lan/", allow("nas.latte.lan"));
    expect(err.code).toBe("blocked_metadata");
  });
});

describe("resolveWebhookTarget — https rule", () => {
  it("refuses plain http to a public address", async () => {
    const err = await refusal("http://203.0.113.10/hook");
    expect(err.code).toBe("https_required");
    expect(err.message).toContain("https");
  });

  it("refuses plain http to a hostname with any public answer", async () => {
    stubResolve("192.168.2.40", "203.0.113.10");
    const err = await refusal("http://mixed.example/", allow("192.168.0.0/16"));
    expect(err.code).toBe("https_required");
  });

  it("allows https to a public address", async () => {
    stubResolve("203.0.113.10");
    await expect(
      resolveWebhookTarget("https://hooks.example.com/x", allow()),
    ).resolves.toMatchObject({ addresses: [{ address: "203.0.113.10", family: 4 }] });
  });

  it("refuses non-http(s) schemes", async () => {
    const err = await refusal("ftp://203.0.113.10/");
    expect(err.code).toBe("invalid_scheme");
  });

  it("refuses unparseable URLs", async () => {
    const err = await refusal("not a url");
    expect(err.code).toBe("invalid_url");
  });

  it("reports DNS failures with the host name", async () => {
    mockedLookup.mockRejectedValue(new Error("ENOTFOUND"));
    const err = await refusal("https://nope.example/");
    expect(err.code).toBe("dns_failed");
    expect(err.message).toContain("nope.example");
  });
});

describe("resolveWebhookTarget — DNS rebinding", () => {
  it("resolves once and hands back the checked address to connect to", async () => {
    // A rebinding resolver: first answer passes, the next one would hit loopback.
    mockedLookup
      .mockResolvedValueOnce([{ address: "192.168.2.40", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
    const target = await resolveWebhookTarget(
      "http://nas.latte.lan/hook",
      allow("nas.latte.lan"),
    );
    expect(target).toMatchObject({ addresses: [{ address: "192.168.2.40", family: 4 }] });
    expect(target.url.hostname).toBe("nas.latte.lan");
    expect(mockedLookup).toHaveBeenCalledTimes(1);
  });

  it("keeps every checked answer, in resolver order, for happy-eyeballs", async () => {
    stubResolve("2606:4700:4700::1111", "203.0.113.10");
    const target = await resolveWebhookTarget("https://dual.example/hook", allow());
    expect(target.addresses).toEqual([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "203.0.113.10", family: 4 },
    ]);
  });

  it("pins IPv6 answers with family 6", async () => {
    stubResolve("2606:4700:4700::1111");
    await expect(
      resolveWebhookTarget("https://v6.example/hook", allow()),
    ).resolves.toMatchObject({ addresses: [{ address: "2606:4700:4700::1111", family: 6 }] });
  });
});
