# Plugin dispatch collapses into one deep module; transport is an injected adapter

Five services (interaction, component, modal, lifecycle, event bridge) each re-implemented the delivery half of Plugin Dispatch — liveness, reach, endpoint, SSRF preflight, signing, fetch, health. We collapsed the shared trunk into one module (`createPluginDispatcher(deps)` factory) with per-kind thin services on top, under a strict zero-behavior-change rule: transport unification and gate additions are separate future issues.

## Decisions worth remembering

- **Transport is an injected adapter, not unified.** The event bridge keeps `PluginDispatchPool` (breaker, shedding, keep-alive); the four interaction/lifecycle kinds keep plain `fetch`. Putting interactions on the pool would make breaker short-circuits user-visible — a behavior change deliberately excluded here.
- **The Discord side stays out.** Defer/ack modes, payload assembly, response translation, and error surfaces are the ~120 lines that genuinely differ per kind; forcing them into the shared interface would turn it into config soup. The module never imports discord.js.
- **Reach is a per-kind three-state policy** (`guild-reach` / `per-scope` / `none`; `guild-reach` was `any-feature` until #129 — see the addendum below). Command/autocomplete is `none` on purpose: feature-keyed commands are gated at *registration time* (`plugin-command-registry.service.ts` registers a command in a guild iff the feature resolves on via the Precedence Tiers), so a disabled feature's command is not visible to invoke. The toggle-to-deregister race window is a known, accepted gap.
- **The event bus is a transport inside the module**, not a bypass in front of it. Liveness and reach run once for both branches; SSRF preflight and signing are HTTP-only steps and legitimately do not apply to the bus — that skip is domain shape, not a hole.
- **`readBody` is a per-kind flag** because only autocomplete consumes the response body; the command path deliberately does not (plugins reply via the `interactions.respond` RPC).
- **Tests inject fakes through the factory**; the module-poking hatches it absorbs (`__getDispatchPoolForTests`, `__resetEventBusForTests`, `__snapshotEventIndexForTests`) are deleted. Neighboring modules' hatches are out of scope.

## Rejected alternatives

- Moving all five kinds onto the pooled transport now (behavior change; deserves its own issue and tests).
- Leaving the event bridge out entirely (liveness/reach fixes would still land twice).
- A dispatch-time reach re-check for commands (double-gating what registration already gates; the race-window question is recorded on issue #28 for future discussion).

## Addendum (2026-11, #129): component/modal reach is Guild Reach

Owner ruling on #129: a track-3 command's follow-ups (buttons, modals, replies into the guild) are authorized by the command being usable, not by features. The component/modal policy `any-feature` became `guild-reach`: Feature Reach for any declared feature, **or** Command Reach — the plugin has a track-3 command registered where the guild can invoke it (`plugin-guild-reach.ts`). Guild-targeted RPC uses the same rule. Event `per-scope` reach and command `none` are unchanged.

The unit is the whole plugin (owner ruling, 2026-11-07), because neither a `kc:` custom_id nor an RPC call carries the command it came from. Accepted trade-off: for a mixed plugin — Track 1 guild features plus a usable track-3 command — the feature toggles stop fencing it off from a guild. Its old Track 1 buttons dispatch again in a feature-off guild, and its background RPC (proactive `messages.send`, `members.get`, …) reaches that guild too. A plugin without track-3 commands keeps plain Feature Reach.

Considered and rejected: attributing follow-ups by message (record the message ids a track-3 interaction produced and pass only clicks on those). It is narrower but needs a new store, and replies to the command itself already bypass reach through `interactions.respond` / `followup`.

Command Reach is per guild: one of the plugin's track-3 commands must be live by the reconciler's own decision (`trackThreeRowState`, the one copy `PluginCommandSource` also uses) **and** be in the reconciler's roster (`reconciler_owned_commands`) at a target this guild can invoke — its guild copy, or the global command with the Guild context. A command Discord rejected, or one not yet reconciled into the guild, grants nothing. The two reads are uncached and run only after Feature Reach said no.
