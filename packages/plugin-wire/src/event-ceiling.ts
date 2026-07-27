import { CANONICAL_EVENTS, isCanonicalEvent } from "./events.js";
import { compareSemver, maxSemver } from "./semver.js";

/**
 * The Event Ceiling: the newest SDK version whose Canonical Events this
 * build fully knows, derived as the max `introducedIn` across every
 * Canonical Event. There is no hand-maintained ceiling constant — add a
 * newer event to `CANONICAL_EVENTS` and the ceiling rises with it.
 */
export const EVENT_CEILING: string = maxSemver(
  CANONICAL_EVENTS.map((e) => e.introducedIn),
);

/**
 * Verdict for an unknown event-name subscription found in a manifest,
 * given the manifest's declared `sdk_version`.
 *
 *  - `reject`: the subscription is a typo. Either the manifest's
 *    `sdk_version` is at or below the Event Ceiling (this build knows
 *    every event that SDK shipped, so an unrecognized name can't be a
 *    newer event), or the manifest declares no `sdk_version` (it cannot
 *    be newer than the ceiling).
 *  - `warn`: the manifest's `sdk_version` is above the ceiling — the
 *    name may be an event this older bot build hasn't learned yet.
 *    Registration proceeds with a surfaced warning.
 *
 * A recognized event name always yields `ok`. See
 * `packages/plugin-wire/docs/adr/0001-unknown-event-policy.md`.
 */
export function classifyEventSubscription(
  eventName: string,
  manifestSdkVersion: string | null | undefined,
): "ok" | "warn" | "reject" {
  if (isCanonicalEvent(eventName)) return "ok";
  if (!manifestSdkVersion) return "reject";
  return compareSemver(manifestSdkVersion, EVENT_CEILING) > 0
    ? "warn"
    : "reject";
}
