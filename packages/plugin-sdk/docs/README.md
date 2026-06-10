# Plugin SDK docs

Guides for building a karyl-chan plugin with `@karyl-chan/plugin-sdk`.
These complement the API-reference-style [`../README.md`](../README.md)
(quick start, `PluginContext` / `CommandContext` reference, typed RPC,
storage, events, WebUI auth, protocol alignment, backwards-compatibility
commitment).

| Guide | What it covers |
|-------|----------------|
| [getting-started.md](getting-started.md) | Scaffold a plugin with `create-karyl-plugin` and get your first command live in ~10 minutes. |
| [plugin-lifecycle.md](plugin-lifecycle.md) | The runtime state machine — start → register → heartbeat → command sync → enable/disable → crash / restart / deregister — with a diagram. |
| [permissions.md](permissions.md) | RPC scopes (requested vs admin-approved) and RBAC capabilities — the plugin trust boundary. |
| [self-host-deployment.md](self-host-deployment.md) | Running your plugin against your own self-hosted bot — official image, compose template, setup-secret flow, register→enable journey, readiness semantics, troubleshooting. |

For the **compatibility policy** (what's stable, what may evolve, the
pre-1.0 lockstep rule), see the main README's
[Backwards-compatibility commitment](../README.md#backwards-compatibility-commitment)
and [Protocol alignment](../README.md#protocol-alignment) sections.
