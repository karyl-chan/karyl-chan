# Behaviors

A **behavior** is one trigger bound to one action
([ADR 0003](../adr/0003-behavior-trigger-action-split.md)): when a user
runs one of the bot's commands, or sends a message that matches a
pattern, the bot calls a webhook and shows its answer — or hands the run
to an action an installed plugin declares.

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
- [Converting a trigger](#converting-a-trigger)
- [The system login](#the-system-login)
- [Webhook actions](#webhook-actions)
- [Plugin actions](#plugin-actions)
- [Who sees the reply](#who-sees-the-reply)
- [Admin UI](#admin-ui)
- [Write API](#write-api)
- [Storage](#storage)
- [Source](#source)

## The model

| Part | What it is |
|------|------------|
| **Trigger** | How the behavior starts. A **command trigger** is one leaf of a Discord command; a **message trigger** matches messages the bot can read. |
| **Action** | What the behavior does. Admins choose a **webhook** or a **[plugin action](#plugin-actions)** — one an installed plugin declares in its manifest. The system login runs a login action of the bot's own, which is not on offer to admins (stored as `actionSource: builtin`). |
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

### Rate limit

One user runs command webhook actions at most 5 times per 10 seconds,
across every command. Past that, the invocation is answered privately
with "You're using this too often" (in the user's language), not
forwarded and not counted; the drop is noted once per window in the bot
event log. The system login is never limited.

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
| Pattern | `startswith`, `endswith` or `regex`, 1–500 characters. A regex is a JavaScript regular expression without flags (so it is case-sensitive), run on V8's linear-time engine: it must compile there, so backreferences, lookahead and large repeat counts are refused (see [regex triggers](#regex-triggers)). `startswith` and `endswith` compare exactly, case included. |
| Audience | DMs with the bot only: **everyone**, **one user** (a user id), or an **audience group**. In servers a trigger always applies to everyone. |
| Skip other bots (`ignoreBots`) | Servers only, on by default: skip messages from other bots and webhooks. The bot's own messages are always skipped, and in DMs messages from bots always are. |
| Stop after a match (`stopOnMatch`) | Off by default. See [matching order](#matching-order). |

An **audience group** is a name with a member list. Triggers that use the
same name share one list. A group exists only while a trigger uses it:
its list can be set only then, and it is deleted with the last trigger
that uses it (the admin UI warns before that happens).

### Regex triggers

A regex is written by an admin but runs on messages anyone sends, so a
pattern that backtracks (`(a+)+$`) plus one crafted message could stall
the whole bot, the login included. The bot therefore runs regexes on
V8's non-backtracking engine (the `l` flag, turned on at startup), where
matching takes time linear in the message, whatever the pattern.

That engine cannot run every regex. Saving one it cannot run is refused
(`validation_failed` on `patternValue`, with the reason). On the bot's
Docker image (Node 22, V8 12.4):

| Syntax | Example | Linear engine |
|--------|---------|---------------|
| Groups, named groups, optional groups, classes, `\b`, lazy quantifiers | `^天氣\s+(.+)`, `^!(\w+)\s+(?<arg>\S+)` | yes |
| Nested repeats | `(a+)+$` | yes, in linear time |
| Lookbehind | `(?<=a)b`, `(?<!a)b` | yes |
| Small repeat counts | `x{1,10}`, `\d{1,3}`, `[a-z]{16}` | yes |
| Backreferences | `(a)\1`, `(?<n>a)\k<n>` | no |
| Lookahead | `(?=a)a`, `(?!a)b` | no |
| Repeat counts above about 16 | `x{1,1000}`, `[a-z]{2,64}` | no: use `+` or `*` |

Another V8 accepts a different set (Node 20 refuses lookbehind). The bot
asks the engine rather than assuming, so on any Node a pattern is
refused on save exactly when it would not run. A stored regex that stops
compiling (after a Node upgrade, or saved before this check) never
matches; the bot event log names each one at startup, and again when a
message reaches it.

If V8 ever drops the engine, the bot runs degraded and says so in the bot
event log at startup: matching uses the normal engine, and both saving
and matching refuse a repeat inside a repeat (`safe-regex2`). A stored
pattern with a nested repeat is therefore disabled (it never matches),
and the startup check lists each one.

The admin UI's **Try it** box runs the browser's own engine, which has no
linear mode: a pattern the bot refuses still previews there, and saving
shows the bot's reason on the pattern.

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

- Webhook actions are rate-limited to 5 requests per 10 seconds: in
  servers per channel, in DMs with the bot per user, and for commands per
  user ([rate limit](#rate-limit)). A message over the limit is dropped
  without a reply. A drop is not counted in the behavior's stats and is
  noted once per window in the bot event log. The system login is never
  limited.
- One user's messages in one channel (or in their DM with the bot) are
  handled one at a time, in order. A slow webhook therefore delays only
  that user's next message there, not their messages elsewhere and not
  other users. A message that fires no webhook trigger never waits, and
  the system login never queues.
- At most 3 messages wait behind the one being handled. A further message
  is dropped without a reply and without counting it, and the drop is
  noted once in the bot event log.

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

## Converting a trigger

A custom behavior can move between a message trigger and a command
trigger (`POST /api/behaviors/:id/convert-trigger`). It stays the same
behavior: its id, title, note, on/off switch, webhook (URL, secret, and
a previous secret still in its rotation grace), statistics and delivery
log are kept, so a receiver keeps verifying with the same secret. What
belonged to the old trigger only is dropped.

**Message trigger → command leaf.** The behavior becomes the root leaf
of a new command, or one more subcommand of an existing command that
already has subcommands. A command whose only leaf is its root has to be
[converted to subcommands](#leaves) first: Discord does not let a root
leaf and subcommands coexist. The new command's name must be free like
any command's ([names](#names)). The command is **registered on Discord
first**, and only once Discord accepted it is the behavior changed: if
Discord refuses, or the bot is not connected, the answer is
`502 registration_failed` and the message trigger stays exactly as it
was. A disabled behavior adds nothing Discord shows, so it converts
without a registration. Lost on the way:

- a channel location: Discord cannot limit a command to one channel, so
  a channel's trigger becomes a command of that server;
- the audience of a DM trigger (one user, a group): everyone who can see
  the command can run it. A group whose only user this was is deleted
  with its member list;
- the pattern, **Stop after a match** and the position in the matching
  order;
- the webhook payload changes from the message to the command's options
  and `_meta`.

**Command leaf → message trigger.** The behavior becomes a message
trigger at the chosen location, last in the matching order. It is
**stored first**; then the command is registered again without the
leaf, or, when this was its last leaf, deleted and removed from Discord.
If Discord refuses that update the conversion still stands (the message
trigger already works) and the answer's `registration` says `failed`:
Discord keeps showing the old leaf until the command is
[resynced](#registration). Lost on the way: the leaf's options, its
path in the command, and the payload's options. The reply visibility is
kept, which in a server means: unset (only the user who ran it) becomes
public in the channel, `private` becomes a DM to the author.

The system login cannot be converted here (`409 system_immutable`); it
has its own [trigger switch](#changing-the-logins-trigger). Every
conversion is audited as `behavior.trigger.convert`, with where it came
from, where it went and the command it joined or left.

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
trigger or a command, never both. In the admin UI the kind changes from
the card's kind tag, like a [conversion](#converting-a-trigger): a
dialog takes the new trigger's settings, then confirms the switch and
shows each step; for an admin who is not an owner the other kind is
disabled, with the reason. A change within the same kind is edited in
the card. Every rule answers one question: after this save, can the
owner still log in?

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

**Delivery log:** each delivery of a webhook action also leaves one row
(`behavior_deliveries`): when it fired, the trigger kind (`command` or
`message`), ok or failed, the receiver's HTTP status, the time from the
forward to the rendered reply, an error code, the first 300 characters
of the error, which key verified the response signature, and whether the
receiver deferred its reply (`{"defer": true}`, answered later with the
run's callback token, [protocol](behavior-webhook-protocol.md#answering-later)):
a deferred delivery is ok and shows 「延後回覆」. A failure gets one of
these codes:

| Code | Meaning |
|------|---------|
| A [target rule](#webhook-targets) code, or `response_signature` | The forwarder refused the target, or the response signature was missing, stale or wrong. |
| `http_error` | A non-2xx answer (a redirect too). |
| `invalid_reply` | A 2xx whose body the bot could not use (too large, not JSON, not a reply object). |
| `request_failed` | No answer: unreachable, timed out, or an action the bot could not decrypt. |
| `render_failed` | Discord refused the reply. |
| `dm_failed` | A private reply to a server message's author could not be sent as a DM (by the synchronous answer or a callback call). |
| `defer_failed` | Discord refused a command's deferral (the interaction had expired): the webhook was never called, and the user sees "interaction failed". It counts as a failure in the statistics too, and is warned about once per leaf in the event log. |
| `callback_invalid` | A callback call (#113) the bot refused: a component that is not an https link button, nothing to show, or a `message_id` the token did not send. A row of its own, not counted in the statistics. |
| `callback_failed` | Discord refused a callback call's reply. A row of its own, not counted in the statistics. |
| `attachment_failed` | The reply's [attachments](behavior-webhook-protocol.md#attachments) could not be downloaded from the webhook's origin (a plugin action's: from under the plugin's registered URL): more than 5, a refused path or name, over 8 MiB (25 MiB together), a redirect, a non-2xx answer, or no answer in time (including a wait for a download turn). The user gets the failure line, never the reply without its files (by the synchronous answer or a callback call). |
| `plugin_unavailable` | A [plugin action](#plugin-actions)'s plugin could not take the run: not installed, disabled or inactive, not ready, without a dispatch key, or its address refused. Nothing was dispatched; the user gets the failure line. |
| `action_undeclared` | The plugin's current manifest no longer declares the bound [plugin action](#plugin-actions). Nothing was dispatched; the user gets the failure line. |

A row never holds the webhook URL, a secret, the payload, the message or
the reply, a user id or a message id. Each behavior keeps its last 20
deliveries, none older than 7 days: writing a delivery is a single
insert, and a background pruner removes the rest every 10 minutes. A
test does not write a delivery. Writing one is best-effort: if it fails,
the action and its reply go on. In the admin UI, a message trigger card
and an open command leaf list the recent deliveries under
「最近投遞」, loaded when the list is opened.

**Direct messages to other users (#157):** a reply may ask the bot to DM
other users (`direct_messages`, [protocol](behavior-webhook-protocol.md#direct-messages)).
Each behavior may have a **DM allowlist** — user ids and behavior groups —
set on its card (`GET` / `PUT /api/behaviors/:id/dm-allowlist`, audited as
`behavior.dm_allowlist.replace`). The user who triggered the behavior
may always be DMed. For anyone else: with a list, only those users and the
groups' members may be DMed; without one, members of the server the
behavior was triggered in, or of any server the bot is in for a trigger
in a DM with the bot. A group a list names counts as in use: its members
can be set, and it is not pruned while a list names it. Limits (env):
`BEHAVIOR_DM_PER_MINUTE` DMs a minute per behavior (default 10, every
attempt counted, before any member lookup) and `BEHAVIOR_DM_PER_RECIPIENT`
per `BEHAVIOR_DM_PER_RECIPIENT_WINDOW_MS` to one user from one behavior
(default 3 per 10 minutes). Without a list, a DM trigger's recipient check
can cost one member lookup per server the bot is in (stopping at the
first hit), bounded by the per-behavior limit; each answer is cached for
60 seconds. Every DM leaves a row in `behavior_dm_log` — the
behavior, the recipient, the user who triggered it, the outcome and the
time; kept 30 days (a deleted message trigger's rows go with it; a
deleted command leaf's age out, so a refused command write can restore
the leaf with its log), listed on the card (`GET /api/behaviors/:id/dm-log`,
the last 50). Unlike the delivery log, it holds user ids: who a behavior
DMed is what it answers. It never holds the message.

## Plugin actions

A plugin may declare **behavior actions** in its manifest
(`behavior_actions: [{ key, name, description }]`; with the SDK,
`definePluginBehaviorAction`). An admin binds one to any behavior — a
command leaf or a message trigger — by picking the plugin and the action
in the action form (「動作來源」 → Plugin 動作). The binding has no
settings of its own: a command's options, a message's text and captures
reach the plugin as they are.

When the behavior fires, the bot:

1. checks the plugin can take the run — installed, enabled and active,
   ready, with a dispatch key — and that its **current** manifest still
   declares the action. If not, nothing is sent: the user gets the
   failure line and the delivery logs `plugin_unavailable` or
   `action_undeclared`.
2. defers a command (the user sees "thinking…"), as for a webhook.
3. issues the run's [callback token](behavior-webhook-protocol.md#answering-later)
   and sends a signed Plugin Dispatch of kind `behavior_action` to the
   plugin's `endpoints.behavior_action` (default
   `/behavior-actions/{action_key}`): the trigger's webhook `_meta`, plus
   `action_key` and `callback`
   ([protocol](behavior-webhook-protocol.md#plugin-actions)).
4. records an ok delivery marked deferred once the plugin accepts (2xx);
   a message trigger shows typing. The plugin replies with the token,
   like a webhook that deferred: the same reply model, visibility rules,
   attachments (downloaded from under the plugin's registered URL,
   `<plugin URL><path>`, as for a plugin's own replies) and
   direct messages. A dispatch the plugin refuses or does not answer
   fails the run (`http_error` / `request_failed`), revokes the token and
   shows the failure line.

**The binding is the authorization.** A plugin action runs wherever its
trigger fires: no Feature Reach or Guild Reach applies, unlike a
plugin's own commands and buttons
([ADR 0003 addendum](../adr/0003-behavior-trigger-action-split.md#addendum-2026-11-10-plugin-action-dispatch)).
Who can fire it is the trigger's business, as for a webhook.

On save, the binding must name an action the plugin's current manifest
declares (`400 validation_failed` on `pluginAction.pluginKey` /
`pluginAction.actionKey` otherwise). A disabled or offline plugin's
actions can still be bound — the runs fail until it is back — and the
admin UI says so. Bindings are keyed by the plugin's key, so they survive
a plugin re-registering or being reinstalled: a plugin that registers
under the same key — which takes that key's setup secret — inherits the
existing bindings. A plugin action has no test
webhook.

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
log, the behavior's statistics and its delivery log
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
- The kind tag in a card's title row (「訊息」 / 「指令」) is a menu with
  both kinds, the current one disabled. Choosing the other kind opens a
  dialog for the [conversion](#converting-a-trigger): a message trigger
  picks a new command (its name from the title, the visibility a new
  command gets in the trigger's section) or a command with subcommands;
  a command picks the leaf (when it has several), the location (its own
  section by default) and the pattern. The dialog lists what will be
  lost or changed, and nothing changes before it is confirmed. The
  system login's card uses the same tag for its
  [trigger switch](#changing-the-logins-trigger).
- A behavior's action form switches between a webhook and a
  [plugin action](#plugin-actions); the plugin side lists the installed
  plugins' declared actions, and flags a disabled or offline plugin and
  a binding its plugin no longer declares. Saving the other kind
  converts the behavior.
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
| `GET /api/behaviors/plugin-actions` | `{ plugins }`: each installed plugin whose manifest declares [behavior actions](#plugin-actions) — `pluginKey`, `pluginName`, `enabled`, `status`, `actions: [{ key, name, description }]`. |
| `POST /api/behaviors` | Create a message trigger with its action. |
| `PATCH /api/behaviors/:id` | Edit a message trigger or a command leaf; naming the other kind of action converts it. |
| `DELETE /api/behaviors/:id` | Delete a message trigger or a command leaf. |
| `PUT /api/behaviors/reorder` | `{ location, ids }`: the full new order of one location's message triggers (`bot_dm`, `guild:all`, `guild:<id>`, `channel:<guildId>:<channelId>`). |
| `POST /api/behaviors/:id/test` | Test-fire the saved webhook action. |
| `GET /api/behaviors/:id/deliveries` | `{ deliveries }`: the behavior's last 20 [deliveries](#webhook-actions), newest first (`404 not_found` for an unknown id; always empty for the system login). |
| `POST /api/behaviors/:id/webhook-secret/rotate` | New secret, shown once; the old one stays valid for 24 hours. |
| `POST /api/behaviors/:id/convert-trigger` | [Convert](#converting-a-trigger) a message trigger to a command leaf or back. `ifUpdatedAt` is required. To a command: `{ to: "command", command: { new: { name, description?, registration, guildId?, integrationTypes, contexts, defaultMemberPermissions? } } \| { existingId, subcommandName }, leafDescription?, replyVisibility? }` (the description defaults to the title). To a message: `{ to: "message", location, patternKind, patternValue, stopOnMatch?, ignoreBots?, audienceKind?, audienceUserId?, audienceGroupName?, replyVisibility? }`, `location` as for the reorder. Answers `{ behavior, command, registration }` or `{ behavior, registration }`. |
| `POST /api/behavior-commands` | Create a command with its leaves. |
| `PATCH /api/behavior-commands/:id` | Edit a command's name, description or visibility. |
| `DELETE /api/behavior-commands/:id` | Delete a command and its leaves. |
| `POST /api/behavior-commands/:id/leaves` | Add a subcommand leaf. |
| `POST /api/behavior-commands/:id/convert-to-subcommands` | Turn the root leaf into the first subcommand. |
| `POST /api/behavior-commands/:id/resync` | Register the command again as stored (the login's: owner only). |
| `PUT /api/behaviors/system/login/trigger` | Change the system login's trigger (owner only). |
| `GET` / `PUT /api/behavior-groups/:groupName/members` | Read or replace an audience group's members (at most 1000). |

- **Actions:** a body that sets an action gives `webhook: { url, authMode? }`
  or `pluginAction: { pluginKey, actionKey }` — one of them (a create
  needs one; neither or both is `400 validation_failed`). In a `PATCH`,
  the other kind replaces the stored action: its row goes and
  `actionSource` follows; a webhook given after a plugin action has no
  secret yet, so turning authentication on issues one. Reads carry
  `actionSource`, `webhook` and `pluginAction` (null unless bound).
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
  `behavior.group_members.replace`, `behavior.system.trigger`,
  `behavior.trigger.convert`), never with
  a secret or a webhook URL (a short URL fingerprint instead). A plugin
  action is recorded as its `pluginAction`; a change of source also as
  `actionSource: { from, to }`.
- **Secrets** generated by a write come back once, as `secret` (a command
  create returns one per leaf).

## Storage

| Table | Purpose |
|-------|---------|
| `behavior_commands` | A command: name, description, registration target, install types, contexts, default member permissions, `isSystem` (the login's command). |
| `behavior_definitions` | A behavior: title, note, on/off, position, its trigger (command leaf or message trigger fields), action source (`webhook`, `plugin`, or `builtin` for the system login, keyed by `systemKey`) and reply visibility. |
| `behavior_webhook_actions` | A behavior's webhook: URL and secret (encrypted), auth mode, the previous secret and its expiry during a rotation. |
| `behavior_plugin_actions` | A behavior's plugin action: `pluginKey` and `actionKey`. |
| `behavior_group_members` | Audience group members, by group name. |
| `behavior_stats` | Per-behavior statistics. |
| `behavior_deliveries` | The delivery log: one row per webhook delivery or plugin action dispatch, the last 20 per behavior for at most 7 days. |

The runtime reads all of this from an in-memory snapshot, rebuilt after
every write (and at most 30 seconds old for writes from another process).
Schema changes and the 2.0 upgrade are in
[operations.md](../operations.md#upgrades).

## Source

| File | Purpose |
|------|---------|
| `src/modules/behavior/models/` | The tables. |
| `src/modules/behavior/behavior-catalog.ts` | The in-memory snapshot the runtime reads. |
| `src/modules/behavior/behavior-section.ts` | The section rule. |
| `src/modules/behavior/behavior-routes.ts` | Mounts every route; list, schema, test-fire, group members. |
| `src/modules/behavior/behavior-write-routes.ts`, `message-trigger-writes.ts`, `message-trigger-rules.ts` | Message trigger writes and their rules. |
| `src/modules/behavior/behavior-command-routes.ts`, `command-leaf-writes.ts`, `command-tree-rules.ts`, `command-registration-sync.ts` | Command writes, Discord's rules, registration. |
| `src/modules/behavior/message-trigger-reorder.ts` | Reorder. |
| `src/modules/behavior/behavior-trigger-convert.ts`, `command-register-first.ts` | Converting a behavior between a message trigger and a command leaf; the register-first flow it shares with the login's trigger switch. |
| `src/modules/behavior/behavior-action-input.ts`, `webhook-action-input.ts`, `webhook-secret-rotate.ts` | Action intake (webhook XOR plugin action), webhook intake and rotation. |
| `src/modules/plugin-system/plugin-behavior-actions.ts` | The installed plugins' declared behavior actions (picker, save-time check). |
| `src/modules/behavior/system-seed.service.ts`, `system-login-trigger.ts`, `system-login-trigger-route.ts`, `login-trigger-hint-route.ts` | The system login. |
| `src/modules/behavior/behavior-trigger.ts`, `regex-trigger-boot-check.ts`, `src/utils/linear-regex.ts` | Pattern matching; the linear-time regex engine and its startup check. |
| `src/modules/command-system/behavior-rate-limits.ts` | Rate limits. |
| `src/modules/command-system/interaction-dispatcher.service.ts` | Runs command triggers. |
| `src/modules/command-system/message-trigger-matcher.service.ts` | Runs message triggers. |
| `src/modules/command-system/webhook-action.ts`, `webhook-forwarder.service.ts` | Calls the webhook, signs and verifies. |
| `src/modules/command-system/plugin-action.ts`, `src/modules/plugin-system/plugin-dispatch.service.ts` | Runs a plugin action: the `behavior_action` Plugin Dispatch. |
| `src/modules/command-system/behavior-reply.ts`, `reply-renderer.ts` | The reply model and its delivery. |
| `src/modules/command-system/reconcile.service.ts` | Registers commands with Discord. |
| `frontend/src/views/admin/behaviors/` | Admin UI. |
