# Plugin dispatch collapses into one deep module; transport is an injected adapter

Five services (interaction, component, modal, lifecycle, event bridge) each re-implemented the delivery half of Plugin Dispatch — liveness, reach, endpoint, SSRF preflight, signing, fetch, health. We collapsed the shared trunk into one module (`createPluginDispatcher(deps)` factory) with per-kind thin services on top, under a strict zero-behavior-change rule: transport unification and gate additions are separate future issues.

## Decisions worth remembering

- **Transport is an injected adapter, not unified.** The event bridge keeps `PluginDispatchPool` (breaker, shedding, keep-alive); the four interaction/lifecycle kinds keep plain `fetch`. Putting interactions on the pool would make breaker short-circuits user-visible — a behavior change deliberately excluded here.
- **The Discord side stays out.** Defer/ack modes, payload assembly, response translation, and error surfaces are the ~120 lines that genuinely differ per kind; forcing them into the shared interface would turn it into config soup. The module never imports discord.js.
- **Reach is a per-kind three-state policy** (`any-feature` / `per-scope` / `none`). Command/autocomplete is `none` on purpose: feature-keyed commands are gated at *registration time* (`plugin-command-registry.service.ts` registers a command in a guild iff the feature resolves on via the Precedence Tiers), so a disabled feature's command is not visible to invoke. The toggle-to-deregister race window is a known, accepted gap.
- **The event bus is a transport inside the module**, not a bypass in front of it. Liveness and reach run once for both branches; SSRF preflight and signing are HTTP-only steps and legitimately do not apply to the bus — that skip is domain shape, not a hole.
- **`readBody` is a per-kind flag** because only autocomplete consumes the response body; the command path deliberately does not (plugins reply via the `interactions.respond` RPC).
- **Tests inject fakes through the factory**; the module-poking hatches it absorbs (`__getDispatchPoolForTests`, `__resetEventBusForTests`, `__snapshotEventIndexForTests`) are deleted. Neighboring modules' hatches are out of scope.

## Rejected alternatives

- Moving all five kinds onto the pooled transport now (behavior change; deserves its own issue and tests).
- Leaving the event bridge out entirely (liveness/reach fixes would still land twice).
- A dispatch-time reach re-check for commands (double-gating what registration already gates; the race-window question is recorded on issue #28 for future discussion).
