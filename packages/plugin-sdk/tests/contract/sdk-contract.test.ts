/**
 * Consumer-side (SDK) contract test against the canonical wire-contract
 * fixtures in `contract-fixtures.json`.
 *
 * The SDK is the *consumer* of the bot RPC provider and the *consumer*
 * of the bot's outbound dispatch (commands / events / lifecycle) — it
 * signs nothing on those inbound routes, it VERIFIES the bot's
 * signature, parses the bot's envelope, and joins the bot's streams.
 *
 * This test pins the SDK's half of the contract to the same literal
 * fixtures the bot's contract test asserts against (the bot test reads
 * THIS json file at runtime). If the SDK's hmac / streams-protocol /
 * events / manifest surface drifts away from the agreed contract, the
 * assertions below go red on the SDK CI run. If the BOT drifts, the
 * bot's contract test (reading the same json) goes red on the bot CI
 * run. Either way a broken contract is caught before deploy.
 *
 * Pure: no live bot, no Redis, no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  REPLAY_WINDOW_SECONDS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  sign,
  verify,
  isFreshTimestamp,
} from "../../src/hmac.js";
import {
  DLQ_SUFFIX,
  PLUGIN_STREAM_PREFIX,
  pluginDlqKeyFor,
  pluginStreamKeyFor,
} from "../../src/streams-protocol.js";
import { Events, isCanonicalEvent } from "../../src/events.js";

// The canonical fixtures live in the SOURCE tree at
// tests/contract/contract-fixtures.json. tsc does not copy .json into
// dist-test, so we read it from source. The compiled test runs from
// <pkg>/dist-test/tests/contract/; the package root is three levels up.
// Walk up to be resilient to the exact compiled depth.
function loadFixtures(): ContractFixtures {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, "tests/contract/contract-fixtures.json");
    try {
      return JSON.parse(readFileSync(candidate, "utf8")) as ContractFixtures;
    } catch {
      dir = resolve(dir, "..");
    }
  }
  throw new Error("could not locate contract-fixtures.json from " + import.meta.url);
}
const fixtures = loadFixtures();

interface ContractFixtures {
  hmac: {
    signatureHeader: string;
    timestampHeader: string;
    replayWindowSeconds: number;
    golden: Array<{
      name: string;
      secret: string;
      method: string;
      path: string;
      ts: string;
      body: string;
      nonce: string;
      expectedHex: string;
    }>;
  };
  streams: {
    streamPrefix: string;
    dlqSuffix: string;
    samples: Array<{ pluginKey: string; streamKey: string; dlqKey: string }>;
  };
  events: { canonical: string[] };
  dispatchEnvelope: { httpBodyKeys: string[] };
  rpc: { pathsCalledBySdk: string[] };
  register: { requiredResponseFields: string[] };
}

describe("contract: hmac headers + window", () => {
  it("SDK signature header matches the contract", () => {
    assert.equal(SIGNATURE_HEADER, fixtures.hmac.signatureHeader);
  });
  it("SDK timestamp header matches the contract", () => {
    assert.equal(TIMESTAMP_HEADER, fixtures.hmac.timestampHeader);
  });
  it("SDK replay window matches the contract", () => {
    assert.equal(REPLAY_WINDOW_SECONDS, fixtures.hmac.replayWindowSeconds);
  });
});

describe("contract: hmac sign reproduces golden hex", () => {
  for (const g of fixtures.hmac.golden) {
    it(`sign() matches golden for '${g.name}'`, () => {
      assert.equal(sign(g.secret, g.method, g.path, g.ts, g.nonce, g.body), g.expectedHex);
    });
    it(`verify() accepts the golden signature for '${g.name}'`, () => {
      assert.equal(
        verify({
          secret: g.secret,
          method: g.method,
          path: g.path,
          ts: g.ts,
          nonce: g.nonce,
          body: g.body,
          presented: g.expectedHex,
        }),
        true,
      );
    });
    it(`verify() rejects a tampered body for '${g.name}'`, () => {
      assert.equal(
        verify({
          secret: g.secret,
          method: g.method,
          path: g.path,
          ts: g.ts,
          nonce: g.nonce,
          body: g.body + "X",
          presented: g.expectedHex,
        }),
        false,
      );
    });
  }
  it("isFreshTimestamp honours the contract window boundary", () => {
    const now = 1700000000;
    const w = fixtures.hmac.replayWindowSeconds;
    assert.equal(isFreshTimestamp(String(now - w), now), true);
    assert.equal(isFreshTimestamp(String(now - w - 1), now), false);
  });
});

describe("contract: streams key conventions", () => {
  it("STREAM_PREFIX matches the contract", () => {
    assert.equal(PLUGIN_STREAM_PREFIX, fixtures.streams.streamPrefix);
  });
  it("DLQ_SUFFIX matches the contract", () => {
    assert.equal(DLQ_SUFFIX, fixtures.streams.dlqSuffix);
  });
  for (const s of fixtures.streams.samples) {
    it(`pluginStreamKeyFor('${s.pluginKey}') matches the contract`, () => {
      assert.equal(pluginStreamKeyFor(s.pluginKey), s.streamKey);
    });
    it(`pluginDlqKeyFor('${s.pluginKey}') matches the contract`, () => {
      assert.equal(pluginDlqKeyFor(s.pluginKey), s.dlqKey);
    });
  }
});

describe("contract: canonical event names", () => {
  it("Events exports exactly the contract's canonical set", () => {
    const sdkValues = Object.values(Events).slice().sort();
    const contractValues = fixtures.events.canonical.slice().sort();
    assert.deepEqual(sdkValues, contractValues);
  });
  for (const name of fixtures.events.canonical) {
    it(`isCanonicalEvent('${name}') is true`, () => {
      assert.equal(isCanonicalEvent(name), true);
    });
  }
  it("isCanonicalEvent rejects a non-contract event", () => {
    assert.equal(isCanonicalEvent("guild.member_join"), false);
  });
});
