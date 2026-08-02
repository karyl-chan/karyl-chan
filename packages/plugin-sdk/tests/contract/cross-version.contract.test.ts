/**
 * PM-6 — SDK cross-version wire compatibility (current × Compat Floor).
 *
 * The SDK and bot ship as separate packages on independent release
 * cadences, so a plugin built on one SDK minor will, in the wild, talk to
 * a bot (or be talked to) across a version skew. This locks the parts of
 * the wire contract that MUST stay byte-identical across that skew, by
 * comparing the current source against the published SDK release at the
 * Compat Floor (aliased `@karyl-chan/plugin-sdk-prev`).
 *
 * The comparison target is the Compat Floor, NOT "the previous minor"
 * (issue #29 decision 9): the floor is the oldest SDK the bot promises to
 * interoperate with, so the floor is exactly the version this test has to
 * prove still interops. The alias pin and `COMPAT_FLOOR` are therefore one
 * coordinate — the first test below fails if they drift apart, which is
 * what makes "floor bump ⇒ pin bump, same PR" enforceable rather than
 * remembered.
 *
 * Scope: the SDK×SDK cells of the PM-6 matrix. The bot×SDK cell
 * (old bot × new SDK) needs an old bot artifact and stays deferred — see
 * PLATFORM_MATURITY_PLAN PM-6.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMPAT_FLOOR } from "@karyl-chan/plugin-wire";
import * as prev from "@karyl-chan/plugin-sdk-prev";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
} from "../../src/hmac.js";
import { DLQ_SUFFIX } from "../../src/streams-protocol.js";
import { Events } from "../../src/index.js";

const prevSdk = prev as Record<string, unknown>;

const PREV_ALIAS = "@karyl-chan/plugin-sdk-prev";

/**
 * This package's own package.json. The compiled test runs from
 * `<pkg>/dist-test/tests/contract/`, so walk up until a package.json
 * that actually names this package turns up — same shape as the fixture
 * lookup in `sdk-contract.test.ts`, and resilient to the compiled depth.
 */
function loadSdkPackageJson(): { devDependencies?: Record<string, string> } {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(
        readFileSync(resolve(dir, "package.json"), "utf8"),
      ) as { name?: string; devDependencies?: Record<string, string> };
      if (pkg.name === "@karyl-chan/plugin-sdk") return pkg;
    } catch {
      // Not here (or not readable) — keep walking up.
    }
    dir = resolve(dir, "..");
  }
  throw new Error(
    "could not locate plugin-sdk/package.json from " + import.meta.url,
  );
}

describe(`contract: SDK cross-version (current × Compat Floor ${COMPAT_FLOOR})`, () => {
  // The guard that keeps this whole test honest. Everything below compares
  // the current source against whatever `plugin-sdk-prev` resolves to; if
  // that pin lags a floor bump, the suite goes on passing while proving
  // compatibility with a version nobody promised any more.
  it(`the ${PREV_ALIAS} pin tracks COMPAT_FLOOR`, () => {
    const spec = loadSdkPackageJson().devDependencies?.[PREV_ALIAS];
    assert.equal(
      spec,
      `npm:@karyl-chan/plugin-sdk@${COMPAT_FLOOR}`,
      `${PREV_ALIAS} is pinned to ${spec ?? "(missing)"} but the Compat Floor ` +
        `is ${COMPAT_FLOOR} — a floor bump must move the pin in the same PR, ` +
        `or this suite proves interop with a version the bot no longer supports`,
    );
  });

  // HMAC dispatch headers are the auth handshake between bot and plugin.
  // If a header name drifts across an SDK minor, a plugin on one version
  // signs under a name the other never reads → every dispatch 401s. These
  // must be IDENTICAL across versions, full stop. (REPLAY_WINDOW_SECONDS
  // and PLUGIN_STREAM_PREFIX are 0.11 additions absent from the floor
  // version's export surface, so they aren't cross-comparable here.)
  const STABLE: [name: string, current: unknown, previous: unknown][] = [
    ["SIGNATURE_HEADER", SIGNATURE_HEADER, prevSdk.SIGNATURE_HEADER],
    ["TIMESTAMP_HEADER", TIMESTAMP_HEADER, prevSdk.TIMESTAMP_HEADER],
    ["NONCE_HEADER", NONCE_HEADER, prevSdk.NONCE_HEADER],
    ["DLQ_SUFFIX", DLQ_SUFFIX, prevSdk.DLQ_SUFFIX],
  ];
  for (const [name, current, previous] of STABLE) {
    it(`${name} is byte-identical to ${COMPAT_FLOOR}`, () => {
      assert.equal(
        previous,
        current,
        `${name} drifted since ${COMPAT_FLOOR} — a version-skewed plugin/bot pair can no longer authenticate`,
      );
    });
  }

  // Canonical events may only GROW across versions (additive). Every event
  // a floor-version plugin subscribes to must still be one the current bot
  // emits, or that plugin silently stops receiving it after a bot upgrade.
  // (New events the current SDK adds are fine — old plugins just don't
  // use them.)
  it(`every ${COMPAT_FLOOR} canonical event still exists in the current set (no removals)`, () => {
    const current = new Set<string>(Object.values(Events));
    const previous = Object.values(
      (prevSdk.Events ?? {}) as Record<string, string>,
    );
    assert.ok(
      previous.length > 0,
      `${COMPAT_FLOOR} should export a non-empty Events set`,
    );
    const removed = previous.filter((e) => !current.has(e));
    assert.deepEqual(
      removed,
      [],
      `events removed since ${COMPAT_FLOOR} break old plugins: ${removed.join(", ")}`,
    );
  });
});
