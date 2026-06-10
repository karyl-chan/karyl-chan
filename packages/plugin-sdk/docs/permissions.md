# Permissions

A plugin has **two** independent permission surfaces. Don't conflate them:

| | RPC scopes | RBAC capabilities |
|---|---|---|
| **Question** | What can the *plugin* call on the bot? | What can a *Discord user* do in the plugin? |
| **Declared as** | `rpcMethodsUsed: [...]` | `capabilities: [{ key, description }]` |
| **Enforced by** | the plugin's bot **token** (scopes) | the plugin-session **JWT** (capability claims) |
| **Granted by** | admin approves scopes | admin grants `plugin:<key>:<cap>` to roles |

---

## RPC scopes — "what the plugin can call"

`rpcMethodsUsed` lists the `/api/plugin/*` methods the plugin calls on the
bot (`ctx.discord.*`, `ctx.voice.*`, `ctx.kv.*`, …). Most entries are
auto-derived from what you declare (see the main README's
[Auto-derived `rpcMethodsUsed`](../README.md#auto-derived-rpcmethodsused));
add the rest explicitly.

### Requested vs approved

The manifest's `rpcMethodsUsed` are *requested* scopes. The bot mints the
plugin's token with only the **approved** subset, so a call to an
`/api/plugin/*` method that isn't both declared **and** approved fails:

```
403  plugin token missing scope '<name>'
```

Whether requested scopes are auto-approved is a bot-side setting,
`PLUGIN_AUTO_APPROVE`:

- **`true` (default).** Self-host / dev. Every requested scope is approved
  on registration — the historical "declare = grant" behaviour. Zero
  friction for a bot you run yourself.
- **`false`.** Public / multi-tenant. Newly-requested scopes stay
  **pending** until an admin approves them. The token carries only the
  already-approved subset meanwhile; the plugin still registers and runs,
  but unapproved scoped calls 403.

### Admin approval

With auto-approve off, an admin reviews scopes in the bot UI:
**Plugins → (your plugin) → Security → RPC Scopes**. Each requested scope
has a checkbox; unapproved ones show a *pending* badge. **Approve all** or
pick a subset, then **Save**.

Properties worth knowing as a plugin author:

- **Approval is immediate.** The bot updates the live token's scope set in
  place — no re-register or restart needed for the new scope to start
  working.
- **Admins can only approve what you declared.** The approved set is
  clamped to `rpcMethodsUsed`; an admin can't grant a scope your manifest
  never asked for.
- **Approval is sticky across re-register.** On re-register, already-
  approved scopes stay approved; scopes you *removed* from `rpcMethodsUsed`
  are pruned; scopes you *added* come in as pending.

### Practical guidance

- Request the **narrowest** set that works. Adding a scope later is a
  normal, safe operation (it just needs re-approval under auto-approve
  off).
- Don't assume a scope is granted at startup on a hardened deployment.
  Handle a `BotRpcError` with a missing-scope reason gracefully rather than
  crashing — the admin may not have approved it yet.

---

## RBAC capabilities — "what a user can do in the plugin"

Use this when your plugin has a WebUI or a privileged action that only
certain Discord users should reach.

Declare capabilities in the manifest:

```ts
definePlugin({
  // ...
  capabilities: [
    { key: "webui.access", description: "Open the plugin's web UI" },
  ],
});
```

The bot persists these and exposes a per-plugin tab in the admin
**role-permissions** modal, where an admin grants `plugin:<key>:webui.access`
to roles. When the plugin is removed, the grants are swept from every role.

At runtime the plugin mints a plugin-session JWT (the `auth.session` RPC /
`ctx.auth`) for a user; the JWT carries that user's `plugin:*` + `admin`
capability subset. Verify it offline:

```ts
import { verifyPluginSession, hasPluginCapability } from "@karyl-chan/plugin-sdk";

const claims = verifyPluginSession(token, publicKey);
if (!claims || !hasPluginCapability(claims, "webui.access")) {
  // 403
}
```

See the main README's [WebUI authentication](../README.md#webui-authentication)
for the full token-minting + verification flow.
