# Behaviors

A **behavior** is one trigger bound to one action
([ADR 0003](../adr/0003-behavior-trigger-action-split.md)): when a user
runs one of the bot's commands, or sends a message that matches a
pattern, the bot calls a webhook and shows its answer.

This page is the admin's and operator's view. If you are writing the
service a webhook calls, read the
[behavior webhook protocol](behavior-webhook-protocol.md) instead. The
domain terms (Behavior, Command Leaf, Message Trigger Location, …) are
defined in the bot's [CONTEXT.md](../../CONTEXT.md#behaviors).

## Contents

- [The model](#the-model)
- [Command triggers](#command-triggers)
- [Message triggers](#message-triggers)
- [Behavior Sections](#behavior-sections)
- [The system login](#the-system-login)
- [Webhook actions](#webhook-actions)
- [Who sees the reply](#who-sees-the-reply)
- [Admin UI](#admin-ui)
- [Write API](#write-api)
- [Storage](#storage)
- [Source](#source)

## The model

| Part | What it is |
|------|------------|
| **Trigger** | How the behavior starts. A **command trigger** is one leaf of a Discord command; a **message trigger** matches messages the bot can read. |
| **Action** | What the behavior does. Admins choose a **webhook**. The system login runs a login action of the bot's own, which is not on offer to admins (stored as `actionSource: builtin`). Plugin actions are planned (phase 2), not available yet. |
| **Reply** | The action's answer, shown to the user: text, embeds and link buttons. One reply model serves every trigger. |

A behavior has a title (at most 100 characters), an optional admin note
(at most 1000 characters, never sent to Discord), and an on/off switch.

## Command triggers

A **command** is what Discord registers: a name, a description and the
settings that decide who sees it and where. Each runnable path of the
command is a **command leaf**, and each leaf is one behavior with its own
action:

- a command without subcommands has one leaf, the **root leaf** (`/nas`);
- a command with subcommands has one leaf per subcommand (`/nas wake`,
  `/nas status`), and no root leaf. Discord does not allow both.

Subcommand groups (`/nas power on`) are reserved for later and cannot be
created yet.

### Visibility belongs to Discord

Who sees a command and where it can be used is decided by Discord, from
the command's settings, and by each server's admins (**Server Settings →
Integrations**). The bot does no check of its own when a command runs: if
a user can see it, they can run it. Visibility is set on the command, not
on a leaf, so to offer a subcommand to fewer people, make it a separate
command. A webhook that serves only some users must check
`_meta.user.id` itself.

| Setting | Values |
|---------|--------|
| Name | 1–32 characters of `a-z`, `0-9`, `_`, `-`. |
| Description | 1–100 characters, not blank. |
| Registration target | **Global**, or **one server** (a guild id). |
| Install types | `guild_install` (installed with a server), `user_install` (installed by a user). |
| Contexts | `Guild` (servers), `BotDM` (DMs with the bot), `PrivateChannel` (other DMs and group DMs). |
| Default member permissions | A Discord permission bitfield, or none. It only applies in servers; server admins can override it. |

The bot refuses a command that Discord would refuse, before anything is
stored or sent:

- A one-server command can only be used in that server: contexts exactly
  `[Guild]`, install types exactly `[guild_install]`.
- A global command offered in `PrivateChannel` needs `user_install`:
  Discord shows commands in other DMs only for an app the user installed.
- At most 25 subcommands; at most 25 options per leaf, with unique names
  and required options before optional ones; at most 8000 characters
  across the command's names, descriptions and options.
- The root leaf and subcommands never coexist; one leaf per path.

### Leaves

A leaf has the behavior's title, an optional Discord description (a
subcommand without one shows its title), its options, its webhook action,
its [reply visibility](#who-sees-the-reply), and an on/off switch.
Options are flat values of type `string`, `integer`, `number`,
`boolean`, `user`, `channel`, `role`, `mentionable` or `attachment`.

A disabled leaf is left out of the command registered on Discord, but it
still counts for every rule above, so that turning it back on cannot
break the command. A command with no enabled leaf is removed from
Discord.

**Convert to subcommands** turns a root leaf into the command's first
subcommand: the leaf keeps its id, webhook, secret and statistics, and
further subcommands can then be added.

### Names

All commands share Discord's name space, so a name must be free among the
built-in commands, every plugin command (manifest commands and guild
feature commands) and every behavior command, disabled ones included,
compared without case. A global command conflicts with any command of the
same name; two commands for two different servers may share a name.
`login` is reserved for the [system login](#the-system-login).

### Registration

Saving a command (or one of its leaves) registers it with Discord right
away. The answer reports what happened for each target:

| Status | Meaning |
|--------|---------|
| `registered` | Discord accepted it. |
| `removed` | The command is gone from Discord (deleted, or no enabled leaf left). |
| `deferred` | The bot is not connected to Discord, or the removal could not reach it. The next full sync, which runs each time the bot connects to Discord, applies it. |

When Discord refuses, the bot puts the stored rows back as they were and
answers `502 registration_failed` with Discord's own error. A rename
registers the new name first and only then removes the old one.

**Resync** registers a command again exactly as stored, for example after
someone deleted it on Discord.

## Message triggers

A message trigger matches messages the bot receives. It has a
**location**:

| Location | Matches |
|----------|---------|
| DMs with the bot | Messages users send the bot directly. |
| All servers | Messages in every channel of every server the bot is in. |
| One server | Messages in that server's channels. |
| One channel | Messages in that channel only. A thread has its own channel id, so a channel trigger does not fire in the channel's threads. |

The bot cannot read messages between other users, so there is no message
trigger for other DMs.

| Setting | Rule |
|---------|------|
| Pattern | `startswith`, `endswith` or `regex`, 1–500 characters. A regex is a JavaScript regular expression without flags (so it is case-sensitive) and must compile. `startswith` and `endswith` compare exactly, case included. |
| Audience | DMs with the bot only: **everyone**, **one user** (a user id), or an **audience group**. In servers a trigger always applies to everyone. |
| Skip other bots (`ignoreBots`) | Servers only, on by default: skip messages from other bots and webhooks. The bot's own messages are always skipped, and in DMs messages from bots always are. |
| Stop after a match (`stopOnMatch`) | Off by default. See [matching order](#matching-order). |

An **audience group** is a name with a member list. Triggers that use the
same name share one list. A group exists only while a trigger uses it:
its list can be set only then, and it is deleted with the last trigger
that uses it (the admin UI warns before that happens).

### Matching order

Every message is checked against the message triggers in one order:
the trigger's position (`sortOrder`), then its id. The order spans every
location, because a server message is checked against "all servers", its
server and its channel together. The admin orders the triggers of one
location at a time; this keeps the slots that location's triggers hold in
the overall order.

For one message, several triggers can fire, one after another:

- A trigger with **Stop after a match** stops the walk when it matches
  (also when the rate limit below dropped its request).
- The system login always stops the walk, and is always checked first.

Other limits:

- In servers, each channel fires at most 5 webhook requests per 10
  seconds. Further matches in that window are dropped and noted once in
  the bot event log. DMs are not limited.
- One user's messages are handled one at a time, in order. A slow webhook
  therefore delays that user's next message, but not other users.

## Behavior Sections

The admin UI groups behaviors into three **sections**, derived from each
trigger's settings. A section is not stored and changes nothing about how
a behavior runs.

| Section | Holds |
|---------|-------|
| **App commands** | Global commands usable in more than one context, or installable by users. |
| **DMs with the bot** | Message triggers in DMs with the bot, and global commands usable only there (`BotDM`, `guild_install` only). |
| **Servers** → All servers | Message triggers in all servers, and global commands usable only in servers (`Guild`, `guild_install` only). |
| **Servers** → one server | That server's message triggers and one-server commands. |
| **Servers** → one channel | That channel's message triggers. Discord cannot limit a command to one channel. |

Adding a behavior in a section offers only what the section can hold, and
explains why the rest is not offered. A new command starts with the
visibility of its section (App commands: both install types and every
context; DMs with the bot: `BotDM`; All servers: `Guild`; one server: a
command registered to that server). Changing a command's settings can
move it to another section.

## The system login

The **system login** (the System Behavior) is a fixed behavior that
sends a one-time login link for the admin UI. It is the owner's only way
in, and Karyl-chan is also the login provider for other self-hosted
services, so it is protected against changes that would lock the owner
out.

- It cannot be added, deleted or disabled. Only its trigger can change.
- It is pinned to the top of its section.
- By default (and when it is missing at startup) it is the message
  trigger `!login` (`startswith`) in DMs with the bot.
- Bot owners (`BOT_OWNER_IDS`) and authorised users whose role has at least
  one capability get the link: an embed and a link button, visible only to
  them. On a message trigger, anyone else gets no answer; on a command,
  they are told they are not authorised.
- The admin login page shows the current trigger
  (`GET /api/auth/login-trigger`, public and rate-limited).

### Changing the login's trigger

Only a **bot owner** can change the login's trigger, not every admin
(`PUT /api/behaviors/system/login/trigger`). It is either a message
trigger or a command, never both. Every rule answers one question: after
this save, can the owner still log in?

- **As a message trigger:** DMs with the bot only, because a reply in a
  server channel would show the link to everyone. Audience everyone.
  `startswith` or `endswith` only: a regex could be written never to
  match, and the login page shows the pattern. The pattern cannot be
  blank or start or end with whitespace (Discord trims messages). Each
  change needs a **sample DM** that the pattern must match, checked the
  same way the bot matches messages; the sample is not stored.
- **As a command:** a global command (a server command would disappear if
  the bot left that server), without default member permissions or
  options. Its install types must include `guild_install` and its contexts
  `BotDM`, so that an owner who has not installed the app, or shares no
  server with the bot, still sees it. Other contexts may be added: the
  reply is always visible only to the user who ran it. The name must be
  free (`login` is the login's own).

The new trigger takes effect **before** the old one stops:

- **Message → command:** the command is registered on Discord first. If
  Discord refuses, or the bot is not connected, nothing changes
  (`502 registration_failed`). Only then is the change stored; if storing
  fails, the registration is taken back.
- **Command → message:** the message trigger is stored first, so the new
  pattern works from that moment; then the command is deleted from
  Discord. If that fails, the answer is `deferred`, and the next full
  sync removes it.

Every attempt that reaches the switch is audited as
`behavior.system.trigger` with its outcome (`switched`, `name_conflict`,
`registration_failed` or `store_failed`). A request refused before it (a
malformed body, a stale version, not an owner) is not.
Resyncing the login's command is also owner-only.

## Webhook actions

A webhook action calls a URL with the trigger's data and shows the answer
as the reply. The full contract is in the
[behavior webhook protocol](behavior-webhook-protocol.md).

| Setting | Rule |
|---------|------|
| URL | At most 2048 characters, checked against the [target rules](#webhook-targets) on save and again on every call. |
| Authentication | None, `token` or `hmac` ([protocol](behavior-webhook-protocol.md#authentication)). New behaviors in the admin UI start with `hmac`. |

**Secrets are write-only.** The bot makes the secret when authentication
is turned on and shows it **once**, in that response; reads report only
`secretSet`. Switching between `token` and `hmac` keeps the secret, and
turning authentication off deletes it. **Rotate** makes a new secret and
keeps the old one valid for 24 hours, so a receiver can switch without
downtime ([protocol](behavior-webhook-protocol.md#secret-rotation)). URL and
secret are stored encrypted (AES-256-GCM).

**Test webhook** sends one request to the **saved** action (not to
unsaved edits). It is signed so that it never passes for a real user, and
it carries a placeholder identity, not the admin's. The admin UI previews
the reply: content, embeds, buttons, who would see it on that trigger,
what the reply rules changed, and whether the response signature was
verified. A test does not count in the statistics.

**Statistics:** each behavior records when it last fired, its successes
and failures, its consecutive failures, and its last error. The admin UI
shows them and flags a behavior that keeps failing.

### Webhook targets

The webhook URL is checked by `resolveWebhookTarget`
(`src/utils/host-policy.ts`) both when the behavior is saved and again
on every call (including the test-fire):

| Target resolves to | Allowed? |
|--------------------|----------|
| Public address | Yes, `https://` only. |
| Private address (RFC1918, `100.64.0.0/10`, IPv6 ULA `fc00::/7`) | Only when the hostname or the address is on `WEBHOOK_PRIVATE_ALLOWLIST`; `http://` is accepted for these. |
| Loopback, cloud metadata / link-local (`169.254.0.0/16`, `fe80::/10`, …), unspecified, reserved (`0/8`, `198.18/15`, `224/4`, `240/4`, `fec0::/10`, multicast), NAT64 `64:ff9b::` / 6to4 `2002::` | Never — listing them has no effect. |

`WEBHOOK_PRIVATE_ALLOWLIST` is a comma-separated list of hostnames,
bare IPs and CIDRs (`192.168.2.0/24`, `fd12::/16`). A hostname entry is
an exact, case-insensitive match without the trailing dot — no
wildcards, and `nas.latte.lan.` in the list is read as `nas.latte.lan`
(a webhook URL whose host ends in a dot is rejected anyway). It is an
environment variable (read at boot; a malformed entry stops the bot
from starting) and its current value is shown on the admin **System
settings** page, with the behavior settings. Entries that cannot fully
apply are logged as a warning at boot: a loopback / metadata name, an
IP or range reaching beyond private space (`127.0.0.0/8`, a public IP,
`0.0.0.0/0`), or a private range covering a cloud metadata address
(`100.64.0.0/10` → `100.100.100.200`, `fd00::/8` → `fd00:ec2::254`;
that one address stays refused, the rest applies). A hostname whose DNS
answers include any blocked address is refused as a whole.

Hosts that use fake-IP DNS (Clash, Surge and similar proxies answer
every lookup with an address from `198.18.0.0/15`) cannot reach any
webhook by hostname: the benchmarking range is blocked, so even a public
hostname is refused as `blocked_reserved`. Point such a bot at a real
resolver.

The host is resolved once and the connection is made only to the
addresses that passed the check — all of them, so a dual-stack target
keeps its IPv4 fallback (`src/utils/pinned-dispatcher.ts`: an undici
Agent with a fixed `lookup`; the Host header, TLS SNI and certificate
checks still use the hostname). A DNS answer that changes between check
and connect (DNS rebinding) therefore cannot redirect the request.
Redirects are never followed.

A refusal carries a machine `code` (`private_not_allowlisted`,
`https_required`, `blocked_loopback`, `blocked_metadata`,
`blocked_reserved`, `dns_failed`, …) next to a readable message that
names the target and the setting. The save routes refuse with
`400 validation_failed` on the `webhook.url` field, the code in the
message; the test-fire returns it as `errorCode`.

The legacy `WEBHOOK_ALLOW_PRIVATE=true` switch (allow every private
address) still works for local development and the e2e harness, but is
deprecated; the bot logs a warning at boot when it is on in production.

## Who sees the reply

| Trigger | Default | Can be changed to |
|---------|---------|-------------------|
| Command | Only the user who ran it. | Public in the channel. |
| Message in a DM with the bot | The DM. | — |
| Message in a server channel | Public in the channel. | A DM to the author. |

A command leaf and a server message trigger store a **reply visibility**
(admin UI: 「回覆給誰看」): `private`, `public`, or unset for the default
above. A webhook's answer can still say `ephemeral: true` or `false`,
which wins. So the order is: the answer's `ephemeral`, then the stored
reply visibility, then the trigger's default. It does not apply in DMs
with the bot, nor to the system login, whose reply is always private.

When an action fails, the user gets only a generic "couldn't be completed"
line (a server channel never sees it), and the detail goes to the event
log and the behavior's statistics
([protocol: failures](behavior-webhook-protocol.md#failures)).

## Admin UI

Path: `/admin/behaviors`. Requires the `behavior.manage` capability (or
`admin`); see [`../permissions.md`](../permissions.md). There is no finer
grant: per-section or per-behavior capabilities do not exist.

- The sidebar lists the [sections](#behavior-sections) with their behavior
  counts. **New behavior** adds a command or a message trigger to the
  selected section.
- The system login is pinned to the top of its section. Commands and
  message triggers are listed separately.
- Each card edits a draft. Saving sends only what changed, and refuses
  when the behavior changed on the server since the page loaded; the card
  then shows the conflict. The page warns before leaving with unsaved
  edits.
- Message triggers are reordered by dragging, or with Alt+↑ / Alt+↓, one
  location at a time.
- Forms are checked against the write API's own schemas
  (`GET /api/behaviors/schema`), so the UI and the API agree.

## Write API

All routes need `behavior.manage` (or `admin`); the check runs before the
body is validated. Bodies are validated strictly: an unknown field, a
wrong type or a malformed Discord id (`^\d{17,20}$`) is refused, never
silently dropped.

| Route | Does |
|-------|------|
| `GET /api/behaviors` | `{ system, commands, messageTriggers }`, each with its derived `section`, its statistics and its `updatedAt`. Secrets appear only as `secretSet`. |
| `GET /api/behaviors/schema` | The write routes' JSON schemas. |
| `POST /api/behaviors` | Create a message trigger with its webhook. |
| `PATCH /api/behaviors/:id` | Edit a message trigger or a command leaf. |
| `DELETE /api/behaviors/:id` | Delete a message trigger or a command leaf. |
| `PUT /api/behaviors/reorder` | `{ location, ids }`: the full new order of one location's message triggers (`bot_dm`, `guild:all`, `guild:<id>`, `channel:<guildId>:<channelId>`). |
| `POST /api/behaviors/:id/test` | Test-fire the saved webhook action. |
| `POST /api/behaviors/:id/webhook-secret/rotate` | New secret, shown once; the old one stays valid for 24 hours. |
| `POST /api/behavior-commands` | Create a command with its leaves. |
| `PATCH /api/behavior-commands/:id` | Edit a command's name, description or visibility. |
| `DELETE /api/behavior-commands/:id` | Delete a command and its leaves. |
| `POST /api/behavior-commands/:id/leaves` | Add a subcommand leaf. |
| `POST /api/behavior-commands/:id/convert-to-subcommands` | Turn the root leaf into the first subcommand. |
| `POST /api/behavior-commands/:id/resync` | Register the command again as stored (the login's: owner only). |
| `PUT /api/behaviors/system/login/trigger` | Change the system login's trigger (owner only). |
| `GET` / `PUT /api/behavior-groups/:groupName/members` | Read or replace an audience group's members (at most 1000). |

- **Errors** have one shape, `{ error: { code, message, field?, details? } }`,
  with `code` one of `validation_failed` (400), `not_found` (404),
  `name_conflict`, `invalid_tree`, `system_immutable` (409) and
  `registration_failed` (502). `details` comes with
  `registration_failed`: what each registration target reported.
- **Stale edits:** a `PATCH` may carry `ifUpdatedAt` (the `updatedAt` it
  was based on); a behavior changed since is refused with
  `409 validation_failed`. A reorder whose `ids` are not exactly the
  location's current triggers is refused the same way.
- **The system login** refuses every other write
  (`409 system_immutable`). Only its trigger switch and, for a bot owner,
  a resync of its command go through.
- **Writes are serialised** (one lock per process; on Postgres also an
  advisory lock) and run in one transaction.
- **Audit:** every write is recorded in `admin_audit_log`
  (`behavior.create`, `behavior.update`, `behavior.delete`,
  `behavior.reorder`, `behavior.webhook_secret.rotate`,
  `behavior.command.create` / `update` / `delete` / `convert` / `resync`,
  `behavior.group_members.replace`, `behavior.system.trigger`), never with
  a secret or a webhook URL (a short URL fingerprint instead).
- **Secrets** generated by a write come back once, as `secret` (a command
  create returns one per leaf).

## Storage

| Table | Purpose |
|-------|---------|
| `behavior_commands` | A command: name, description, registration target, install types, contexts, default member permissions, `isSystem` (the login's command). |
| `behavior_definitions` | A behavior: title, note, on/off, position, its trigger (command leaf or message trigger fields), action source (`webhook`, or `builtin` for the system login, keyed by `systemKey`) and reply visibility. |
| `behavior_webhook_actions` | A behavior's webhook: URL and secret (encrypted), auth mode, the previous secret and its expiry during a rotation. |
| `behavior_group_members` | Audience group members, by group name. |
| `behavior_stats` | Per-behavior statistics. |

The runtime reads all of this from an in-memory snapshot, rebuilt after
every write (and at most 30 seconds old for writes from another process).
Schema changes and the 2.0 upgrade are in
[operations.md](../operations.md#upgrades).

## Source

| File | Purpose |
|------|---------|
| `src/modules/behavior/models/` | The five tables. |
| `src/modules/behavior/behavior-catalog.ts` | The in-memory snapshot the runtime reads. |
| `src/modules/behavior/behavior-section.ts` | The section rule. |
| `src/modules/behavior/behavior-routes.ts` | Mounts every route; list, schema, test-fire, group members. |
| `src/modules/behavior/behavior-write-routes.ts`, `message-trigger-rules.ts` | Message trigger writes and their rules. |
| `src/modules/behavior/behavior-command-routes.ts`, `command-leaf-writes.ts`, `command-tree-rules.ts`, `command-registration-sync.ts` | Command writes, Discord's rules, registration. |
| `src/modules/behavior/message-trigger-reorder.ts` | Reorder. |
| `src/modules/behavior/webhook-action-input.ts`, `webhook-secret-rotate.ts` | Webhook intake and rotation. |
| `src/modules/behavior/system-seed.service.ts`, `system-login-trigger.ts`, `system-login-trigger-route.ts`, `login-trigger-hint-route.ts` | The system login. |
| `src/modules/behavior/behavior-trigger.ts` | Pattern matching. |
| `src/modules/command-system/interaction-dispatcher.service.ts` | Runs command triggers. |
| `src/modules/command-system/message-trigger-matcher.service.ts` | Runs message triggers. |
| `src/modules/command-system/webhook-action.ts`, `webhook-forwarder.service.ts` | Calls the webhook, signs and verifies. |
| `src/modules/command-system/behavior-reply.ts`, `reply-renderer.ts` | The reply model and its delivery. |
| `src/modules/command-system/reconcile.service.ts` | Registers commands with Discord. |
| `frontend/src/views/admin/behaviors/` | Admin UI. |
