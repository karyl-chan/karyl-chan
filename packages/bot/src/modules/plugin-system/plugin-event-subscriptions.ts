/**
 * Unknown event-subscription policy at register time (#29 decisions
 * 4 / 6 / 7; ADR
 * `packages/plugin-wire/docs/adr/0001-unknown-event-policy.md`).
 *
 * A manifest can subscribe to any string. Before this, a typo
 * ("guild.voice_state_updates" plural) registered happily and then
 * never fired — no error, no log line, nothing to look at. The wire
 * contract answers "is this name one this build knows, and if not, is
 * that a typo or an event newer than us?" via
 * `classifyEventSubscription`; deciding what to DO with that answer is
 * host policy and lives here, the same way `plugin-sdk-compat.ts` owns
 * the compat verdict the admin UI only renders.
 *
 * ROLLOUT: this release is warn-only. `evaluateEventSubscriptions`
 * always classifies, the register path always reports, and nothing is
 * ever refused because of an unknown event name —
 * `REJECT_UNKNOWN_EVENT_SUBSCRIPTIONS` (below) is the one boolean the
 * next release flips.
 */

import {
  EVENT_CEILING,
  classifyEventSubscription,
} from "@karyl-chan/plugin-wire";
import type { PluginManifest } from "@karyl-chan/plugin-wire";

/**
 * ⚠ THE PHASE FLIP (#29 decision 6) — the single boolean this rollout
 * turns on, and the only line the follow-up release changes.
 *
 *   false (phase 1, this release): unknown subscriptions are classified
 *          and reported — in the register response and on the admin
 *          plugin health card — but registration always proceeds.
 *   true  (phase 2, next release): a subscription classified `reject`
 *          fails the register with a 400 before anything is persisted.
 *
 * Phase 1 exists so plugins ALREADY registered with a doomed
 * subscription surface in the admin UI before the door closes on them.
 * Flip it only once that list has been looked at. Flipping it changes
 * behaviour only: the classification (`UnknownEventSubscription.verdict`)
 * is already the phase-2 answer today.
 *
 * Typed `boolean` rather than left to infer `false` so the phase-2
 * branch at the flip site stays a live, type-checked path.
 */
export const REJECT_UNKNOWN_EVENT_SUBSCRIPTIONS: boolean = false;

/** One manifest subscription this build does not recognize. */
export interface UnknownEventSubscription {
  /** The unrecognized name, verbatim as the manifest declared it. */
  event: string;
  /**
   * Where it was declared — `events_subscribed_global` or
   * `guild_features[<key>].events_subscribed`. A plugin can carry the
   * same typo in several places and each one needs fixing separately.
   */
  source: string;
  /**
   * The wire's classification, unaffected by the rollout phase:
   *  - `reject`: a typo. The manifest's SDK is at or below the Event
   *    Ceiling (or absent), so this build already knows every event
   *    that SDK could emit — the name can't be a newer one.
   *  - `warn`: the manifest's SDK is newer than the ceiling, so the
   *    name may be an event this bot build hasn't learned yet.
   */
  verdict: "warn" | "reject";
  /** Author-facing one-liner: which name, where, and why it is flagged. */
  message: string;
}

/** The bot's verdict on one manifest's event subscriptions. */
export interface EventSubscriptionCheck {
  /** False for the whole warn-only phase — mirrors the flip above. */
  enforced: boolean;
  /**
   *  - `ok`: every declared subscription is a Canonical Event.
   *  - `warn`: at least one isn't, and this build let it through.
   *  - `reject`: at least one isn't and enforcement is on — only
   *    reachable in phase 2, since a rejected register never gets far
   *    enough to return a body.
   */
  status: "ok" | "warn" | "reject";
  /** The Event Ceiling this verdict was measured against. */
  ceiling: string;
  /** `manifest.sdk_version`; null when the manifest declares none. */
  sdkVersion: string | null;
  unknown: UnknownEventSubscription[];
}

function why(
  event: string,
  source: string,
  verdict: "warn" | "reject",
  sdkVersion: string | null,
): string {
  const where = `declared in ${source}`;
  return verdict === "warn"
    ? `Unknown event '${event}' (${where}): the manifest declares SDK ${sdkVersion}, newer than this bot build's Event Ceiling ${EVENT_CEILING}, so it may be an event this build has not learned yet — nothing will be delivered for it until the bot is upgraded.`
    : `Unknown event '${event}' (${where}): this build knows every event up to SDK ${EVENT_CEILING} and the manifest declares ${sdkVersion === null ? "no sdk_version" : `SDK ${sdkVersion}`}, so the name is a typo — nothing will ever be delivered for it.`;
}

function collect(
  names: unknown,
  source: string,
  sdkVersion: string | null,
  into: UnknownEventSubscription[],
): void {
  if (!Array.isArray(names)) return;
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) continue;
    const verdict = classifyEventSubscription(name, sdkVersion);
    if (verdict === "ok") continue;
    // Same name twice in the same place is one problem to fix, not two.
    if (into.some((u) => u.event === name && u.source === source)) continue;
    into.push({
      event: name,
      source,
      verdict,
      message: why(name, source, verdict, sdkVersion),
    });
  }
}

/**
 * Classify every subscription a manifest declares — the global set and
 * each guild feature's. Pure: no bot state, no I/O, no side effects, so
 * the register path and the admin read routes can both call it freely.
 */
export function evaluateEventSubscriptions(
  manifest: PluginManifest,
): EventSubscriptionCheck {
  const sdkVersion =
    typeof manifest.sdk_version === "string" && manifest.sdk_version.length > 0
      ? manifest.sdk_version
      : null;

  const unknown: UnknownEventSubscription[] = [];
  collect(
    manifest.events_subscribed_global,
    "events_subscribed_global",
    sdkVersion,
    unknown,
  );
  // Protocol validation guarantees an array on the register path, but
  // the admin read routes hand us whatever the manifest column holds
  // (including a `{}` placeholder row) — a throw here would 500 the
  // whole plugin list.
  const features = Array.isArray(manifest.guild_features)
    ? manifest.guild_features
    : [];
  for (const feature of features) {
    if (!feature || typeof feature.key !== "string") continue;
    collect(
      feature.events_subscribed,
      `guild_features[${feature.key}].events_subscribed`,
      sdkVersion,
      unknown,
    );
  }

  const status: EventSubscriptionCheck["status"] =
    unknown.length === 0
      ? "ok"
      : REJECT_UNKNOWN_EVENT_SUBSCRIPTIONS &&
          unknown.some((u) => u.verdict === "reject")
        ? "reject"
        : "warn";

  return {
    enforced: REJECT_UNKNOWN_EVENT_SUBSCRIPTIONS,
    status,
    ceiling: EVENT_CEILING,
    sdkVersion,
    unknown,
  };
}

/** Convenience for routes that hold the raw manifestJson column. */
export function evaluateEventSubscriptionsFromManifestJson(
  manifestJson: string,
): EventSubscriptionCheck {
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestJson);
  } catch {
    manifest = null;
  }
  return evaluateEventSubscriptions(
    (manifest && typeof manifest === "object"
      ? manifest
      : {}) as PluginManifest,
  );
}
