/**
 * The contract fixtures live next to the contract they describe (#29
 * decision 8). This suite pins the parts of `CONTRACT_FIXTURES` that
 * plugin-wire itself owns, so a drift is caught in plugin-wire's own CI
 * cell rather than surfacing as a confusing failure on the bot or SDK.
 *
 * The bot's and SDK's contract tests replay the rest of the fixtures
 * through their own real code paths.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CANONICAL_EVENTS, Events } from "../src/events.js";
import { CONTRACT_FIXTURES } from "../src/contract-fixtures.js";

describe("contract fixtures: canonical events", () => {
  it("fixture event list equals the CANONICAL_EVENTS ledger", () => {
    assert.deepEqual(
      [...CONTRACT_FIXTURES.events.canonical].sort(),
      CANONICAL_EVENTS.map((e) => e.name).sort(),
    );
  });

  it("fixture event list equals the Events value map", () => {
    assert.deepEqual(
      [...CONTRACT_FIXTURES.events.canonical].sort(),
      Object.values(Events).slice().sort(),
    );
  });
});

describe("contract fixtures: internal consistency", () => {
  it("every stream sample's dlq key is its stream key + the dlq suffix", () => {
    const { dlqSuffix, streamPrefix, samples } = CONTRACT_FIXTURES.streams;
    for (const s of samples) {
      assert.equal(s.dlqKey, s.streamKey + dlqSuffix);
      assert.ok(
        s.streamKey.startsWith(streamPrefix),
        `${s.streamKey} does not start with ${streamPrefix}`,
      );
    }
  });

  it("required and optional register response fields do not overlap", () => {
    const { requiredResponseFields, optionalResponseFields } =
      CONTRACT_FIXTURES.register;
    for (const f of requiredResponseFields) {
      assert.ok(
        !optionalResponseFields.includes(f),
        `'${f}' is listed both required and optional`,
      );
    }
  });

  it("every RPC path the SDK calls is unique and plugin-scoped", () => {
    const paths = CONTRACT_FIXTURES.rpc.pathsCalledBySdk;
    assert.equal(new Set(paths).size, paths.length, "duplicate RPC path");
    for (const p of paths) {
      assert.ok(
        p.startsWith("/api/plugin/"),
        `${p} is not under the plugin RPC prefix`,
      );
    }
  });

  it("every dispatch payload contract declares distinct field names", () => {
    for (const [kind, spec] of Object.entries(
      CONTRACT_FIXTURES.dispatchEnvelope.payloads,
    )) {
      assert.equal(
        new Set(spec.requiredFields).size,
        spec.requiredFields.length,
        `${kind}: duplicate required field`,
      );
      // A payload that carries a `member` object must describe it, and
      // one that doesn't must not — otherwise the bot-side replay test
      // would silently skip the member assertions.
      const carriesMember = spec.requiredFields.includes("member");
      assert.equal(
        carriesMember,
        spec.memberFields !== null,
        `${kind}: 'member' in requiredFields must agree with memberFields`,
      );
    }
  });
});
