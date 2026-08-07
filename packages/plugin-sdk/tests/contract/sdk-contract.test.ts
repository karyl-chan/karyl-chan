/**
 * Consumer-side (SDK) contract test against the canonical wire-contract
 * fixtures — `CONTRACT_FIXTURES`, owned by `@karyl-chan/plugin-wire`.
 *
 * The SDK is the *consumer* of the bot RPC provider and the *consumer*
 * of the bot's outbound dispatch (commands / events / lifecycle) — it
 * signs nothing on those inbound routes, it VERIFIES the bot's
 * signature, parses the bot's envelope, and joins the bot's streams.
 *
 * This test pins the SDK's half of the contract to the same literals the
 * bot's contract test replays through its real routes. Both sides now
 * `import` the fixtures from the wire package (issue #29 decision 8);
 * nobody reads a file across a package boundary. If the SDK's hmac /
 * streams-protocol / events / payload-type surface drifts away from the
 * agreed contract, the assertions below go red on the SDK CI run. If the
 * BOT drifts, its contract test goes red on the bot CI run. Either way a
 * broken contract is caught before deploy.
 *
 * Pure: no live bot, no Redis, no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONTRACT_FIXTURES as fixtures } from "@karyl-chan/plugin-wire";
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
import { Events, isCanonicalEvent } from "../../src/index.js";
import type {
  InteractionPayload,
  AutocompletePayload,
  ComponentPayload,
  ModalPayload,
} from "../../src/index.js";

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

// ─── Dispatch payload types ↔ fixtures ──────────────────────────────────────
// The consumer half of the field-level dispatch-payload guard (#29
// decision 8). The bot's contract test replays a real interaction and
// asserts the POSTed JSON carries every fixture field; this side proves
// the fixture lists still describe the SDK interfaces those bodies are
// parsed as. `Required<T>` makes each sample a COMPILE-time enumeration
// of the interface's keys — add a field to `InteractionPayload` and this
// file stops compiling until the fixture (and therefore the bot's
// assertion) learns about it.
//
// Direction is SDK ⊆ fixture: every field the SDK declares must be a
// field the bot is asserted to send. The fixtures may legitimately carry
// MORE (a field that is on the wire but which no SDK type has caught up
// to yet) — those still get asserted bot-side, which is the point.

const samplePayloads: Record<
  keyof typeof fixtures.dispatchEnvelope.payloads,
  { top: Record<string, unknown>; user: Record<string, unknown>; member: Record<string, unknown> | null }
> = {
  command: (() => {
    const member: Required<NonNullable<InteractionPayload["member"]>> = {
      capabilities: [],
      permissions: null,
    };
    const user: Required<InteractionPayload["user"]> = {
      id: "1",
      username: "u",
      global_name: null,
    };
    const top: Required<InteractionPayload> = {
      interaction_id: "1",
      interaction_token: "t",
      application_id: "a",
      command_name: "c",
      sub_command_name: null,
      sub_command_group: null,
      options: [],
      guild_id: null,
      channel_id: null,
      user,
      member,
      locale: null,
      guild_locale: null,
    };
    return { top, user, member };
  })(),
  autocomplete: (() => {
    const user: Required<AutocompletePayload["user"]> = {
      id: "1",
      username: "u",
      global_name: null,
    };
    const top: Required<AutocompletePayload> = {
      interaction_id: "1",
      command_name: "c",
      sub_command_name: null,
      sub_command_group: null,
      options: [],
      focused: { name: "f", value: "", type: 3 },
      guild_id: null,
      user,
      locale: null,
      guild_locale: null,
    };
    // The autocomplete body carries no member object.
    return { top, user, member: null };
  })(),
  component: (() => {
    const member: Required<NonNullable<ComponentPayload["member"]>> = {
      voice_channel_id: null,
      capabilities: [],
      permissions: null,
    };
    const user: Required<ComponentPayload["user"]> = {
      id: "1",
      username: "u",
      global_name: null,
    };
    const top: Required<ComponentPayload> = {
      interaction_id: "1",
      interaction_token: "t",
      application_id: "a",
      custom_id: "kc:p:x",
      component_type: 2,
      selected_values: [],
      guild_id: null,
      channel_id: null,
      message_id: "m",
      user,
      member,
      locale: null,
      guild_locale: null,
    };
    return { top, user, member };
  })(),
  modal: (() => {
    const member: Required<NonNullable<ModalPayload["member"]>> = {
      capabilities: [],
      permissions: null,
    };
    const user: Required<ModalPayload["user"]> = {
      id: "1",
      username: "u",
      global_name: null,
    };
    const top: Required<ModalPayload> = {
      interaction_id: "1",
      interaction_token: "t",
      application_id: "a",
      custom_id: "kc:p:m",
      guild_id: null,
      channel_id: null,
      user,
      member,
      components: [],
      locale: null,
      guild_locale: null,
    };
    return { top, user, member };
  })(),
};

/**
 * Divergences between the fixtures and the SDK payload interfaces that
 * exist as of this commit. Each is a real gap worth closing; they are
 * ENUMERATED rather than ignored so a *new* divergence fails this test
 * instead of joining an invisible pile.
 *
 * Keyed `<kind>.<level>`; the value is the exact symmetric difference
 * between the SDK's declared key set and the fixture's field list.
 */
const KNOWN_PAYLOAD_GAPS: Record<string, readonly string[]> = {
  // `AutocompletePayload.user` optimistically declares optional
  // `username` / `global_name`; the bot deliberately sends only
  // `user.id` on that path (Discord's 3 s budget leaves no room for a
  // member/capability resolution). Both are optional SDK-side, so
  // nothing breaks — the type is just wider than the wire.
  "autocomplete.user": ["username", "global_name"],
};

function symmetricDiff(
  a: readonly string[],
  b: readonly string[],
): string[] {
  const bs = new Set(b);
  const as = new Set(a);
  return [
    ...a.filter((x) => !bs.has(x)),
    ...b.filter((x) => !as.has(x)),
  ].sort();
}

describe("contract: dispatch payload types match the fixtures", () => {
  for (const [kind, spec] of Object.entries(
    fixtures.dispatchEnvelope.payloads,
  )) {
    const sample = samplePayloads[kind as keyof typeof samplePayloads];

    it(`${kind}: SDK top-level fields match the contract`, () => {
      assert.deepEqual(
        symmetricDiff(Object.keys(sample.top), spec.requiredFields),
        [...(KNOWN_PAYLOAD_GAPS[`${kind}.top`] ?? [])].sort(),
      );
    });

    it(`${kind}: SDK user fields match the contract`, () => {
      assert.deepEqual(
        symmetricDiff(Object.keys(sample.user), spec.userFields),
        [...(KNOWN_PAYLOAD_GAPS[`${kind}.user`] ?? [])].sort(),
      );
    });

    it(`${kind}: SDK member fields match the contract`, () => {
      if (sample.member === null) {
        assert.equal(
          spec.memberFields,
          null,
          `${kind} carries no member object, so memberFields must be null`,
        );
        return;
      }
      assert.notEqual(spec.memberFields, null);
      assert.deepEqual(
        symmetricDiff(Object.keys(sample.member), spec.memberFields ?? []),
        [...(KNOWN_PAYLOAD_GAPS[`${kind}.member`] ?? [])].sort(),
      );
    });
  }
});
