/**
 * Pure stream-protocol helpers: parsing, DLQ-decision, lag math.
 * No Redis — exercises the testable core of the Streams transport.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeLag,
  decideRedelivery,
  dlqKeyFor,
  parseStreamEntry,
  streamKeyFor,
} from "../src/streams-protocol.js";

describe("streamKeyFor / dlqKeyFor", () => {
  it("builds the per-event-type stream key", () => {
    assert.equal(
      streamKeyFor("guild.message_create"),
      "karyl:events:guild.message_create",
    );
  });
  it("derives the DLQ key from the stream key", () => {
    assert.equal(
      dlqKeyFor("guild.message_create"),
      "karyl:events:guild.message_create:dlq",
    );
  });
});

describe("parseStreamEntry", () => {
  it("decodes a well-formed entry", () => {
    const parsed = parseStreamEntry([
      "1-0",
      [
        "type",
        "guild.message_create",
        "data",
        JSON.stringify({ a: 1 }),
        "traceparent",
        "00-" + "0".repeat(32) + "-" + "0".repeat(16) + "-01",
      ],
    ]);
    assert.ok(parsed);
    assert.equal(parsed.id, "1-0");
    assert.equal(parsed.type, "guild.message_create");
    assert.deepEqual(parsed.data, { a: 1 });
    assert.match(parsed.traceparent ?? "", /^00-/);
  });

  it("falls back to the `trace` field when `traceparent` is absent", () => {
    const parsed = parseStreamEntry([
      "2-0",
      ["type", "x", "data", "{}", "trace", "tp-value"],
    ]);
    assert.equal(parsed?.traceparent, "tp-value");
  });

  it("treats a missing data field as an empty object (legal no-payload event)", () => {
    const parsed = parseStreamEntry(["3-0", ["type", "x"]]);
    assert.ok(parsed);
    assert.deepEqual(parsed.data, {});
  });

  it("rejects malformed data JSON as poison (null)", () => {
    assert.equal(
      parseStreamEntry(["4-0", ["type", "x", "data", "{not json"]]),
      null,
    );
  });

  it("rejects an entry missing the type field", () => {
    assert.equal(parseStreamEntry(["5-0", ["data", "{}"]]), null);
  });

  it("rejects structurally broken entries", () => {
    assert.equal(parseStreamEntry(null), null);
    assert.equal(parseStreamEntry(["only-id"]), null);
    assert.equal(parseStreamEntry(["", ["type", "x"]]), null);
    // odd field count
    assert.equal(parseStreamEntry(["6-0", ["type"]]), null);
  });

  it("preserves the raw field array for lossless DLQ re-XADD", () => {
    const fields = ["type", "x", "data", "{}", "extra", "v"];
    const parsed = parseStreamEntry(["7-0", fields]);
    assert.deepEqual(parsed?.raw, fields);
  });
});

describe("decideRedelivery", () => {
  it("retries while under the ceiling", () => {
    assert.equal(decideRedelivery(1, 5), "retry");
    assert.equal(decideRedelivery(4, 5), "retry");
  });
  it("dead-letters once the ceiling is reached", () => {
    assert.equal(decideRedelivery(5, 5), "dlq");
    assert.equal(decideRedelivery(9, 5), "dlq");
  });
});

describe("computeLag", () => {
  it("prefers the server-reported lag when present", () => {
    assert.equal(
      computeLag({ reportedLag: 7, streamLength: 100, entriesRead: 50 }),
      7,
    );
  });
  it("falls back to length - entriesRead when lag is null", () => {
    assert.equal(
      computeLag({ reportedLag: null, streamLength: 100, entriesRead: 80 }),
      20,
    );
  });
  it("reports full length when neither signal is usable", () => {
    assert.equal(
      computeLag({ reportedLag: null, streamLength: 42, entriesRead: null }),
      42,
    );
  });
  it("never returns a negative lag", () => {
    assert.equal(
      computeLag({ reportedLag: -3, streamLength: 0, entriesRead: null }),
      0,
    );
    assert.equal(
      computeLag({ reportedLag: null, streamLength: 5, entriesRead: 10 }),
      0,
    );
  });
});
