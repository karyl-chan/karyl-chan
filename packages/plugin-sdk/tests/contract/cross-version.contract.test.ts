/**
 * PM-6 — SDK cross-version wire compatibility (current × previous-minor).
 *
 * The SDK and bot ship as separate packages on independent release
 * cadences, so a plugin built on one SDK minor will, in the wild, talk to
 * a bot (or be talked to) across a version skew. This locks the parts of
 * the wire contract that MUST stay byte-identical across an SDK minor, by
 * comparing the current source against the published previous-minor
 * (@karyl-chan/plugin-sdk@0.10.0, aliased `@karyl-chan/plugin-sdk-prev`).
 *
 * Scope: the SDK×SDK cells of the PM-6 matrix. The bot×SDK cell
 * (old bot × new SDK) needs an old bot artifact and stays deferred — see
 * PLATFORM_MATURITY_PLAN PM-6. Bump the alias when previous-minor rolls.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as prev from "@karyl-chan/plugin-sdk-prev";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
} from "../../src/hmac.js";
import { DLQ_SUFFIX } from "../../src/streams-protocol.js";
import { Events } from "../../src/events.js";

const prevSdk = prev as Record<string, unknown>;

describe("contract: SDK cross-version (current × previous-minor 0.10.0)", () => {
  // HMAC dispatch headers are the auth handshake between bot and plugin.
  // If a header name drifts across an SDK minor, a plugin on one version
  // signs under a name the other never reads → every dispatch 401s. These
  // must be IDENTICAL across versions, full stop. (REPLAY_WINDOW_SECONDS
  // and PLUGIN_STREAM_PREFIX are 0.11 additions absent from 0.10.0's
  // export surface, so they aren't cross-comparable here.)
  const STABLE: [name: string, current: unknown, previous: unknown][] = [
    ["SIGNATURE_HEADER", SIGNATURE_HEADER, prevSdk.SIGNATURE_HEADER],
    ["TIMESTAMP_HEADER", TIMESTAMP_HEADER, prevSdk.TIMESTAMP_HEADER],
    ["NONCE_HEADER", NONCE_HEADER, prevSdk.NONCE_HEADER],
    ["DLQ_SUFFIX", DLQ_SUFFIX, prevSdk.DLQ_SUFFIX],
  ];
  for (const [name, current, previous] of STABLE) {
    it(`${name} is byte-identical to 0.10.0`, () => {
      assert.equal(
        previous,
        current,
        `${name} drifted since 0.10.0 — a version-skewed plugin/bot pair can no longer authenticate`,
      );
    });
  }

  // Canonical events may only GROW across versions (additive). Every event
  // a 0.10.0 plugin subscribes to must still be one the current bot emits,
  // or that plugin silently stops receiving it after a bot upgrade. (New
  // events the current SDK adds are fine — old plugins just don't use them.)
  it("every 0.10.0 canonical event still exists in the current set (no removals)", () => {
    const current = new Set<string>(Object.values(Events));
    const previous = Object.values(
      (prevSdk.Events ?? {}) as Record<string, string>,
    );
    assert.ok(previous.length > 0, "0.10.0 should export a non-empty Events set");
    const removed = previous.filter((e) => !current.has(e));
    assert.deepEqual(
      removed,
      [],
      `events removed since 0.10.0 break old plugins: ${removed.join(", ")}`,
    );
  });
});
