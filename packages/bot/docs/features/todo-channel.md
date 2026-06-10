# Todo channel

Turn a Discord channel into a shared todo list. A message that mentions
someone is treated as a todo entry; any reaction on that message marks it
done.

## Quick flow

1. Run `/todo-channel watch` in the channel you want to use as a list.
2. Members post messages mentioning users; each becomes a todo entry.
3. Anyone reacts to a message — the entry is marked done.
4. A member mentions the bot — the bot lifts all incomplete todos to the
   bottom of the channel.
5. Run `/todo-channel stop-watch` to disable.

## Commands

All commands require the Discord `Manage Channels` permission, enforced via
`defaultMemberPermissions`.

| Command | Description |
|---------|-------------|
| `/todo-channel watch` | Register the current channel as a todo list. Idempotent — re-running on an already-watched channel returns "No action". |
| `/todo-channel stop-watch` | Stop watching the current channel. Only the channel registration is removed; existing todo records are left in place (pruned lazily on a later rotation if the channel is re-watched). |
| `/todo-channel check-cache` | Scan the last 100 messages in the channel and register any qualifying ones as todos. Use this to catch up after bot downtime. |

## Rules

### What counts as a todo

On the realtime `messageCreate` path, any non-bot message in a watched
channel that does **not** @-mention the bot is recorded as a todo (the
@-mention-the-bot case is reserved for the done/rotation handling).

The stricter filters below apply only to the `/todo-channel check-cache`
backfill:

- The author is not a bot.
- The message mentions at least one member.
- The message does not only mention the bot (replies are exempt from this
  exclusion).

### What counts as done

- Any reaction on the message — including reactions the bot adds itself.
- Removing all reactions re-marks the message as incomplete.

### Mentioning the bot

When a member posts in a todo channel and mentions the bot:

1. The bot fetches all incomplete todos in the channel.
2. For each todo:
   - If the original message already has a reaction or no longer mentions
     anyone — drop the entry.
   - If it is a bot-reposted copy — delete it and clear the record.
   - If the original has a thread — leave a reply pointing to it.
   - Otherwise — repost the message (with attachments) at the bottom of the
     channel and delete the original.
3. The triggering "@bot" message is deleted.

### Reply semantics

When a todo is marked done by a reply-style reaction, the bot adds 👍 to the
replied-to message (and removes it on un-reaction). This wires
"reply equals done" into a visible signal.

## Required bot permissions

- `View Channels`
- `Send Messages`
- `Manage Messages` (to delete stale todos)
- `Read Message History`
- `Add Reactions`

## Storage

- `TodoChannel(channelId, guildId)` — which channels are watched.
- `TodoMessage(messageId, channelId, guildId, createdAt)` — one record per
  todo entry.

## Source

| File | Purpose |
|------|---------|
| `src/modules/builtin-features/todo-channel/todo-channel.commands.ts` | Slash command handlers |
| `src/modules/builtin-features/todo-channel/todo-channel.events.ts` | `messageCreate` and reaction handlers |
| `src/modules/builtin-features/todo-channel/todo-channel.model.ts` | Channel registration model |
| `src/modules/builtin-features/todo-channel/todo-message.model.ts` | Per-todo record model |
