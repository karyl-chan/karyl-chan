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

**Compat Floor**:
The oldest SDK version the bot commits to interoperating with. The cross-version contract test proves the floor version still interops — the floor and the test always point at the same version.
_Avoid_: minimum SDK version (as a loose phrase; the floor is a single named constant, not a vibe)
