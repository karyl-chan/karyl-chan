/**
 * #260 — a running host lookup is shared, and media lookups have a cap.
 *
 * dns.lookup cannot be aborted and holds a libuv threadpool worker until
 * the OS gives up, so while DNS hangs every caller that starts its own
 * lookup takes another worker. `lookupHostAddresses` shares a running
 * lookup by host; a group with any number of hostnames (media URLs) also
 * guards its resolver with `LookupSlots`, refused when no slot is free.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  LookupSlots,
  LookupSlotsFullError,
  MEDIA_LOOKUP_SLOTS,
  TargetRefusedError,
  lookupHostAddresses,
  resolvePublicMediaTarget,
  type HostLookup,
} from "../src/net/index.js";

type Answers = Array<{ address: string; family: number }>;

/** A resolver whose lookups the test answers or fails by hand. */
function manualLookup() {
  const pending: Array<{
    resolve: (answers: Answers) => void;
    reject: (err: Error) => void;
  }> = [];
  const lookup: HostLookup = () =>
    new Promise<Answers>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  return { lookup, pending };
}

const v4 = (address: string) => ({ address, family: 4 });

/** Let the settled lookups' cleanup run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function refusal(promise: Promise<unknown>): Promise<TargetRefusedError> {
  const err = await promise.then(
    () => assert.fail("expected a refusal"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof TargetRefusedError);
  return err;
}

describe("lookupHostAddresses: a running lookup is shared", () => {
  it("starts one lookup for concurrent callers of the same host", async () => {
    const { lookup, pending } = manualLookup();
    const first = lookupHostAddresses("cdn.example.com", lookup);
    const second = lookupHostAddresses("CDN.example.com.", lookup);
    assert.equal(pending.length, 1);
    pending[0].resolve([v4("93.184.216.34")]);
    assert.deepEqual(await first, ["93.184.216.34"]);
    assert.deepEqual(await second, ["93.184.216.34"]);
  });

  it("gives each caller its own array", async () => {
    const { lookup, pending } = manualLookup();
    const first = lookupHostAddresses("cdn.example.com", lookup);
    const second = lookupHostAddresses("cdn.example.com", lookup);
    pending[0].resolve([v4("93.184.216.34")]);
    const [a, b] = await Promise.all([first, second]);
    assert.notEqual(a, b);
  });

  it("resolves afresh once the lookup settled, so an answer is never reused", async () => {
    const { lookup, pending } = manualLookup();
    const first = lookupHostAddresses("cdn.example.com", lookup);
    pending[0].resolve([v4("93.184.216.34")]);
    await first;
    await tick();
    const second = lookupHostAddresses("cdn.example.com", lookup);
    assert.equal(pending.length, 2);
    pending[1].resolve([v4("93.184.216.35")]);
    assert.deepEqual(await second, ["93.184.216.35"]);
  });

  it("refuses every waiter as dns_failed when the lookup fails, then forgets it", async () => {
    const { lookup, pending } = manualLookup();
    const first = lookupHostAddresses("gone.example.com", lookup);
    const second = lookupHostAddresses("gone.example.com", lookup);
    const cause = new Error("ENOTFOUND");
    pending[0].reject(cause);
    for (const err of [await refusal(first), await refusal(second)]) {
      assert.equal(err.reason, "dns_failed");
      assert.equal(err.cause, cause);
    }
    await tick();
    void lookupHostAddresses("gone.example.com", lookup).catch(() => {});
    assert.equal(pending.length, 2);
    pending[1].reject(cause);
  });

  it("does not share between different hosts or different resolvers", async () => {
    const a = manualLookup();
    const b = manualLookup();
    const calls = [
      lookupHostAddresses("one.example.com", a.lookup),
      lookupHostAddresses("two.example.com", a.lookup),
      lookupHostAddresses("one.example.com", b.lookup),
    ];
    assert.equal(a.pending.length, 2);
    assert.equal(b.pending.length, 1);
    for (const p of [...a.pending, ...b.pending]) p.resolve([v4("93.184.216.34")]);
    await Promise.all(calls);
  });

  it("never looks up an IP literal", async () => {
    const { lookup, pending } = manualLookup();
    assert.deepEqual(await lookupHostAddresses("8.8.8.8", lookup), ["8.8.8.8"]);
    assert.equal(pending.length, 0);
  });
});

describe("LookupSlots.guard", () => {
  it("refuses a lookup that finds no free slot, without starting it", async () => {
    const { lookup, pending } = manualLookup();
    const guarded = new LookupSlots(2).guard(lookup);
    const running = [
      lookupHostAddresses("a.example.com", guarded),
      lookupHostAddresses("b.example.com", guarded),
    ];
    const err = await refusal(lookupHostAddresses("c.example.com", guarded));
    assert.equal(err.reason, "dns_failed");
    assert.ok(err.cause instanceof LookupSlotsFullError);
    assert.equal(pending.length, 2);

    // one lookup ending frees its slot while the other still runs
    pending[0].resolve([v4("93.184.216.34")]);
    await running[0];
    await tick();
    const third = lookupHostAddresses("c.example.com", guarded);
    assert.equal(pending.length, 3);
    // a failed lookup frees its slot too
    pending[1].reject(new Error("ETIMEOUT"));
    await Promise.allSettled(running);
    await tick();
    const fourth = lookupHostAddresses("d.example.com", guarded);
    assert.equal(pending.length, 4);
    pending[2].resolve([v4("93.184.216.34")]);
    pending[3].resolve([v4("93.184.216.34")]);
    await Promise.all([third, fourth]);
  });

  it("shares a running lookup with unguarded callers of the same resolver, either way", async () => {
    const { lookup, pending } = manualLookup();
    const guarded = new LookupSlots(1).guard(lookup);
    // unguarded first: a guarded caller joins without a slot
    const plain = lookupHostAddresses("a.example.com", lookup);
    const joined = lookupHostAddresses("a.example.com", guarded);
    // so the one slot is still free for another host
    const other = lookupHostAddresses("b.example.com", guarded);
    // guarded first: an unguarded caller joins it
    const joinedOther = lookupHostAddresses("b.example.com", lookup);
    assert.equal(pending.length, 2);
    for (const p of pending) p.resolve([v4("93.184.216.34")]);
    await Promise.all([plain, joined, other, joinedOther]);
  });

  it("never shares a refusal: an unguarded caller of that host starts its own lookup", async () => {
    const { lookup, pending } = manualLookup();
    const guarded = new LookupSlots(1).guard(lookup);
    const running = lookupHostAddresses("a.example.com", guarded);
    const refused = refusal(lookupHostAddresses("b.example.com", guarded));
    const plain = lookupHostAddresses("b.example.com", lookup);
    assert.ok((await refused).cause instanceof LookupSlotsFullError);
    assert.equal(pending.length, 2);
    for (const p of pending) p.resolve([v4("93.184.216.34")]);
    assert.deepEqual(await plain, ["93.184.216.34"]);
    await running;
  });

  it("lets a caller join a running lookup without a slot", async () => {
    const { lookup, pending } = manualLookup();
    const guarded = new LookupSlots(1).guard(lookup);
    const first = lookupHostAddresses("a.example.com", guarded);
    const joined = lookupHostAddresses("a.example.com", guarded);
    pending[0].resolve([v4("93.184.216.34")]);
    assert.deepEqual(await joined, ["93.184.216.34"]);
    await first;
  });

  it("gives the slot back when the resolver throws synchronously", async () => {
    const slots = new LookupSlots(1);
    const throwing: HostLookup = () => {
      throw new Error("bad options");
    };
    const failing = refusal(lookupHostAddresses("a.example.com", slots.guard(throwing)));
    assert.equal((await failing).reason, "dns_failed");
    await tick();
    const { lookup, pending } = manualLookup();
    const next = lookupHostAddresses("a.example.com", slots.guard(lookup));
    assert.equal(pending.length, 1);
    pending[0].resolve([v4("93.184.216.34")]);
    await next;
  });
});

describe("resolvePublicMediaTarget takes the media lookup slots", () => {
  it("defaults to the process-wide MEDIA_LOOKUP_SLOTS (two)", async () => {
    assert.equal(MEDIA_LOOKUP_SLOTS.max, 2);
    const { lookup, pending } = manualLookup();
    const running = [
      resolvePublicMediaTarget("a.example.com", 443, { lookup }),
      resolvePublicMediaTarget("b.example.com", 443, { lookup }),
    ];
    const err = await refusal(resolvePublicMediaTarget("c.example.com", 443, { lookup }));
    assert.ok(err.cause instanceof LookupSlotsFullError);
    for (const p of pending) p.resolve([v4("93.184.216.34")]);
    await Promise.all(running);
    await tick();
  });
});
