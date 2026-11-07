/**
 * The public-media rule (#158): one definition, shared by the bot's
 * `assertPublicMediaTarget` and the voice media proxy.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import {
  MediaTargetRefusedError,
  isPublicMediaAddress,
  resolvePublicMediaTarget,
} from "../src/net/index.js";

const fakeLookup =
  (answers: Array<{ address: string; family: number }>) =>
  async () =>
    answers;

describe("isPublicMediaAddress", () => {
  it("passes public addresses only", () => {
    assert.equal(isPublicMediaAddress("8.8.8.8"), true);
    assert.equal(isPublicMediaAddress("2606:4700:4700::1111"), true);
    for (const ip of [
      "127.0.0.1",
      "::1",
      "10.0.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "100.100.100.200",
      "0.0.0.0",
      "224.0.0.1",
      "64:ff9b::808:808",
      "::ffff:127.0.0.1",
    ]) {
      assert.equal(isPublicMediaAddress(ip), false, ip);
    }
  });

  it("lets private (only) through with the legacy hatch", () => {
    assert.equal(isPublicMediaAddress("10.0.0.5", { allowPrivate: true }), true);
    assert.equal(isPublicMediaAddress("127.0.0.1", { allowPrivate: true }), false);
    assert.equal(
      isPublicMediaAddress("169.254.169.254", { allowPrivate: true }),
      false,
    );
  });

  it("refuses a non-literal", () => {
    assert.equal(isPublicMediaAddress("example.com"), false);
  });
});

describe("resolvePublicMediaTarget", () => {
  afterEach(() => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
  });

  it("returns the pinned address of a public literal", async () => {
    assert.deepEqual(await resolvePublicMediaTarget("8.8.8.8", 443), [
      { address: "8.8.8.8", family: 4 },
    ]);
    assert.deepEqual(await resolvePublicMediaTarget("[2606:4700::1]", 80), [
      { address: "2606:4700::1", family: 6 },
    ]);
  });

  it("returns every DNS answer when all are public", async () => {
    const got = await resolvePublicMediaTarget("cdn.example.com", 443, {
      lookup: fakeLookup([
        { address: "1.1.1.1", family: 4 },
        { address: "2606:4700::1", family: 6 },
      ]),
    });
    assert.deepEqual(got, [
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ]);
  });

  it("refuses the whole host when one answer is not public", async () => {
    await assert.rejects(
      resolvePublicMediaTarget("sneaky.example.com", 443, {
        lookup: fakeLookup([
          { address: "1.1.1.1", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ]),
      }),
      MediaTargetRefusedError,
    );
  });

  it("refuses loopback / private / metadata literals", async () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1"]) {
      await assert.rejects(
        resolvePublicMediaTarget(host, 80),
        MediaTargetRefusedError,
        host,
      );
    }
  });

  it("honours WEBHOOK_ALLOW_PRIVATE per call, for private only", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE = "true";
    assert.deepEqual(await resolvePublicMediaTarget("10.0.0.5", 80), [
      { address: "10.0.0.5", family: 4 },
    ]);
    await assert.rejects(
      resolvePublicMediaTarget("127.0.0.1", 80),
      MediaTargetRefusedError,
    );
  });

  it("refuses metadata hostnames without resolving them", async () => {
    let asked = false;
    await assert.rejects(
      resolvePublicMediaTarget("Metadata.Google.Internal.", 80, {
        lookup: async () => {
          asked = true;
          return [{ address: "8.8.8.8", family: 4 }];
        },
      }),
      MediaTargetRefusedError,
    );
    assert.equal(asked, false);
  });

  it("refuses an invalid host, an invalid port, and a DNS failure", async () => {
    await assert.rejects(resolvePublicMediaTarget("bad host", 80), MediaTargetRefusedError);
    await assert.rejects(resolvePublicMediaTarget("8.8.8.8", 0), MediaTargetRefusedError);
    await assert.rejects(resolvePublicMediaTarget("8.8.8.8", 65536), MediaTargetRefusedError);
    await assert.rejects(
      resolvePublicMediaTarget("gone.example.com", 80, {
        lookup: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
      MediaTargetRefusedError,
    );
    await assert.rejects(
      resolvePublicMediaTarget("empty.example.com", 80, { lookup: fakeLookup([]) }),
      MediaTargetRefusedError,
    );
  });
});
