# RCON forward channel

Forward Discord channel messages to a game server's RCON interface
(Minecraft, Source RCON-compatible servers, and so on). A member sends a
message with a configured prefix; the bot translates it into an RCON
command, sends it to the game server, and posts the response back into the
channel.

## Quick flow

1. Set the `ENCRYPTION_KEY` environment variable. Without it the feature
   cannot operate; see [`../setup.md`](../setup.md#environment-variables).
2. Run `/rcon-forward-channel watch` in the channel that should act as the
   forward entry point.
3. A modal collects host, port, password, trigger prefix, and command
   prefix.
4. Members send messages starting with the trigger prefix; the bot
   forwards them.
5. Run `/rcon-forward-channel stop-watch` to remove the forward.

## Commands

All four commands require the Discord `Manage Channels` permission,
enforced via `defaultMemberPermissions`.

| Command | Description |
|---------|-------------|
| `/rcon-forward-channel watch` | Open the configuration modal. Creates a new record if the channel is unconfigured; returns "No action" if one already exists (use `edit`). |
| `/rcon-forward-channel stop-watch` | Disable forwarding for the current channel. Existing RCON connections persist until the 30-minute idle cleanup. |
| `/rcon-forward-channel status` | Show the current configuration. Password is masked as `••••••••`. |
| `/rcon-forward-channel edit` | Re-open the modal pre-filled with existing values. The password field is blank — leave it empty to keep the existing password. |

### Modal fields

| Field | Required | Description |
|-------|----------|-------------|
| Host | yes | RCON target host or IP. Container names, private IPs, and public IPs are accepted; cloud metadata endpoints are rejected. |
| Password | yes | RCON password. Stored encrypted with AES-256-GCM. |
| Port | yes | RCON port. Default `25575` (Minecraft). |
| Trigger prefix | yes | Channel message prefix that triggers a forward. Default `/` (for example, `/list`). |
| Command prefix | no | Prefix sent to RCON. Default `/`. Set to empty to strip the prefix entirely. |

### Triggering a forward (no command)

When a member sends a message starting with the trigger prefix in a
watched channel, the bot:

1. Replaces the trigger prefix with the command prefix (`/list` → `/list`
   when they match).
2. Checks the per-channel rate limit (max 10 forwards per minute).
3. Sends the command to RCON and posts the response back into the channel.

There is no extra capability check on the trigger; any member who can send
messages in the channel can trigger a forward. To restrict use, adjust the
channel's Discord send-message permissions.

## Security

### Password encryption at rest

- Stored as `v2:<keyId>:<iv>:<tag>:<ct>` (the four segments after the
  version are base64). AES-256-GCM, key from `ENCRYPTION_KEY`. The
  `keyId` supports key rotation.
- The plaintext is decrypted only at forward time. Slash commands and
  logs never reveal it.
- This build does not accept pre-v2 (v0 plaintext or v1 ciphertext)
  values. Restoring a pre-v2 backup requires re-entering passwords with
  `/rcon-forward-channel edit`.

### Host policy

`src/utils/host-policy.ts` blocks these targets:

- Cloud metadata / link-local endpoints (`169.254.0.0/16`, `fe80::/10`,
  `168.63.129.16`, `100.100.100.200`, `192.0.0.192`, `fd00:ec2::254`),
  including when spelled as IPv4-mapped, NAT64 (`64:ff9b::/96`) or 6to4
  (`2002::/16`) IPv6.
- Metadata hostnames (`metadata.google.internal`, and so on).
- Hostnames that are not IP literals are resolved first; if any DNS
  answer is in a blocked range, the whole host is rejected.

Private ranges (`10.x`, `172.16.x`, `192.168.x`, `localhost`, Docker
container names) are allowed. Those are the legitimate "manage my own
infrastructure" targets. There is no allowlist for RCON, and none is
needed: every non-blocked address is allowed.

The host is resolved once per connect (`resolveAllowedTarget`), and
the connection goes only to the addresses that passed the check
(`rcon-forward/pinned-rcon.ts`: the socket's `lookup` answers with the
vetted addresses instead of asking DNS, the same pinning behavior
webhooks use). A DNS answer that changes between check and connect (DNS
rebinding) therefore cannot redirect it. Every vetted address is
offered, so when the first is unreachable (for example `localhost`
answering `::1` first while the server listens on `127.0.0.1` only)
the connect still falls back to the next one. RCON is plain TCP, with no
TLS, SNI or Host header. Embeds, logs and the bot event log show the
configured hostname.

### De-identified errors

RCON-layer errors (connection refused, handshake failures, timeouts) are
written to the container log but never echoed into Discord. The channel
only sees stable messages, so the RCON target cannot be used as a
port-scan proxy:

- "RCON Error" for a socket error.
- "Connection Lost (n/3)" for each retry, after an error, a server close
  or a timeout.
- "Connection Failed" when the retries run out.
- "Connection Error" when the first connect cannot resolve the host or
  the host policy refuses it (a later attempt counts as a failed retry
  instead), or when the connection is closed (for example by cleanup)
  before a waiting message was sent. A host-policy refusal shows the
  policy's message.

### Rate limiting

Up to 10 forwards per channel per minute. Over-limit messages get a
"Rate Limited" reply and do not count toward the over-limit total. See
`src/utils/rate-limiter.ts`.

### Reconnect policy

Each connect attempt has 10 seconds to open the socket and authenticate. An
attempt that runs out is closed at once and counts as a failure.

A socket error and the server closing the connection both count as
failures, whether the connection had authenticated or was still on its
first connect, and so does a client the server closes right after
connecting. Failures are retried with exponential backoff
(`min(1000 · 2^n, 30s)`, so 2s → 4s → 8s) for up to three attempts. After
three failures the connection closes, its queued commands are dropped and
every channel using it is notified ("Connection Failed"). A reconnect that
authenticates again resets the count, so the next drop gets three fresh
attempts. Connections idle for 30 minutes are cleaned up.

Messages sent while the connection is being made (first connect or
reconnect) wait or are queued. Their commands go out once it
authenticates. Every channel with a message waiting gets the notices
above, each once. Messages that were still waiting when the retries run
out are dropped with the "Connection Failed" notice.

Every attempt resolves and checks the host again, then connects a new
client to the fresh answers only, so a container that restarted with a
new IP is reached at the new IP. The replaced client's late socket events
are ignored. If DNS fails, or the host policy now refuses the
host (an answer has become a metadata / link-local address), that
attempt fails without connecting and the next attempt follows.

## Required bot permissions

- `View Channels`
- `Send Messages` (to post the RCON response)
- `Read Message History`

## Storage

- `RconForwardChannel(channelId, guildId, commandPrefix, triggerPrefix, host, port, password)` —
  the `password` column holds the `v2:keyId:iv:tag:ct` ciphertext described
  above.

## Source

| File | Purpose |
|------|---------|
| `src/modules/builtin-features/rcon-forward/rcon-forward-channel.commands.ts` | Slash commands + modal |
| `src/modules/builtin-features/rcon-forward/rcon-forward-channel.events.ts` | `messageCreate` trigger + idle cleanup |
| `src/modules/builtin-features/rcon-forward/rcon-connection.service.ts` | RCON connection pool, reconnect logic, event dispatch |
| `src/modules/builtin-features/rcon-forward/pinned-rcon.ts` | RCON client pinned to the vetted addresses |
| `src/modules/builtin-features/rcon-forward/rcon-queue.service.ts` | Per-channel rate limiting and queueing |
| `src/utils/crypto.ts` | Password encryption / decryption |
| `src/utils/host-policy.ts` | Metadata-endpoint blocking + DNS check; returns the vetted addresses |
| `src/utils/rate-limiter.ts` | Per-channel rate limiter |
| `src/modules/builtin-features/rcon-forward/rcon-forward-channel.model.ts` | Sequelize model |
