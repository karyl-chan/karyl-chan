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
  - `system` — built-in handler (`admin-login`).

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

One `source='system'` row is seeded idempotently by
`src/modules/behavior/system-seed.service.ts`; it cannot be deleted or
disabled through the API. (`manual` and `break` were removed together with
continuous sessions — see [ADR 0003](../adr/0003-behavior-trigger-action-split.md).)

| `systemKey` | Command | Action |
|-------------|---------|--------|
| `admin-login` | `/login` | Reply (ephemeral) with a one-time admin login link. Bot owners (`BOT_OWNER_IDS`) and any `authorized_users` row with ≥1 active capability succeed; everyone else gets a "not authorized" reply. |

It is registered globally with dual-install enabled, and
`contexts` is restricted to `BotDM` (the seeded home is `all_bot_dms`;
older `all_dms` rows that also carried `PrivateChannel` are self-migrated
off it); it does not appear in the guild command UI. The admin can switch
its trigger to a DM message pattern (production uses `!login`).

### Multi-match and `stopOnMatch` (message_pattern only)

The DM matcher walks every applicable `message_pattern` behavior in
`sortOrder` and can fire more than one per message:

- `system` match → always stops (terminal UX: the login link).
- `custom` match → `stopOnMatch=true` stops the walk; `false` (default)
  keeps evaluating, so several behaviors can each fire on the same message.

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

1. Collect the `message_pattern` behaviors applicable to the
   caller (filtered by `audienceKind`, ordered by `sortOrder` ascending),
   then by surface (`contexts`), placement, and — for bot authors in
   guilds — `ignoreBots`.
2. Evaluate each via `matchesTrigger` (`startswith` / `endswith` /
   `regex`); forward per the multi-match rules above (`stopOnMatch`).

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
in `bot_events`. The POST has a 10-second timeout.

### Webhook targets

The webhook URL is checked by `resolveWebhookTarget`
(`src/utils/host-policy.ts`) both when the behavior is saved and again
on every forward (including the admin test-fire):

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
settings** page under the behavior group. Entries that cannot fully
apply are logged as a warning at boot: a loopback / metadata name, an
IP or range reaching beyond private space (`127.0.0.0/8`, a public IP,
`0.0.0.0/0`), or a private range covering a cloud metadata address
(`100.64.0.0/10` → `100.100.100.200`, `fd00::/8` → `fd00:ec2::254`;
that one address stays refused, the rest applies). A hostname whose DNS answers
include any blocked address is refused as a whole.

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
`blocked_reserved`, `dns_failed`, …) next to a readable `error` that
names the target and the setting — the save route returns it as a 400
body, the test-fire route as `{ ok: false, error, errorCode }`.

The legacy `WEBHOOK_ALLOW_PRIVATE=true` switch (allow every private
address) still works for local development and the e2e harness, but is
deprecated; the bot logs a warning at boot when it is on in production.

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

## Source

| File | Purpose |
|------|---------|
| `src/modules/behavior/models/behavior.model.ts` | `behaviors` table; enums; cross-field invariants. |
| `src/modules/behavior/models/behavior-scope-tab.model.ts` | Scope tab + `deriveFieldsFromTab` derivation. |
| `src/modules/behavior/models/behavior-audience-member.model.ts` | Group membership. |
| `src/modules/behavior/behavior-routes.ts` | `/api/behaviors/*` CRUD + resync. |
| `src/modules/behavior/scope-tab-routes.ts` | `/api/behavior-tabs/*` CRUD. |
| `src/modules/behavior/system-seed.service.ts` | System behavior seed. |
| `src/modules/behavior/scope-tab-seed.service.ts` | Fixed scope tab seed. |
| `src/modules/behavior/behavior-trigger.ts` | Pure `matchesTrigger` and `describeTrigger`. |
| `src/modules/command-system/interaction-dispatcher.service.ts` | Slash command dispatch. |
| `src/modules/command-system/message-pattern-matcher.service.ts` | DM + guild pattern dispatch. |
| `src/modules/command-system/webhook-forwarder.service.ts` | Webhook POST + HMAC. |
| `src/modules/command-system/reconcile.service.ts` | Slash command registration in Discord. |
| `src/utils/hmac.ts` | HMAC scheme. |
| `frontend/src/views/admin/behaviors/` | Admin UI. |
