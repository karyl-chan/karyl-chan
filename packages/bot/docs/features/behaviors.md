# Behaviors

A **behavior** is a "Discord trigger → action" rule stored in the
`behaviors` table. Each behavior has one trigger type and one source:

- **Trigger types (`triggerType`)**
  - `slash_command` — fires when a specific slash command is invoked.
  - `message_pattern` — fires when a message matches a pattern
    (startswith, endswith, or regex). The behavior's `contexts` decide
    the surface: `BotDM` patterns match DMs, `Guild` patterns match
    guild text channels (BH-3), narrowed further by placement
    (specific_guild / specific_channel tabs) and audience.

    Guild guardrails: the bot's own messages never trigger anything;
    other bot/webhook authors are skipped unless the behavior unchecks
    `ignoreBots` (default on); forwards are rate-limited per channel
    (5 per 10 s window, silently dropped and noted in `bot_events`).
- **Sources (`source`)**
  - `custom` — pack the trigger as an HTTP webhook POST, forward to the
    configured URL, and relay the response back to the caller.
  - `system` — built-in handler (`admin-login`, `manual`, `break`).

## Concepts

### Scope tab

Every behavior hangs off one **scope tab** (`scopeTabId`). A scope tab is
both a grouping unit in the admin UI and the source of the behavior's
"reach" five-tuple (`scope` / `contexts` / `audienceKind` /
`audienceUserId` or `audienceGroupName` / `placementGuildId` or
`placementChannelId`). Picking a tab derives the five fields automatically.

| Tab type | Fixed | Derived reach |
|----------|-------|---------------|
| `global_all` | yes (`id=1`) | global scope, all contexts, all audiences |
| `all_dms` | yes (`id=2`) | global scope, BotDM + PrivateChannel, all audiences |
| `all_bot_dms` | yes (`id=3`) | global scope, BotDM only, all audiences |
| `all_guilds` | yes (`id=4`) | guild scope, Guild context, all audiences |
| `specific_guild` | no | one specific guild |
| `specific_channel` | no | one channel within a guild |
| `specific_user` | no | one user's DM |
| `specific_group` | no | members of a named group |

The four fixed tabs cannot be deleted and are seeded idempotently at boot.
The four `specific_*` tabs are created by admins. Deleting a dynamic tab
re-attaches its `source='system'` rows to `global_all` and removes its
`source='custom'` rows.

### System behaviors

Three `source='system'` rows are seeded idempotently by
`src/modules/behavior/system-seed.service.ts` and cannot be deleted through
the API:

| `systemKey` | Command | Action |
|-------------|---------|--------|
| `admin-login` | `/login` | Reply (ephemeral) with a one-time admin login link. Bot owners (`BOT_OWNER_IDS`) and any `authorized_users` row with ≥1 active capability succeed; everyone else gets a "not authorized" reply. |
| `manual` | `/manual` | List the behaviors currently available to the caller. |
| `break` | `/break` | End the caller's active continuous-forward session. |

All three are registered globally with dual-install enabled, and
`contexts` is restricted to `BotDM` (the seeded home is `all_bot_dms`;
older `all_dms` rows that also carried `PrivateChannel` are self-migrated
off it); they do not appear in the guild command UI.

### Forward types (`forwardType`)

- `one_time` — fire once on match, end.
- `continuous` — fire on match, open a session in `behavior_sessions`
  (keyed by `(userId, channelId)`, BH-4.3 — one per user per channel; a
  user's DMs with the bot are one channel, so DM behaviour matches the
  old one-per-user model, while guild patterns give the same user
  independent sessions per channel). Subsequent messages from that user
  in that channel go directly to the same webhook until the session
  ends. Sessions persist across bot restarts.

### Multi-match and `stopOnMatch` (message_pattern only)

The DM matcher walks every applicable `message_pattern` behavior in
`sortOrder` and can fire more than one per message:

- `system` match → always stops (terminal UX: login link / manual / break).
- `continuous` match → always stops (the new session owns the conversation;
  evaluating further patterns would be meaningless).
- `one_time` match → `stopOnMatch=true` stops the walk; `false` (default)
  keeps evaluating, so several one_time behaviors can each fire on the same
  message.

`stopOnMatch` has no meaning for `slash_command` behaviors — dispatch is
first-claim-wins over a unique `(slashCommandName, scope, contexts)` index,
so there is never a "next behavior" to keep or skip. The API rejects setting
it on slash behaviors and the editor only shows it for patterns.

## Evaluation and dispatch

### Slash command trigger

`interactionCreate` → `InteractionDispatcher` queries `behaviors` for
`triggerType='slash_command' AND slashCommandName=<name> AND enabled`:

- `source='system'` — route to the built-in handler keyed by `systemKey`.
- `source='custom'` — call `deferReply`, run the webhook forward, then
  `editReply` with the response content.

The slash command registration and synchronisation in Discord are handled
by `CommandReconciler`; see the `command-system` module in
[`../architecture.md`](../architecture.md).

### message_pattern trigger (DMs + guild channels)

`MessagePatternMatcher` mounts a `messageCreate` listener:

1. If the caller has an active session in this channel, the message is
   forwarded to that session's bound behavior directly.
2. Otherwise, collect the `message_pattern` behaviors applicable to the
   caller (filtered by `audienceKind`, ordered by `sortOrder` ascending),
   then by surface (`contexts`), placement, and — for bot authors in
   guilds — `ignoreBots`.
3. Evaluate each via `matchesTrigger` (`startswith` / `endswith` /
   `regex`); forward per the multi-match rules above (`stopOnMatch`).
4. If a matched behavior has `forwardType='continuous'`, open a session
   for `(user, channel)` and stop the walk.

### Ending a continuous forward

Two independent end points:

- **Caller side** — `/break` (or the break text pattern); ends the
  current channel's session, falling back to all of the caller's
  sessions so the escape hatch can never leave someone stuck.
- **Webhook side** — the webhook's response `content` contains the token
  `[BEHAVIOR:END]` (case-insensitive). The session ends and the token is
  stripped from the content before relay.

After a session ends, the next DM falls back to the normal trigger
evaluation path.

## Webhook forwarding

### Payload

Bot → webhook (the URL is automatically suffixed with `?wait=true` to
obtain a synchronous response):

- `content` — the DM message body (`message.content`, verbatim).
- `username` and `avatar_url` — caller's display name and avatar.
- `_meta` — structured metadata (BH-2.1), aligned with the slash path:
  - `user` — `{ id, username, global_name, discriminator, avatar }`. Use
    `user.id` to tell callers apart — `username` is mutable and not a key.
  - `message_id`, `channel_id`, `behavior_id`
  - `session` — `{ active: false }` on the triggering match;
    `{ active: true, started_at }` for messages routed through an open
    continuous session.
  - `attachments` — `[{ url, filename, content_type, size }]` for any
    files attached to the DM.

(The top-level shape stays Discord-webhook compatible — no `embeds` or
`allowed_mentions` outbound. The `allowed_mentions: { parse: [] }` guard is
applied to the bot's *response* relayed back into the DM, not to this
outbound webhook call. The slash path's `_meta` additionally carries the
interaction fields and now also `behavior_id`.)

Webhook → bot — the response's `content` is relayed back to the caller.
The response may also carry `embeds` (BH-2.2A): an array of Discord-shaped
embed objects, sanitized through a whitelist (title/description/url/color/
timestamp/footer/image/thumbnail/author/fields), truncated to Discord's
length limits, capped at 10, with non-http(s) urls dropped. A response may
be embeds-only.

Slash behaviors may define command options (BH-2.2C,
`slashCommandOptions`): a flat list of scalar options (string / integer /
number / boolean / user / channel / role / mentionable / attachment) edited
in the admin UI, registered to Discord by the reconciler, and delivered to
the webhook in `_meta.options` as `{ name, type, value }` entries.

Failed dispatch (network error, non-2xx, signature failure) is recorded
in `bot_events`; a continuous session is **not** auto-ended. The caller
can always run `/break`. The POST has a 10-second timeout.

### Authentication (`webhookAuthMode`)

Each custom behavior picks one authentication mode:

| Mode | Mechanism |
|------|-----------|
| `null` (unset) | No signing or verification. |
| `token` | Header `x-plugin-webhook-token: <secret>` on the outbound request. Response signatures are verified if present (optional). |
| `hmac` | HMAC-SHA256 mutual signing and verification (see below). |

In `hmac` mode the bot sends three headers on the outbound request:

| Header | Value |
|--------|-------|
| `X-Karyl-Timestamp` | Unix seconds. |
| `X-Karyl-Nonce` | 32-hex random per request (BH-2.4). |
| `X-Karyl-Signature` | `<hex>` = `HMAC_SHA256(secret, "<METHOD>:<path>:<ts>:<nonce>:<body>")`. |

Receivers verifying requests should include the nonce in the signed
string and remember seen nonces for the 300 s window to reject replays.

The webhook **response** is verified the same way (the bot binds the
original request's method + path into the expected payload, which blocks
cross-endpoint replay). For responses the nonce is OPTIONAL — a response
rides the request's own connection, so response replay isn't a
stored-request attack; sign with the legacy
`"<METHOD>:<path>:<ts>:<body>"` form or include an `X-Karyl-Nonce`
header and the nonced form, either verifies. Timestamps that differ from
local time by more than 300 seconds are rejected; comparisons use
`timingSafeEqual`. In `hmac` mode a missing or invalid response
signature counts as a dispatch failure and **content is not relayed**
to the caller.

### Reference webhook receiver (Node.js)

```js
import crypto from 'node:crypto';

const seenNonces = new Map(); // nonce -> expiry (unix sec)

function verify(headers, body, method, path, secret) {
  const ts = headers['x-karyl-timestamp'];
  const sig = headers['x-karyl-signature'];
  const nonce = headers['x-karyl-nonce'];
  if (!ts || !sig || !nonce) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > 300) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${method.toUpperCase()}:${path}:${ts}:${nonce}:${body}`)
    .digest('hex');
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return false;
  }
  // replay check AFTER the signature passes
  for (const [n, exp] of seenNonces) if (exp <= now) seenNonces.delete(n);
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, now + 300);
  return true;
}
```

## Admin UI

Path: `/admin/behaviors`. Requires the `behavior.manage` capability (or
`admin`); see [`../permissions.md`](../permissions.md).

- The left sidebar lists scope tabs. The `+` in the header creates a
  dynamic tab.
- The main area shows behaviors under the selected tab. Drag to reorder,
  toggle to enable / disable, edit and delete inline.
- Every write (behaviors, scope tabs, reorder) is recorded in
  `admin_audit_log` (hash chain).

`webhookUrl` and `webhookSecret` are AES-256-GCM encrypted at rest. The
admin UI returns plaintext to admins because the secret has to be
readable to keep both sides aligned; encryption only protects against
direct DB exposure.

## Storage

| Table | Purpose |
|-------|---------|
| `behaviors` | The behavior row itself (trigger / source / reach / webhook config). |
| `behavior_scope_tabs` | Scope tab. |
| `behavior_audience_members` | Membership list when `audienceKind='group'`. |
| `behavior_sessions` | Continuous forwarding session (PK = `userId`). |

## Source

| File | Purpose |
|------|---------|
| `src/modules/behavior/models/behavior.model.ts` | `behaviors` table; enums; cross-field invariants. |
| `src/modules/behavior/models/behavior-scope-tab.model.ts` | Scope tab + `deriveFieldsFromTab` derivation. |
| `src/modules/behavior/models/behavior-audience-member.model.ts` | Group membership. |
| `src/modules/behavior/models/behavior-session.model.ts` | Continuous session. |
| `src/modules/behavior/behavior-routes.ts` | `/api/behaviors/*` CRUD + resync. |
| `src/modules/behavior/scope-tab-routes.ts` | `/api/behavior-tabs/*` CRUD. |
| `src/modules/behavior/system-seed.service.ts` | System behavior seed. |
| `src/modules/behavior/scope-tab-seed.service.ts` | Fixed scope tab seed. |
| `src/modules/behavior/behavior-trigger.ts` | Pure `matchesTrigger` and `describeTrigger`. |
| `src/modules/command-system/interaction-dispatcher.service.ts` | Slash command dispatch. |
| `src/modules/command-system/message-pattern-matcher.service.ts` | DM pattern dispatch + session. |
| `src/modules/command-system/webhook-forwarder.service.ts` | Webhook POST + HMAC + `[BEHAVIOR:END]`. |
| `src/modules/command-system/reconcile.service.ts` | Slash command registration in Discord. |
| `src/utils/hmac.ts` | HMAC scheme. |
| `frontend/src/views/admin/behaviors/` | Admin UI. |
