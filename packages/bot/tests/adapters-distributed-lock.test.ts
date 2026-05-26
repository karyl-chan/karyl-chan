import { describe, expect, it } from "vitest";
import { InProcessDistributedLock } from "../src/adapters/distributed-lock.js";

describe("InProcessDistributedLock", () => {
  it("runs serially per key", async () => {
    const lock = new InProcessDistributedLock();
    const order: number[] = [];
    const tasks = [1, 2, 3].map((n) =>
      lock.run("k", async () => {
        order.push(n);
        await new Promise((r) => setTimeout(r, 10));
        order.push(n * 10);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it("does NOT serialise across different keys", async () => {
    const lock = new InProcessDistributedLock();
    const order: string[] = [];
    await Promise.all([
      lock.run("a", async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("a-end");
      }),
      lock.run("b", async () => {
        order.push("b-start");
        await new Promise((r) => setTimeout(r, 5));
        order.push("b-end");
      }),
    ]);
    // Both starts happen before either end (different keys interleave).
    expect(order.slice(0, 2).sort()).toEqual(["a-start", "b-start"]);
    expect(order).toContain("a-end");
    expect(order).toContain("b-end");
  });

  it("releases the lock after a throw, doesn't deadlock the next holder", async () => {
    const lock = new InProcessDistributedLock();
    await expect(
      lock.run("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Next holder must still acquire.
    const result = await lock.run("k", async () => "ok");
    expect(result).toBe("ok");
  });

  it("honours timeoutMs and rejects when fn outlasts the budget", async () => {
    const lock = new InProcessDistributedLock();
    await expect(
      lock.run(
        "k",
        () => new Promise((r) => setTimeout(r, 100)),
        { timeoutMs: 20 },
      ),
    ).rejects.toThrow(/timed out/);
  });

  it("isLeader always returns true in single-process mode", async () => {
    const lock = new InProcessDistributedLock();
    expect(await lock.isLeader("any-key")).toBe(true);
  });

  it("compacts the chain map for idle keys", async () => {
    const lock = new InProcessDistributedLock();
    await lock.run("transient", async () => undefined);
    // Internal Map should be empty after the single run resolved —
    // we probe via reflection because the field is private.
    const chains = (lock as unknown as { chains: Map<string, unknown> }).chains;
    expect(chains.size).toBe(0);
  });
});
