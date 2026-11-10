# Behavior webhook protocol

This page is for people who write a **webhook receiver**: the HTTP
service a behavior's webhook action calls. It covers what the bot sends,
how to check that a request really comes from the bot, and how to answer.
How an admin sets a behavior up is in [behaviors.md](behaviors.md).

The machine-readable version of this contract — key lists, limits,
header names and golden HMAC vectors — is `BEHAVIOR_WEBHOOK_FIXTURES`,
exported by `@karyl-chan/plugin-sdk/behavior-receiver` so you can test a
receiver against it (in this repository it is
`CONTRACT_FIXTURES.behaviorWebhook` in
[`packages/plugin-wire/src/contract-fixtures.ts`](../../../plugin-wire/src/contract-fixtures.ts)).
The bot's tests replay it. The bot's test suite also checks this page
against it: the header names, the payload keys and the reply limits
written here must match the fixtures, and the
[reference receiver](#reference-receiver) is run against the golden
vectors and against the bot's own webhook client. The prose and the
wiring examples are not tested.

## Contents

- [At a glance](#at-a-glance)
- [The request](#the-request)
- [Authentication](#authentication)
- [Signing the response](#signing-the-response)
- [Test-fires](#test-fires)
- [Secret rotation](#secret-rotation)
- [The reply (contract v1)](#the-reply-contract-v1)
- [Answering later](#answering-later)
- [Failures](#failures)
- [Reference receiver](#reference-receiver)
- [Changes in bot 2.0.0](#changes-in-bot-200)

## At a glance

- Each time a behavior fires, the bot sends **one `POST`** with a JSON body
  to the URL the admin saved. It waits at most **10 seconds** for the answer.
  It sends at most 5 per 10 seconds per server channel, per bot DM user
  and per command user; over that it sends nothing
  ([behaviors.md](behaviors.md#matching-order)).
- The answer's body is the **reply**: what the bot shows the user. An empty
  body means "say nothing". A command's receiver may also answer
  `{"defer": true}` and reply later with the run's
  [callback token](#answering-later).
- With authentication on, every request is signed (`hmac`) or carries a
  shared token (`token`). In `hmac` mode **your response must be signed too**,
  over the request's nonce.
- The admin's **Test webhook** button sends a request that is signed
  differently from real ones, so that a test can never be taken for a real
  user.
- Redirects are never followed. Errors are never shown to the user: the
  user sees a generic "couldn't be completed" line, and the admin sees the
  detail.

## The request

```
POST <the saved URL, with ?wait=true added>
Content-Type: application/json
<authentication headers, see below>

{ "content": …, "username": …, "avatar_url": …, "_meta": { … } }
```

The bot sets the query parameter `wait=true` on the saved URL (adding it,
or overwriting an existing `wait`). The query string is not part of the
signature.

The top level has the shape of a Discord webhook body, so a receiver that
already handles Discord webhooks can read it. `_meta` carries the rest.
What `_meta` holds depends on the trigger.

The bot may add fields to the request, at the top level or in `_meta`,
without calling it a breaking change. Ignore the fields you don't know: a
receiver that refuses unknown fields (a schema with
`additionalProperties: false`, say) breaks on such an addition.

### From a message trigger

A message trigger fires on a message in a DM with the bot, or in a guild
channel. (A guild is what Discord's API calls a server; this page says
guild, as in `guild_id`.)

| Field | Value |
|-------|-------|
| `content` | The message text, exactly as Discord delivered it. |
| `username` | The author's Discord username, never their global name. This differs from a command. To tell users apart use `_meta.user.id`; to show a name use `_meta.user.global_name ?? _meta.user.username`. |
| `avatar_url` | The author's avatar URL. |
| `_meta.user` | `{ id, username, global_name, discriminator, avatar }`. Use `user.id` to tell users apart: names change. |
| `_meta.message_id` | The message id. |
| `_meta.channel_id` | The channel id (the DM channel in a DM with the bot). |
| `_meta.guild_id` | The guild id, or `null` in a DM with the bot. |
| `_meta.behavior_id` | The behavior that fired. |
| `_meta.attachments` | `[{ id, url, filename, content_type, size }]`, empty when the message has none. `id` is the Discord attachment id; `url` is Discord's CDN link, signed and valid for a limited time, so download the file soon. |
| `_meta.captures` | A regex trigger's capture groups, group 1 first. A named group counts by its position, and an optional group that took no part is `null`. `天氣 台北` against `^天氣\s+(.+)` sends `["台北"]`. Always `[]` for `startswith` / `endswith`. |
| `_meta.callback` | This run's callback token, `{ token, expires_at, api_base }`, to answer later ([Answering later](#answering-later)). |

One message can fire more than one behavior, unless a behavior stops the
walk ([behaviors.md](behaviors.md#matching-order)). Each behavior sends its
own request, so a receiver used by several behaviors can get more than one
request for one message. Tell them apart by `behavior_id`.

### From a command

A command fires when a user runs one of the behavior's Discord commands.

| Field | Value |
|-------|-------|
| `content` | The invoked path, `/name` or `/name sub`. |
| `username` | The user's display name (their global name, or their username when they have none). This differs from a message trigger, which sends the username. To tell users apart use `_meta.user.id`; to show a name use `_meta.user.global_name ?? _meta.user.username`, the same on both triggers. |
| `avatar_url` | The user's avatar URL. |
| `_meta.interaction_id` | The interaction id. |
| `_meta.application_id` | The bot's application id. |
| `_meta.command_name` | The command's name. |
| `_meta.sub_command_name` | The invoked subcommand, or `null` on a command without subcommands. Named like the plugin command payload. |
| `_meta.sub_command_group` | Reserved for subcommand groups. Always `null` for now. |
| `_meta.guild_id` | The guild the command was used in, or `null` outside a guild. |
| `_meta.channel_id` | The channel the command was used in. |
| `_meta.user` | `{ id, username, global_name, discriminator, avatar }`. |
| `_meta.locale` | The user's Discord locale, or `null`. |
| `_meta.options` | The invoked command's or subcommand's options, `[{ name, type, value }]`. `type` is Discord's numeric option type. An `attachment` option's (type 11) `value` is the attachment id: its file is the `_meta.attachments` entry with that `id`. |
| `_meta.behavior_id` | The behavior (command leaf) that fired. |
| `_meta.attachments` | The files of the invoked command's or subcommand's `attachment` options, in option order: `[{ id, url, filename, content_type, size }]`, the same shape as a message trigger's. Empty when it has none. |
| `_meta.callback` | This run's callback token, `{ token, expires_at, api_base }`, to answer later ([Answering later](#answering-later)). |

The interaction token is **not** sent: the bot answers the interaction
itself, with your reply, and `_meta.callback` stands in for it. A command's payload has no `message_id`, not
even a `null` one: an interaction has no message. To tell one invocation
from another, use `_meta.interaction_id`.

Discord stops a command from being used where its settings don't allow it.
Past that, the bot does no check of its own on who runs a command, so a
receiver that serves only some users must check `_meta.user.id` itself.

### A test-fire

The admin's **Test webhook** button sends the same shape, with fixed
values:

| Field | Value |
|-------|-------|
| `content` | `(test fire from admin UI)` |
| `username` | `karyl-admin-test` |
| `avatar_url` | `""` |
| `_meta.test` | `true` |
| `_meta.behavior_id` | The behavior under test. |
| `_meta.user` | The placeholder `{ id: "0", username: "karyl-test", global_name: null, discriminator: "0", avatar: null }`, never the admin who pressed the button. |
| `_meta.attachments` | `[]`. |
| `_meta.captures` | `[]` (a message trigger's test). |
| `_meta.sub_command_name` / `sub_command_group` | The leaf's own path (a command's test). |

A test-fire also has its own [authentication](#test-fires).

## Authentication

The admin picks one of three modes for each webhook action:

| Mode | What the bot sends |
|------|--------------------|
| none | No authentication. Anyone who knows the URL can call it as the bot would. |
| `token` | The shared secret in `X-Plugin-Webhook-Token`, and an `X-Karyl-Nonce`. |
| `hmac` | `X-Karyl-Timestamp`, `X-Karyl-Nonce` and `X-Karyl-Signature`: an HMAC-SHA256 signature over the request. |

The secret is made by the bot. The admin sees it once, when authentication
is turned on or the secret is rotated, and puts it into the receiver.

### `hmac` mode

| Header | Value |
|--------|-------|
| `X-Karyl-Timestamp` | Unix time in seconds. |
| `X-Karyl-Nonce` | 32 random hex characters, new for each request. |
| `X-Karyl-Signature` | Lower-case hex of `HMAC_SHA256(secret, "<METHOD>:<path>:<ts>:<nonce>:<body>")`. |

- `<METHOD>` is `POST`.
- `<path>` is the path of the URL **as saved on the bot**, without the
  query string. A reverse proxy that rewrites the path does not change it:
  verify against the saved path, not the one you receive.
- `<body>` is the raw request body. Verify the bytes you received, before
  parsing them; a re-serialised JSON body will not match.

To verify a request:

1. Refuse it when `X-Karyl-Timestamp` is not a whole number, or is more
   than **300 seconds** away from your clock.
2. Compute the signature and compare it with `X-Karyl-Signature` in
   constant time (`crypto.timingSafeEqual`).
3. Only once the signature matches, refuse a nonce you have already seen
   (a replay), and remember this one until its timestamp is more than 300
   seconds old.

### `token` mode

Compare `X-Plugin-Webhook-Token` with your secret, in constant time. The
token proves only that the caller knows the secret: it does not protect
the body or stop a replay. Prefer `hmac` when you can.

The bot also sends `X-Karyl-Nonce` in token mode, so you can sign your
response in the same way as in `hmac` mode (optional, see below).

## Signing the response

In `hmac` mode the bot only accepts a signed response. The response
signature uses the same secret and the **request's** method, path and
nonce:

```
X-Karyl-Timestamp: <your current unix time, in seconds>
X-Karyl-Signature: HMAC_SHA256(secret, "<METHOD>:<path>:<ts>:<request nonce>:<response body>")
```

- `<ts>` is the response's own timestamp. It must be within 300 seconds of
  the bot's clock.
- `<request nonce>` is the `X-Karyl-Nonce` of the request you are
  answering. Binding it means that a response signed for one request — one
  user's login link, say — cannot be swapped into the answer to another.
- Sending `X-Karyl-Nonce` on the response is optional. If you send it, it
  must equal the request's.
- Sign an empty body too: `<response body>` is then the empty string.

A missing, stale or wrong signature fails the action
([Failures](#failures)).

In `token` mode signing the response is optional. A response that carries
`X-Karyl-Signature` is verified the same way, with the token as the key;
an unsigned one is accepted. When an unsigned response has a body, the
bot logs a warning that the reply was not authenticated (at most once in
a while per behavior).

## Test-fires

The **Test webhook** button exists so that an admin can check the URL,
the secret and the reply without a real user. A test must never pass for
a real request — think of a login service that would hand out a real
session. So it is told apart **in the signature**, not only by a flag a
receiver might forget to check:

| Mode | A test-fire |
|------|-------------|
| all | Carries `X-Karyl-Test: 1` and `_meta.test: true`. |
| `hmac` | Every signed string starts with `test:` — `HMAC(secret, "test:<METHOD>:<path>:<ts>:<nonce>:<body>")`. Your response must be signed the same way, `test:` included. |
| `token` | The token is in `X-Plugin-Webhook-Test-Token`, never in `X-Plugin-Webhook-Token`. |

A receiver that knows only the real scheme rejects a test, for example
with HTTP 401. That is correct: the admin sees the 401, which still shows
that the bot reaches the receiver. A receiver that wants to answer tests
verifies them under the test scheme, and answers with something harmless.
The test-fire result in the admin UI previews your reply, lists what the
reply rules changed, and says whether your response signature was
verified.

## Secret rotation

The admin can rotate a webhook's secret (`POST
/api/behaviors/:id/webhook-secret/rotate`). The new secret is shown once.
The old one stays valid for **24 hours**:

| Mode | During those 24 hours the bot sends |
|------|-------------------------------------|
| `token` | `X-Plugin-Webhook-Token: <new>` and `X-Plugin-Webhook-Token-Previous: <old>` (a test-fire: `X-Plugin-Webhook-Test-Token` and `X-Plugin-Webhook-Test-Token-Previous`) |
| `hmac` | The usual three headers, signed with the **new** secret, and `X-Karyl-Signature-Previous`: the same signature (same timestamp, nonce and body) made with the **old** secret |

The bot accepts a response signed with either secret. After 24 hours the
`-Previous` headers stop, and the old secret is no longer accepted.

Only one previous secret is kept. Rotating again within those 24 hours
keeps the secret that rotation replaced, and the one before it stops
working at once.

The standard headers switch to the new secret **at the moment of the
rotation**. A receiver that knows only the old secret and reads only the
standard headers rejects every request from then on. To rotate without
downtime:

1. Before the first rotation, make the receiver accept **either** header:
   check `X-Karyl-Signature` (or `X-Plugin-Webhook-Token`) against its
   secret and, if that fails, the `-Previous` header. The reference
   receiver below does this. You only need to do this once.
2. Rotate. The receiver still has the old secret and keeps accepting
   requests through the `-Previous` header. Its responses, signed with the
   old secret, are still accepted.
3. Within 24 hours, give the receiver the new secret. From then on the
   standard header matches. Do not rotate again before this step is
   done: a second rotation drops the secret the receiver still has.

## The reply (contract v1)

Your response body is the **reply**. It has the same shape as the body a
plugin sends to `interactions.respond` (without the token):

```json
{
  "content": "Taipei: 24°C, light rain",
  "embeds": [{ "title": "Forecast", "description": "…" }],
  "components": [
    { "type": 1, "components": [
      { "type": 2, "style": 5, "label": "Details", "url": "https://weather.example/taipei" }
    ] }
  ],
  "ephemeral": true,
  "flags": 4
}
```

Every field is optional. The earlier `{ content, embeds }` response is a
subset of this shape, so there is no version field.

| Field | Type | Rule |
|-------|------|------|
| `content` | string | Trimmed. Over 2000 characters it is cut and ends with a new line and `…(truncated)`. |
| `embeds` | array | Only these fields are kept: `title`, `description`, `url`, `color`, `timestamp`, `footer`, `image`, `thumbnail`, `author`, `fields`. Strings are cut to Discord's per-field limits, URLs that are not `http(s)` are dropped, and an embed keeps at most 25 fields. At most 10 embeds and 6000 characters across all of them: an embed that would pass 6000 is dropped, and a later, smaller one may still fit. |
| `components` | array | Action rows (`type: 1`) of **link buttons only** (`type: 2`, `style: 5`, a non-empty `label` cut to 80 characters, an `https://` `url` of at most 512 characters). At most 5 rows of 5 buttons. Anything else is dropped. |
| `ephemeral` | boolean | Who sees the reply. See below. |
| `flags` | integer | Only `SuppressEmbeds` (4) and `SuppressNotifications` (4096) are kept. Who sees the reply is never a flag. |
| `defer` | boolean | `true`: answer later with the callback token. A command keeps its "thinking…" placeholder, a message trigger shows "typing…", and the other fields are not shown. See [Answering later](#answering-later). |
| `attachments` | array | `[{ name, path }]`: files to send with the reply. See [Attachments](#attachments). |
| `direct_messages` | array | DMs to other users, sent after the reply. See [Direct messages](#direct-messages). |

- A field of the wrong type is ignored, except `attachments`: files are
  never dropped. Any other top-level field is ignored too. The bot logs
  either once per behavior, so you can see it.
- Mentions in a reply are never turned into pings: `<@id>` shows as a
  mention but notifies no one.
- The body may be at most **64 KiB**. A larger body fails the action.
- An empty body, or an object with nothing to show, means "no reply". On a
  command the bot then removes its "thinking…" placeholder.
- A body that is not JSON, or JSON that is not an object, fails the action.
- Answering a command by editing a placeholder keeps only `SuppressEmbeds`
  of the `flags`.

The test-fire result shows what these rules changed in your reply.

### Attachments

`attachments` is `[{ name, path }]`, the same shape a plugin gives
`interactions.respond`. `name` is the file's name in Discord (an embed
can show it as `attachment://<name>`); `path` is where the file is on
your receiver. The bot resolves `path` against the **origin** of the
webhook URL (scheme, host and port; not the URL's own path) and
downloads each file with a `GET`, before it shows the reply:

```json
{ "content": "Today's chart", "attachments": [{ "name": "chart.png", "path": "/files/chart.png" }] }
```

With the webhook URL `https://hooks.example/weather`, the bot fetches
`https://hooks.example/files/chart.png`.

- At most 5 files of at most **8 MiB** each, and **25 MiB** together.
  A file past either limit is cut off as it streams in.
- `path` is a plain path starting with a single `/`. `//host`, a full URL,
  a relative path, a backslash, a space or control character, and an
  encoded slash (`%2F`, `%5C`) are refused. `name` must not be empty or
  longer than 200 characters, and has no slash, backslash or control
  character.
- The download follows the webhook URL's rules: the same target rules
  (a private address only when the operator's allowlist has it), the
  checked address only, and no redirects — a 3xx is a failure.
- **Anything on that origin can be fetched.** The bot does not limit
  `path` to the webhook URL's own path, so whoever holds a run's callback
  token can have any path of your origin attached to a reply (a `respond`
  with `attachments`). Serve on that origin only what you mean to share
  — for example, put the webhook on a host or port of its own rather than
  beside an admin panel or internal API.
- The bot sends no credentials with the `GET`: use paths nobody can
  guess, or files that may be public.
- One 10-second limit covers the whole download of a reply — all its
  files together, not each one.
- The bot downloads at most 2 replies' files at a time. Another reply
  waits for its turn within its own 10 seconds, and fails if they run
  out first.
- A reply of only attachments is a reply, not "no reply".
- An `attachments` that is not an array of `{ name, path }` strings fails
  the action as a bad reply. A file the bot can't get — too many, a
  refused path or name, too large, a redirect, a non-2xx answer, or no
  answer in time — fails the action too (`attachment_failed` in the
  delivery log): the user gets the failure line, never the reply without
  its files.
- An edit that has files (a `respond` that edits the reply, or
  `edit_followup`) replaces **all** the message's earlier files with
  its own; an edit without `attachments` keeps them.
- A test-fire does not download the files.

### Direct messages

`direct_messages` is `[{ user_id, content, embeds, components, attachments }]`
(all but `user_id` optional): messages the bot DMs to users — other than
the person who triggered the behavior, or them too — after it showed the
reply. Each is read with the reply's rules above; its `attachments` come
from the webhook URL's origin like the reply's.

```json
{
  "content": "Ticket #42 opened.",
  "direct_messages": [{ "user_id": "123456789012345678", "content": "New ticket #42 from Mika." }]
}
```

- At most **5** direct messages per reply. A list that is not an array,
  is longer, or has an entry without a Discord user id in `user_id` or
  with nothing to send fails the action as a bad reply.
- Who may be DMed is the behavior's rule, set by the admin. With a **DM
  allowlist** (users and behavior groups): only them. Without one: a
  member of the server the behavior was triggered in; for a trigger in a
  DM with the bot, a member of any server the bot is in.
- At most **10 a minute** per behavior; a DM past it is not sent.
- The DMs go only once the reply was shown: not with `{"defer": true}`, a
  superseded answer, or a failed one. A reply of only `direct_messages`
  shows nothing to the user (on a command, the "thinking…" placeholder is
  removed, as for an empty reply).
- A test-fire sends no direct messages.
- Each DM has its own outcome; none fails the reply or the delivery. The
  bot keeps one row per DM in the behavior's DM log (who to, who
  triggered it, the outcome; 30 days), which the admin UI shows:

| Outcome | Meaning |
|---------|---------|
| `sent` | Discord took it. |
| `not_allowed` | The rule above does not allow this user. |
| `rate_limited` | Past the behavior's 10 a minute. |
| `attachment_failed` | Its attachments could not be downloaded. |
| `failed` | Discord refused it (the user's DMs are closed, unknown user, …). |

### Who sees the reply

Who sees a reply depends on the trigger. The order is: your response's
`ephemeral`, then the behavior's stored **reply visibility** (set by the
admin; it can be unset), then the trigger's default.

| Trigger | Default | `ephemeral: false` | `ephemeral: true` |
|---------|---------|--------------------|-------------------|
| Command | Only the user who ran it. | Posted in the channel. | Only the user who ran it. |
| Message in a DM with the bot | In the DM. | In the DM. | In the DM (ignored). |
| Message in a guild channel | In the channel. | In the channel. | Sent to the author as a DM, never in the channel. |

The stored reply visibility is `private` (a command: only the user who ran
it; a guild message: a DM to the author) or `public` (in the channel). It
is not used in a DM with the bot.

A command is acknowledged ("thinking…") while the bot waits for you. A
command whose stored visibility is `public` gets a public placeholder, and
any other command a private one. When your `ephemeral` differs from the
placeholder, the bot sends your reply as a new message and deletes the
placeholder.

## Answering later

A receiver that needs longer than 10 seconds, or wants to follow up, uses
the run's **callback token**. Every run, of a command or a message
trigger, gets one in `_meta.callback`:

| Key | Value |
|-----|-------|
| `token` | An opaque token for this run only. Not the Discord interaction token, which never leaves the bot. |
| `expires_at` | When it stops working (ISO 8601): **15 minutes** after the command was used (when Discord's own interaction token ends) or the message was sent. |
| `api_base` | The bot's public base URL. |

1. Answer the request within 10 seconds with `{"defer": true}`. On a
   command the user keeps seeing "thinking…"; on a message trigger the bot
   shows "typing…" where the reply will most likely go (the author's DM
   for a guild message whose stored visibility is private, else the
   channel). Anything else in that answer is not shown, and the delivery
   log marks the delivery *deferred*.
2. Then call the bot with `Authorization: Bearer <token>`, a JSON body and
   `POST <api_base>/api/plugin/<method>`:

| Method | Body | Does |
|--------|------|------|
| `interactions.respond` | a reply | The run's reply: fills a command's "thinking…" placeholder, or edits the reply already shown (your synchronous answer or an earlier `respond`). When the reply's visibility changes, or there is no reply yet (a message trigger, or an empty answer removed it), a new message takes its place. |
| `interactions.followup` | a reply | Sends a new message, placed like a reply. Answers `{ ok: true, id }`. |
| `interactions.edit_followup` | `message_id` and a reply | Edits a message this token sent with `followup`. |
| `interactions.delete_followup` | `message_id` | Deletes a message this token sent with `followup`. |

The body is a [reply](#the-reply-contract-v1) under the same rules as your
synchronous answer, with three differences: a component that is not a
link button is refused with `400` instead of dropped; a reply with nothing
to show is refused with `400`; and `defer` means nothing. Who sees it
follows [the same order](#who-sees-the-reply): a `public` command's
`respond` fills its public placeholder. `interaction_token`, which the
plugin form of these methods takes, may be left out and is ignored.
Each `respond` decides who sees it afresh — its own `ephemeral` first,
then the behavior's stored visibility — so a `respond` without
`ephemeral` after a public one goes back to the stored visibility (and
stays where the reply is when none is stored).

`respond` and `followup` take [`direct_messages`](#direct-messages) too,
sent after the reply, and answer their outcomes as
`direct_messages: [{ user_id, outcome }]`. One of only `direct_messages`
leaves the reply as it is (a `followup` then answers no `id`).
`edit_followup` refuses them with `400`.

A message trigger has no interaction, so the bot answers with messages of
its own: the first `respond` sends the reply — to the channel, or for a
private reply in a guild to the author's DM, never the channel — and
later ones edit that message (or, when the reply moves between the
channel and the DM, send it anew and delete the old one). In a DM with
the bot everything goes to that DM.

An edit — a `respond` that edits the reply, or `edit_followup` — changes
only the fields its body has: it cannot clear one the body leaves out,
and an empty one (`""`, `[]`) counts as left out.

- An unknown, revoked or expired token gets `401`. Any other
  `/api/plugin/*` path gets `403`: the token answers this run and nothing
  else.
- The token is revoked when the run fails (the user has already seen the
  failure line). Answering synchronously does not revoke it: you may still
  follow up.
- Once a `respond` has landed, the synchronous answer of the same run is
  not shown, even if it arrives later, and a late failure of that request
  shows no failure line: the user already has a reply, so the delivery is
  ok and marked deferred.
- Calls are rate-limited per token, that is per run (60 a minute); over
  it, `429`.
- A call the bot refuses (`callback_invalid`) or Discord refuses
  (`callback_failed`; `dm_failed` when a private reply could not be sent
  to the author as a DM) is a failed delivery of the behavior, and so is
  a call whose [attachments](#attachments) the bot can't get
  (`attachment_failed`, `400`, nothing shown). Attachments come from the
  run's webhook URL origin, as for the synchronous answer. A call that
  works is not logged.
- The token lives in the bot's memory: after a restart it is unknown.

## Failures

The action fails when:

- the URL is refused by the bot's target rules
  ([behaviors.md](behaviors.md#webhook-targets));
- the receiver cannot be reached, or does not answer within 10 seconds;
- the answer is a redirect (3xx; redirects are never followed) or another
  non-2xx status;
- the body is too large, is not JSON, or is not a JSON object;
- in `hmac` mode, the response signature is missing, stale or wrong (in
  `token` mode, only when a signature is present and wrong);
- the reply's [attachments](#attachments) can't all be downloaded;
- Discord refuses the reply, or an `ephemeral` reply in a guild cannot be
  sent to the author as a DM.

Then:

- The user gets a generic line ("couldn't be completed right now"),
  never your error text. Its language: on a command, the user's Discord
  language (else the server's); on a message in a guild, the server's
  preferred language; in a DM with the bot, English. It goes:

  | Trigger | Where the line goes |
  |---------|---------------------|
  | Command | Only the user who ran it. |
  | Message in a DM with the bot | The DM. |
  | Message in a guild channel | A DM to the author. If that DM fails too, nothing is said. A guild channel never sees a failure. |

- The detail goes to the bot event log, to the behavior's statistics and
  to its delivery log (status, latency and error code per call), which
  the admin UI shows. For a non-2xx answer, the detail is the first 500
  characters of your response body (300 in the delivery log), so don't
  put secrets in error bodies.
- There is no retry.

## Reference receiver

On Node.js 22 or later, the simplest receiver is the SDK's:
`npm i @karyl-chan/plugin-sdk`, then

```js
import http from 'node:http';
import { createReceiver } from '@karyl-chan/plugin-sdk/behavior-receiver';

const handler = createReceiver({
  mode: 'hmac',
  secret: process.env.KARYL_WEBHOOK_SECRET,
  path: '/hooks/weather', // the path of the URL saved on the bot
  answer: async (payload, { test }) => {
    if (test) return { content: 'Test received.', ephemeral: true };
    const [city] = payload._meta.captures ?? [];
    return { content: `Weather for ${city ?? 'your city'}: …` };
  },
});

http.createServer(handler).listen(8080);
```

It does what the code below does, and adds a shared nonce store,
several secrets of your own, and typed payloads; see the
[SDK README](../../../plugin-sdk/README.md#behavior-webhook-receivers).
The bot's tests run it through the same scenarios as the code below.

Not on Node, or without dependencies? Below is a complete receiver for
Node.js 18 or later, with none. It is short enough to port. It verifies
both modes and the test scheme, accepts the `-Previous` headers during a
rotation, refuses replays, and signs every response over the request's
nonce.

The bot's test suite runs this exact code block against the golden
vectors and against the bot's own webhook client
(`packages/bot/tests/behavior-webhook-protocol-doc.test.ts`). If you change
it here, run that test.

```js
// receiver.mjs: a minimal behavior webhook receiver (Node.js 18+, no dependencies)
import crypto from 'node:crypto';

const WINDOW_SECONDS = 300;

/** The string a signature covers. A test-fire's starts with "test:". */
function signedString({ test, method, path, ts, nonce, body }) {
  return `${test ? 'test:' : ''}${method}:${path}:${ts}:${nonce}:${body}`;
}

function hmacHex(secret, text) {
  return crypto.createHmac('sha256', secret).update(text).digest('hex');
}

/** Constant-time comparison. timingSafeEqual needs equal BYTE lengths. */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Checks one request from the bot.
 *   mode     'hmac' or 'token', as set on the behavior
 *   secret   the secret the admin UI showed
 *   path     the webhook URL's path as saved on the bot, without the query
 *   headers  lower-case header names (Node's req.headers)
 *   body     the raw body, exactly as received
 *   seen     a Map of nonces already used (replay protection)
 * Returns { ok: true, test, nonce } or { ok: false, reason }.
 */
export function verifyRequest({ mode, secret, path, headers, body, seen, now = Math.floor(Date.now() / 1000) }) {
  const test = headers['x-karyl-test'] === '1';
  const nonce = headers['x-karyl-nonce'];

  if (mode === 'token') {
    // A test-fire's token travels in its own header.
    const name = test ? 'x-plugin-webhook-test-token' : 'x-plugin-webhook-token';
    const ok = same(headers[name], secret) || same(headers[`${name}-previous`], secret);
    return ok ? { ok: true, test, nonce } : { ok: false, reason: 'token mismatch' };
  }

  const ts = headers['x-karyl-timestamp'];
  if (!ts || !nonce) return { ok: false, reason: 'missing signature headers' };
  // Number('soon') is NaN, and NaN > 300 is false: check the digits first.
  if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > WINDOW_SECONDS) return { ok: false, reason: 'stale timestamp' };
  const expected = hmacHex(secret, signedString({ test, method: 'POST', path, ts, nonce, body }));
  // During a rotation the new secret signs x-karyl-signature and the old one
  // x-karyl-signature-previous: accepting either lets you switch secrets at
  // your own pace.
  if (!same(headers['x-karyl-signature'], expected) && !same(headers['x-karyl-signature-previous'], expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  // The replay check comes after the signature check. A nonce is kept while
  // its request's timestamp is fresh, which can be past now + WINDOW_SECONDS.
  for (const [n, expiry] of seen) if (expiry < now) seen.delete(n);
  if (seen.has(nonce)) return { ok: false, reason: 'replayed nonce' };
  seen.set(nonce, Number(ts) + WINDOW_SECONDS);
  return { ok: true, test, nonce };
}

/** The headers that sign a response: over the REQUEST's nonce, "test:" for a test-fire. */
export function signResponse({ secret, path, nonce, test, body, now = Math.floor(Date.now() / 1000) }) {
  const ts = String(now);
  return {
    'x-karyl-timestamp': ts,
    'x-karyl-signature': hmacHex(secret, signedString({ test, method: 'POST', path, ts, nonce, body })),
  };
}

/**
 * A node:http request handler. answer(payload, { test }) returns the reply
 * ({ content, embeds, components, ephemeral, flags }), or null for none.
 */
export function createReceiver({ mode, secret, path, answer }) {
  const seen = new Map();
  return async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');

      const check = verifyRequest({ mode, secret, path, headers: req.headers, body, seen });
      if (!check.ok) {
        res.writeHead(401).end();
        return;
      }

      const reply = await answer(JSON.parse(body), { test: check.test });
      const out = reply ? JSON.stringify(reply) : '';
      // Required in hmac mode; in token mode optional, but verified when sent.
      const signature = signResponse({ secret, path, nonce: check.nonce, test: check.test, body: out });
      res.writeHead(200, { 'content-type': 'application/json', ...signature }).end(out);
    } catch {
      // Never let one request crash the process: an async handler's
      // rejection is unhandled, and Node exits on it.
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  };
}
```

Wiring it to a server:

```js
import http from 'node:http';
import { createReceiver } from './receiver.mjs';

const handler = createReceiver({
  mode: 'hmac',
  secret: process.env.KARYL_WEBHOOK_SECRET,
  path: '/hooks/weather', // the path of the URL saved on the bot
  answer: async (payload, { test }) => {
    if (test) return { content: 'Test received.', ephemeral: true };
    const [city] = payload._meta.captures ?? [];
    return { content: `Weather for ${city ?? 'your city'}: …` };
  },
});

http.createServer(handler).listen(8080);
```

## Changes in bot 2.0.0

Bot 2.0.0 (behaviors phase 1, [ADR 0003](../adr/0003-behavior-trigger-action-split.md))
changes the protocol. Update a receiver **before** the bot is upgraded:

- **BREAKING: the response signature is bound to the request nonce**
  (#102). In `hmac` mode, sign `<METHOD>:<path>:<ts>:<request nonce>:<body>`.
  The old nonce-less form, and a response signed over a nonce of your own,
  are refused. There is no transition period: a period with both forms
  accepted would keep the swap open for its whole length.
- **BREAKING: test-fires are signed as tests** (#101): the `test:` prefix
  in `hmac` mode, `X-Plugin-Webhook-Test-Token` in `token` mode, and a
  placeholder `_meta.user`. A receiver that knows only the real scheme now
  answers a test with 401, which is expected.
- **BREAKING: a response that is not JSON fails the action** (#140).
  Before, it became an empty reply.
- **BREAKING: public `http://` URLs are refused.** A public target must use
  `https://`. Private addresses need the operator's
  `WEBHOOK_PRIVATE_ALLOWLIST` ([behaviors.md](behaviors.md#webhook-targets)).
- **Behavior ids changed.** Migration 011 copied every behavior to new
  tables with new ids, so `_meta.behavior_id` is different after the
  upgrade.
- New: rate limits in bot DMs and on commands (5 per 10 s per user),
  beside the per-channel one in servers (#119).
- New: the reply model above (link buttons, `ephemeral`, `flags`, the
  limits), `_meta.captures` on message triggers, and
  `_meta.sub_command_name` / `_meta.sub_command_group` on commands.
- New: secret rotation with the `-Previous` headers (#99).
- New: `id` on each `_meta.attachments` entry, and `_meta.attachments` on
  commands, with the files of the `attachment` options (#152).
- New: `_meta.callback` on commands and message triggers, and the `defer`
  reply field, to answer later (#113).
- New: the `attachments` reply field, files the bot downloads from the
  webhook URL's origin (#156).
- New: the `direct_messages` reply field, DMs to other users under the
  behavior's DM allowlist or server membership (#157).
- Removed: conversation sessions and the `[BEHAVIOR:END]` marker. A reply
  never starts or ends a session.
