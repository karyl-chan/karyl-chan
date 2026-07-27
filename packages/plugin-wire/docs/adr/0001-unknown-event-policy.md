# Unknown event subscriptions: reject at or below the Event Ceiling, warn above it

A manifest subscribing to an event name the bot doesn't recognize used to register silently and never fire. Now: every Canonical Event records the SDK version that introduced it, and the Event Ceiling is derived as the max of those. If the manifest's `sdk_version` is at or below the ceiling, an unknown event is a typo — registration is **rejected**. If it is above the ceiling, the event may be one this (older) bot build hasn't learned yet — registration succeeds with a **warning** surfaced in the register response and the admin UI health card. A manifest with no `sdk_version` cannot be newer than the ceiling, so it takes the reject path — no permanent leniency lane for legacy manifests.

Chosen over always-reject (would brick a plugin built on a newer SDK against a lagging bot deploy — third-party plugins run outside our deploy cadence) and over always-warn (a warning nobody reads reproduces the silent-typo bug this exists to kill).

## Consequences

- Rollout is two-phase: one bot release runs the full logic warn-only so already-registered plugins with doomed subscriptions surface in the admin UI first; the next release flips a single boolean to reject.
