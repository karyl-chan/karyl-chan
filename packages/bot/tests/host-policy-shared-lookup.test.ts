/**
 * #260 — every host policy shares a running DNS lookup, and media URLs
 * have a cap on lookups at once.
 *
 * dns.lookup cannot be aborted and holds a libuv threadpool worker until
 * the OS gives up. Concurrent checks of a host now wait on one lookup,
 * each policy still judging the addresses itself; media URLs, whose
 * hostnames anyone can vary, take one of MEDIA_LOOKUP_SLOTS per lookup and
 * are refused when none is free.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dns/promises", () => ({ lookup: vi.fn() }));

const { lookup } = await import("dns/promises");
const {
  assertPluginTarget,
  assertPublicMediaTarget,
  resolveAllowedTarget,
  resolveWebhookTarget,
  HostPolicyError,
} = await import("../src/utils/host-policy.js");

const mockedLookup = vi.mocked(lookup);
type LookupResult = Awaited<ReturnType<typeof lookup>>;

/** Lookups the test answers by hand, in call order. */
let pending: Array<{
  resolve: (r: LookupResult) => void;
  reject: (e: Error) => void;
}> = [];

/** Let the settled lookups' cleanup run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

function answer(address: string): LookupResult {
  return [{ address, family: 4 }] as unknown as LookupResult;
}

beforeEach(() => {
  pending = [];
  mockedLookup.mockReset();
  mockedLookup.mockImplementation(
    (() =>
      new Promise<LookupResult>((resolve, reject) => {
        pending.push({ resolve, reject });
      })) as unknown as typeof lookup,
  );
});

afterEach(async () => {
  // A lookup left running would be shared into the next test, and a
  // media one would keep its slot.
  for (const p of pending) p.reject(new Error("given up after the test"));
  await tick();
});

describe("a running lookup is shared across policies", () => {
  it("starts one lookup for concurrent checks of the same host; each policy judges it", async () => {
    const plugin = assertPluginTarget("svc.internal", 8080);
    const rcon = resolveAllowedTarget("svc.internal", 25575);
    const webhook = resolveWebhookTarget("http://svc.internal:8080/hook", []);
    expect(mockedLookup).toHaveBeenCalledTimes(1);

    pending[0].resolve(answer("10.0.0.5"));
    await expect(plugin).resolves.toBeUndefined();
    await expect(rcon).resolves.toEqual([{ address: "10.0.0.5", family: 4 }]);
    // private and not allowlisted: the webhook policy still refuses
    await expect(webhook).rejects.toMatchObject({ code: "private_not_allowlisted" });
  });

  it("resolves afresh once the lookup settled", async () => {
    const first = assertPluginTarget("svc.internal", 8080);
    pending[0].resolve(answer("10.0.0.5"));
    await first;
    await tick();

    const second = resolveAllowedTarget("svc.internal", 25575);
    expect(mockedLookup).toHaveBeenCalledTimes(2);
    pending[1].resolve(answer("169.254.169.254"));
    await expect(second).rejects.toBeInstanceOf(HostPolicyError);
  });

  it("refuses every waiter when the shared lookup fails", async () => {
    const plugin = assertPluginTarget("gone.internal", 8080);
    const webhook = resolveWebhookTarget("https://gone.internal/hook", []);
    pending[0].reject(new Error("ENOTFOUND"));
    await expect(plugin).rejects.toThrow("無法解析主機名稱");
    await expect(webhook).rejects.toMatchObject({ code: "dns_failed" });
  });
});

describe("media URL lookups have a cap", () => {
  it("refuses a third media host while two lookups run, and not other policies", async () => {
    const running = [
      assertPublicMediaTarget("a.example.com", 443),
      assertPublicMediaTarget("b.example.com", 443),
    ];
    await expect(assertPublicMediaTarget("c.example.com", 443)).rejects.toThrow("無法解析主機名稱");
    expect(mockedLookup).toHaveBeenCalledTimes(2);

    // the cap is the media group's alone
    const plugin = assertPluginTarget("svc.internal", 8080);
    expect(mockedLookup).toHaveBeenCalledTimes(3);

    for (const p of pending) p.resolve(answer("93.184.216.34"));
    await Promise.all([...running, plugin]);
    await tick();

    // the slots came back
    const after = assertPublicMediaTarget("c.example.com", 443);
    expect(mockedLookup).toHaveBeenCalledTimes(4);
    pending[3].resolve(answer("93.184.216.34"));
    await expect(after).resolves.toBeUndefined();
  });
});
