# Permission system

The bot does not implement full RBAC. Permissions split into two
**independent** axes:

- **A. Discord command permission** — for in-guild slash commands, gated
  by Discord's native `defaultMemberPermissions`.
- **B. Capability system** — the bot's unified authorisation layer, used
  by both the built-in admin web panel and plugin-declared capabilities.

The two axes do not overlap. A controls who can use the bot's slash
commands in Discord; B controls who can log into the admin panel and which
admin-panel and plugin areas they can operate.

## A. Discord command permission

Each builtin feature's slash command sets the required Discord permission
bit at the Discord API layer. Members who lack the bit cannot **see** the
command in Discord's UI.

| Command | Required Discord permission |
|---------|-----------------------------|
| `/todo-channel` | `Manage Channels` |
| `/picture-only-channel` | `Manage Channels` |
| `/rcon-forward-channel` | `Manage Channels` |
| `/role-emoji` | `Manage Roles` |
| `/voice` | `Manage Server` |

An admin can override these defaults per guild in **Server Settings →
Integrations** (loosen or tighten the permission for specific roles).
This is a Discord-native mechanism; the bot does not know about it and
does not interfere.

The **RCON trigger** (sending a message starting with the trigger prefix
in a watched channel) has no extra capability check. Any member who can
send messages in the channel can trigger a forward. To restrict access,
adjust the channel's Discord send-message permissions.

> The system behaviors `/login`, `/manual`, and `/break`
> (see [`features/behaviors.md`](features/behaviors.md)) are slash
> commands registered with `contexts: BotDM,PrivateChannel` — they
> appear only in DM contexts and never in guild channels, so guild
> permissions don't apply. `/login` carries its own authorisation
> gate (see [Admin identity](#admin-identity)): bot owners
> (`BOT_OWNER_IDS`) and any `authorized_users` row with at least one
> active capability receive a login link; everyone else gets an
> ephemeral "not authorized" reply.

## B. Capability system

The bot has one capability authorisation system, **completely independent
of the Discord command permissions in section A**. It serves two consumer
types:

- **Bot backend** — the built-in admin web panel and `/api/*` routes.
- **Plugins** — each plugin declares its own capabilities in its
  manifest. With an admin grant, the plugin uses those tokens to gate
  its own RPC and WebUI operations.

Both consumers share the same `admin_role_capabilities` table and the
same matching functions; the only thing that differs is where the
token names come from.

### Admin identity

- A bot owner (any Discord user id listed in `BOT_OWNER_IDS`, or the
  single legacy `BOT_OWNER_ID`) invokes the `/login` slash command in
  DM with the bot to obtain a one-time login link.
- Once logged in, the owner uses the admin management page to authorise
  other Discord users and assign admin roles. Authorised users can
  subsequently `/login` themselves as long as their role still carries
  at least one capability.
- Each admin role holds a set of capability tokens, stored in
  `admin_role_capabilities`.

The default role set ships with a single `admin` role that holds the
`admin` token.

### Token model

The tokens form three concentric layers, plus two extensions:

**1. `admin`** — superuser. Bypasses every check.

**2. Global tokens** (cover the entire bot for their area):

| Token | Description |
|-------|-------------|
| `dm.message` | Read and write DM conversations, messages, unread counts, reactions. |
| `guild.message` | Read and write channel messages and reactions across all guilds. |
| `guild.manage` | Manage members, roles, settings, and bot features across all guilds. |
| `system.read` | View system events and statistics. |
| `behavior.manage` | Manage all behaviors and scope tabs. |

**3. Guild-scoped tokens** restrict the guild range to one guild:
`guild:<guildId>.message`, `guild:<guildId>.manage`. For example, a
role that only holds `guild:123.manage` can manage guild `123` only.

**4. Behavior-scoped tokens** — `behavior:<scopeKey>.manage`. Can CRUD
behaviors under one scope tab, but cannot add or delete the tab itself
(those operations belong to `admin` / `behavior.manage`).

**5. Plugin-scoped tokens** — `plugin:<pluginKey>:<capKey>`. Capabilities
declared by a plugin. They form the full **plugin authorisation loop**:

- The plugin lists its capabilities in its manifest with
  `definePluginCapability({ key, description })`.
- On register, the bot writes the keys into the `plugin_capabilities`
  table and opens a per-plugin tab in the admin role-permission page so
  admins can grant them like any other token.
- The plugin obtains a `plugin-session` JWT (whose `capabilities` claim
  carries the user's granted plugin tokens) via the `auth.session` RPC.
  On the plugin side, the SDK's `hasPluginCapability()` checks the token
  in the plugin's own RPC and WebUI logic.
- When a plugin is removed from the bot, every `plugin:<that key>:*`
  token is cleared from every role.

Example: the `karyl-radio` plugin declares `webui.access` → an admin
grants `plugin:karyl-radio:webui.access` to a role → on receiving a
WebUI request, the plugin checks
`hasPluginCapability(claims.capabilities, 'karyl-radio', 'webui.access')`.

### Matching

"Can the role act on guild X with the `manage` scope?" — yes, if any of
`admin`, `guild.manage`, or `guild:X.manage` is present. Global tokens
cover all guilds; guild-scoped tokens cover only the named guild.

On the bot side, capabilities are enforced at the HTTP route layer by
`web-core/route-guards.ts` (`requireCapability`,
`requireGuildCapability`, and similar guards). On the plugin side,
`plugin:*` tokens are checked by the plugin itself using the SDK's
`hasPluginCapability`.

## Source

| File | Purpose |
|------|---------|
| `src/modules/admin/admin-capabilities.ts` | Capability token definitions, `has*Capability` matchers, `DEFAULT_ROLES`. |
| `src/modules/admin/models/admin-role.model.ts` | Admin role model. |
| `src/modules/admin/models/admin-role-capability.model.ts` | Role ↔ capability token mapping. |
| `src/modules/admin/models/authorized-user.model.ts` | Discord user → admin role. |
| `src/modules/admin/admin-management-routes.ts` | Role and capability management API. |
| `src/modules/web-core/route-guards.ts` | Route-level capability enforcement. |
| `src/modules/plugin-system/models/plugin-capability.model.ts` | Plugin-declared capability persistence. |
| `src/modules/plugin-system/plugin-registry.service.ts` | Upserts `plugin_capabilities` on plugin register. |
| `@karyl-chan/plugin-sdk` (`hasPluginCapability`, `verifyPluginSession`) | Plugin-side reading and matching. |
| `tests/admin-capabilities.test.ts` | Unit tests. |
