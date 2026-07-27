import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Events,
  CANONICAL_EVENTS,
  EVENT_CEILING,
  classifyEventSubscription,
  compareSemver,
  isCanonicalEvent,
  maxSemver,
} from "../src/index.js";

test("every Events value has exactly one CANONICAL_EVENTS row", () => {
  const names = Object.values(Events);
  const rows = CANONICAL_EVENTS.map((e) => e.name);
  assert.equal(rows.length, names.length);
  for (const name of names) {
    assert.equal(
      CANONICAL_EVENTS.filter((e) => e.name === name).length,
      1,
      `expected one ledger row for ${name}`,
    );
  }
});

test("every introducedIn is a valid semver and not above the ceiling", () => {
  for (const { name, introducedIn } of CANONICAL_EVENTS) {
    assert.match(introducedIn, /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/, name);
    assert.ok(
      compareSemver(introducedIn, EVENT_CEILING) <= 0,
      `${name} introducedIn ${introducedIn} exceeds ceiling ${EVENT_CEILING}`,
    );
  }
});

test("EVENT_CEILING is the max introducedIn", () => {
  assert.equal(
    EVENT_CEILING,
    maxSemver(CANONICAL_EVENTS.map((e) => e.introducedIn)),
  );
  assert.equal(EVENT_CEILING, "0.11.1");
});

test("isCanonicalEvent recognizes declared names, rejects typos", () => {
  assert.ok(isCanonicalEvent("guild.message_create"));
  assert.ok(isCanonicalEvent(Events.GuildVoiceStateUpdate));
  assert.ok(!isCanonicalEvent("guild.voice_state_updates")); // plural typo
  assert.ok(!isCanonicalEvent(""));
});

test("classifyEventSubscription: known name is always ok", () => {
  assert.equal(classifyEventSubscription("guild.message_create", null), "ok");
  assert.equal(
    classifyEventSubscription("guild.message_create", "0.9.0"),
    "ok",
  );
});

test("classifyEventSubscription: unknown name at/below ceiling rejects", () => {
  assert.equal(classifyEventSubscription("guild.bogus", EVENT_CEILING), "reject");
  assert.equal(classifyEventSubscription("guild.bogus", "0.9.0"), "reject");
});

test("classifyEventSubscription: unknown name above ceiling warns", () => {
  assert.equal(classifyEventSubscription("guild.future_event", "0.12.0"), "warn");
});

test("classifyEventSubscription: legacy manifest (no sdk_version) rejects", () => {
  assert.equal(classifyEventSubscription("guild.bogus", null), "reject");
  assert.equal(classifyEventSubscription("guild.bogus", undefined), "reject");
});

test("compareSemver orders core and prerelease per spec", () => {
  assert.ok(compareSemver("0.11.1", "0.9.0") > 0);
  assert.ok(compareSemver("0.9.0", "0.11.1") < 0);
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
  // prerelease ranks below its release
  assert.ok(compareSemver("1.0.0-rc.1", "1.0.0") < 0);
  assert.ok(compareSemver("1.0.0-rc.1", "1.0.0-rc.2") < 0);
  assert.ok(compareSemver("1.0.0-alpha", "1.0.0-alpha.1") < 0);
});
