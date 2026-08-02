import { test } from "node:test";
import assert from "node:assert/strict";

import { COMPAT_FLOOR, EVENT_CEILING, compareSemver } from "../src/index.js";

test("COMPAT_FLOOR is a valid release version (never a prerelease)", () => {
  // A prerelease floor would make `evaluateSdkCompat` accept builds of an
  // SDK that was never published, so the floor is always an `x.y.z`.
  assert.match(COMPAT_FLOOR, /^\d+\.\d+\.\d+$/);
});

test("COMPAT_FLOOR pins the current floor", () => {
  // Mirrors the EVENT_CEILING pin: a floor bump is a deliberate act that
  // must also move the `plugin-sdk-prev` alias (see the cross-version
  // contract test in plugin-sdk), so it has to touch this line too.
  assert.equal(COMPAT_FLOOR, "0.10.0");
});

test("COMPAT_FLOOR is not above the EVENT_CEILING", () => {
  // A canary for the unknown-event policy, not a law of the wire — a
  // floor above the ceiling is a coherent state (it just means no new
  // Canonical Event has shipped since the floor moved), but it silently
  // disables half the policy: every manifest the bot still accepts
  // declares `sdk_version >= floor > ceiling`, so
  // `classifyEventSubscription` can only ever return "warn" and the
  // reject path is dead code.
  //
  // If this fires, the fix is NOT to lower the floor. Re-read
  // docs/adr/0001-unknown-event-policy.md and decide whether the ceiling
  // should still be derived from `introducedIn` alone.
  assert.ok(
    compareSemver(COMPAT_FLOOR, EVENT_CEILING) <= 0,
    `COMPAT_FLOOR ${COMPAT_FLOOR} is above EVENT_CEILING ${EVENT_CEILING}: ` +
      `every accepted manifest now outranks the ceiling, so no unknown ` +
      `event subscription can ever be rejected. See ` +
      `packages/plugin-wire/docs/adr/0001-unknown-event-policy.md`,
  );
});
