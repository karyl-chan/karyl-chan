# Plugin Wire

The bot↔plugin wire contract: the single home for what travels between the bot and any plugin, and what counts as valid. Admin API shapes (bot↔frontend) are explicitly out of scope.

## Language

**Wire Contract**:
The full agreement governing bot↔plugin traffic: manifest shape, Canonical Events, scope vocabulary, dispatch payload shapes, and the validity rules for each. Owned in exactly one place; both sides import it, neither redeclares it.
_Avoid_: SDK types, shared types (the contract includes rules and fixtures, not just types)

**Canonical Event**:
An event name the Wire Contract recognizes. The set only ever grows, and every entry records the SDK version that introduced it.
_Avoid_: event type (free-form strings are precisely what this term exists to rule out)

**Event Ceiling**:
The newest SDK version whose Canonical Events a given bot build fully knows. An unrecognized subscription from at or below the ceiling is a typo; one from above it may be an event this bot hasn't learned yet.

**Protocol Rule**:
A validity rule answerable from the wire document alone — shape, closed vocabularies, Discord's own constraints. Owned here and run by both sides: the bot at register, the SDK's `buildManifest` at build, so an author sees the same message either way. A rule needing bot state is not one: whether `plugin.url` names a target the bot may reach is the operator's host policy (DNS, allowlist), unanswerable from the author's machine, and stays bot-side.
_Avoid_: validation (unqualified — it hides which side owns the rule)

**Contract Fixture**:
A literal both sides of the wire must agree on — a golden HMAC hex, a stream key, an RPC path, a register response field, a dispatch payload field list. Lives here as one typed module (`CONTRACT_FIXTURES`) that every contract test imports; the bot's suite REPLAYS each literal through its real routes and dispatch services rather than grepping its own source for it.
_Avoid_: test data (fixtures are the contract's assertions, not scaffolding for one test), snapshot (nothing here is generated from current behaviour)

**Compat Floor**:
The oldest SDK version the bot commits to interoperating with. The cross-version contract test proves the floor version still interops — the floor and the test always point at the same version.
_Avoid_: minimum SDK version (as a loose phrase; the floor is a single named constant, not a vibe)
