# Bot / Runtime

The Discord bot host: runs the gateway connection, serves the admin UI, and operates the plugin system (registration, dispatch, feature gating, RPC).

## Language

**Feature Reach**:
Whether a plugin's declared guild feature is effectively enabled in a specific guild — the answer that gates event dispatch, RPC calls, and interaction delivery.
_Avoid_: feature gate check, guild feature check (as loose synonyms)

**Precedence Tiers**:
The fixed 3-tier resolution order for Feature Reach: per-guild row → operator default → manifest default. There is exactly one implementation of this rule, inside the Feature Reach module.
_Avoid_: fallback chain, cascade

**Guild Override**:
An explicit per-guild row for a feature, placing it above both defaults in the Precedence Tiers. A feature with no Guild Override follows its resolved default.
_Avoid_: guild row (in user-facing prose), custom setting

**Operator Default**:
The "All Servers" default an operator sets for a feature, sitting between Guild Override and Manifest Default in the Precedence Tiers.
_Avoid_: global default

**Manifest Default**:
The `enabled_by_default` value a plugin's manifest declares for a feature — the bottom of the Precedence Tiers.

**Plugin Dispatch**:
The act of safely delivering one payload to one plugin: liveness check, Feature Reach, signing, delivery, health recording — one shared path regardless of what triggered it.
_Avoid_: forward, post to plugin (as loose synonyms)

**Dispatch Kind**:
The variety of a Plugin Dispatch (command, autocomplete, component, modal, lifecycle, event). A kind determines the payload shape, the endpoint, and which reach policy applies.
_Avoid_: dispatch type, channel

**Dispatch Transport**:
The channel a Plugin Dispatch travels over (direct HTTP, pooled HTTP, event bus). The transport determines which pre-delivery steps apply — e.g. SSRF preflight and signing exist only for outbound HTTP.
_Avoid_: delivery mode, backend

**Plugin Change**:
A notification that a plugin's effective state changed (registration, enable/disable, deregistration, or a feature write for one guild). Emitted by the module that owns the mutation; caches subscribe and invalidate themselves.
_Avoid_: cache invalidation call (that's a subscriber's private reaction, not the event)
