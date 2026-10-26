# Behaviors

> **此頁描述舊模型（`behaviors` 表與範圍分頁），將於 #141 改寫。** 目前的模型見
> [ADR 0003](../adr/0003-behavior-trigger-action-split.md) 與
> [architecture.md](../architecture.md#modulesbehavior--behaviors)。

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

`MessageTriggerMatcher` mounts a `messageCreate` listener:

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
  - `captures` — a regex trigger's capture groups, group 1 first (a named
    group counts by its position; `null` for an optional group that took
    no part). `天氣 台北` against `^天氣\s+(.+)` sends `["台北"]`. Always
    `[]` for `startswith` / `endswith`.

(The top-level shape stays Discord-webhook compatible — no `embeds` or
`allowed_mentions` outbound. The `allowed_mentions: { parse: [] }` guard is
applied to the bot's *response* relayed back into the DM, not to this
outbound webhook call. The slash path's `_meta` additionally carries the
interaction fields, `behavior_id`, and the invoked leaf's path as
`sub_command_name` / `sub_command_group` — the names the plugin command
payload uses, `null` on a root leaf; `content` keeps reading
`/name sub`.)

### Reply contract (v1)

Webhook → bot — the response body is a **Behavior Reply**, the same shape
a plugin sends to `interactions.respond` (without the token). The earlier
`{ content, embeds }` response is a subset of it, so there is no version
field. The built-in login action answers with the same structure. The
canonical lists live in `CONTRACT_FIXTURES.behaviorWebhook.response`
(`@karyl-chan/plugin-wire`).

| Field | Type | Phase-1 rule |
|-------|------|--------------|
| `content` | string | Trimmed. Over 2000 characters it is cut and ends with a new line and `…(truncated)`. |
| `embeds` | array | Whitelisted fields (title / description / url / color / timestamp / footer / image / thumbnail / author / fields), Discord's per-field lengths, non-http(s) urls dropped. At most 10, and at most 6000 characters across all of them — an embed that would pass 6000 is dropped, later smaller ones may still fit. |
| `components` | array | Action rows (`type: 1`) of **link buttons only** (`type: 2, style: 5`, an `https://` `url` ≤ 512 characters, a non-empty `label`, cut to 80). At most 5 rows of 5. Anything else is dropped. |
| `ephemeral` | boolean | Who sees the reply — see below. |
| `flags` | integer | Only `SuppressEmbeds` (4) and `SuppressNotifications` (4096) are kept. Visibility is never a flag. |

Any other top-level field is ignored, and the bot logs it once per
behavior. A field of the wrong type is ignored the same way. The body may
be at most **64 KiB**; a larger body, a non-empty body that is not JSON, or
JSON that is not an object fails the action. An empty body (or an object
with nothing to show) means "no reply".

`ephemeral`, per trigger:

| Trigger | Default | `ephemeral: false` | `ephemeral: true` |
|---------|---------|--------------------|-------------------|
| Command | only the invoker sees it | posted publicly (the bot follows up publicly and deletes its private "thinking…" placeholder — the plugin defer table) | only the invoker |
| Message in a DM with the bot | in the DM | in the DM | in the DM (ignored) |
| Message in a guild channel | in the channel | in the channel | DMed to the author; never in the channel |

Mentions in a reply are never parsed. There is no `[BEHAVIOR:END]` marker
any more: it ended a conversation session, and sessions were removed
with ADR 0003 (S1), so a reply never ends anything.

When an action fails — the webhook is unreachable, answers non-2xx, fails
signature checks, sends a body the rules above refuse, or Discord refuses
the reply — the user gets a generic localized line ("couldn't be completed
right now"), never the receiver's error text:

| Trigger | Where the failure line goes |
|---------|-----------------------------|
| Command | the invoker's reply (the "thinking…" placeholder is resolved) |
| Message in a DM with the bot | the DM |
| Message in a guild channel | a DM to the author; if that DM fails, nothing — the channel never hears about it |

An ephemeral guild reply that can't be DMed is a failure too, and also
says nothing in the channel. The system login never speaks in a guild
channel at all. The detail goes only to the log (`bot_events`) and the
behavior's stats (`lastError`), which the admin UI shows.

Slash behaviors may define command options (BH-2.2C,
`slashCommandOptions`): a flat list of scalar options (string / integer /
number / boolean / user / channel / role / mentionable / attachment) edited
in the admin UI, registered to Discord by the reconciler, and delivered to
the webhook in `_meta.options` as `{ name, type, value }` entries.

Failed dispatch (network error, non-2xx, signature failure, a refused
body) is recorded in `bot_events` and the behavior's stats. The POST has a
10-second timeout.

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
body, the test-fire route as `{ ok: false, error, errorCode }` (in its
`{ ok, reply, notes, status, error, errorCode, verified }` answer).

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
`<path>` is the pathname of the configured webhook URL — the query
string (including the `?wait=true` the bot adds) is not signed. A receiver
behind a reverse proxy that rewrites the path must verify against the
path as configured on the bot, not the one it receives.

The webhook **response** is signed with the same secret over the
**request's** method, path and **nonce** (#102):

```
X-Karyl-Signature = HMAC_SHA256(secret, "<METHOD>:<path>:<ts>:<request nonce>:<body>")
```

with `X-Karyl-Timestamp` set to the response's own time. Binding the
request nonce means a response signed for one request — one user's login
link — can't be swapped into another's. Sending `X-Karyl-Nonce` on the
response is optional; if sent it must equal the request's. Timestamps that
differ from local time by more than 300 seconds are rejected; comparisons
use `timingSafeEqual`. In `hmac` mode a missing or invalid response
signature fails the action and **nothing is shown** to the caller but the
generic failure line. In `token` mode the bot also sends `X-Karyl-Nonce`,
and a response that carries a signature is verified the same way.

This was a hard switch: the earlier nonce-less response form
(`"<METHOD>:<path>:<ts>:<body>"`) and responses signed over a nonce of the
receiver's own no longer verify. A transition window would have kept the
swap open for its whole length, and when it shipped production had no
custom behaviors (only the built-in login), so no receiver depended on the
old form.

### Test-fire requests

The admin **Test webhook** button sends one request to the saved webhook
action (not the unsaved form). It must never pass for a real user, so it
is distinguishable **at the signature level** (#101):

| Mode | A test-fire |
|------|-------------|
| all | carries `X-Karyl-Test: 1` and `_meta.test: true` |
| `hmac` | the signed string starts with `test:` — `HMAC(secret, "test:<METHOD>:<path>:<ts>:<nonce>:<body>")` (also `-previous` during a rotation). The response must be signed the same way, `test:` included. |
| `token` | the token travels in `X-Plugin-Webhook-Test-Token` (and `-Test-Token-Previous`), never in `X-Plugin-Webhook-Token` |

A receiver that verifies only the real scheme therefore rejects a test —
the admin sees its answer (e.g. HTTP 401), which still proves the bot
reaches it. A receiver that wants to answer tests verifies them under the
test scheme and should answer with something harmless (never a real login
link). A test-fire carries no real identity: `_meta.user` is the
placeholder `{ id: "0", username: "karyl-test", … }`, not the admin who
pressed the button.

`POST /api/behaviors/:id/test` answers `{ ok, reply, notes, status,
error, errorCode, verified }`: the reply after the phase-1 rules, what
they changed (`notes`), and which key verified the response's signature
(`"hmac"`, `"token"`, or `null` when the response was not signed). A
signature that is missing, stale or does not match fails with
`errorCode: "response_signature"`. The admin UI previews the reply —
content, embeds, link buttons, who would see it on that trigger, "response
signature verified" — and, when the service answers 401 / 403 or the
signature fails, explains that a receiver refusing the test scheme is
behaving as intended.

### Secret rotation

The secret is generated by the bot — when authentication is turned on,
and by `POST /api/behaviors/:id/webhook-secret/rotate` — and shown once,
in that response; the admin API never returns it again (reads report
`secretSet` and `previousSecretExpiresAt`).

After a rotation the replaced secret stays valid for 24 hours:

| Mode | During the grace period the bot sends |
|------|---------------------------------------|
| `token` | `x-plugin-webhook-token: <new>` **and** `x-plugin-webhook-token-previous: <old>` |
| `hmac` | the usual three headers signed with the **new** secret, **and** `x-karyl-signature-previous` — the same signature (same timestamp, nonce and body) made with the **old** secret |

and it accepts a response signed with either secret. After the grace
period the `-previous` headers stop and the old secret is gone.

The standard headers switch to the new secret **at the moment of the
rotation**. Their format does not change, but a receiver that only knows
the old secret and only reads the standard headers rejects every request
from then on, until it gets the new secret. To rotate without downtime:

1. Before rotating, make the receiver verify **either** header: check
   `x-karyl-signature` (or `x-plugin-webhook-token`) against its secret
   and, if that fails, the `-previous` header — as the reference receiver
   below does. This step is needed only once.
2. Rotate. The receiver, still on the old secret, keeps accepting
   requests through the `-previous` header, and its responses (signed with
   the old secret) are still accepted.
3. Within 24 hours, give the receiver the new secret. From then on the
   standard header matches.

A receiver that keeps a list of secrets can instead accept both the old
and the new secret on the standard header — but it can only add the new
one after the rotation, so requests between the rotation and that update
fail unless it also checks the `-previous` header.

### Reference webhook receiver (Node.js)

```js
import crypto from 'node:crypto';

const seenNonces = new Map(); // nonce -> expiry (unix sec)

function sign(secret, method, path, ts, nonce, body) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${method.toUpperCase()}:${path}:${ts}:${nonce}:${body}`)
    .digest('hex');
}

function sameHex(a, b) {
  return (
    typeof a === 'string' &&
    a.length === b.length &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}

// The response: sign over the REQUEST's nonce (the bot rejects anything else).
function signResponse(secret, method, path, requestNonce, body) {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    'x-karyl-timestamp': ts,
    'x-karyl-signature': sign(secret, method, path, ts, requestNonce, body),
  };
}

function verify(headers, body, method, path, secret) {
  const ts = headers['x-karyl-timestamp'];
  const nonce = headers['x-karyl-nonce'];
  if (!ts || !nonce) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > 300) return false;
  const expected = sign(secret, method, path, ts, nonce, body);
  // The current secret signs x-karyl-signature. During a rotation's grace
  // period the bot also signs with the previous secret in
  // x-karyl-signature-previous: accepting either lets this receiver switch
  // to the new secret at its own pace (see "Secret rotation").
  if (
    !sameHex(headers['x-karyl-signature'], expected) &&
    !sameHex(headers['x-karyl-signature-previous'], expected)
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

In token mode the same applies to the token: accept the request when
`x-plugin-webhook-token` **or** `x-plugin-webhook-token-previous` equals
the receiver's token (compare with `timingSafeEqual`).

## Admin UI

Path: `/admin/behaviors`. Requires the `behavior.manage` capability (or
`admin`); see [`../permissions.md`](../permissions.md).

- The left sidebar lists scope tabs. The `+` in the header creates a
  dynamic tab.
- The main area shows behaviors under the selected tab. Drag to reorder,
  toggle to enable / disable, edit and delete inline.
- Every write is recorded in `admin_audit_log` (hash chain), without
  the webhook secret or URL (a short URL fingerprint instead).

The webhook URL and secret are AES-256-GCM encrypted at rest. The secret
is write-only: generated by the bot, shown once, never returned by a
read (see *Secret rotation*).

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
| `src/modules/command-system/message-trigger-matcher.service.ts` | DM + guild pattern dispatch. |
| `src/modules/command-system/webhook-forwarder.service.ts` | Webhook POST + HMAC. |
| `src/modules/command-system/reconcile.service.ts` | Slash command registration in Discord. |
| `src/utils/hmac.ts` | HMAC scheme. |
| `frontend/src/views/admin/behaviors/` | Admin UI. |
