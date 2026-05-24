# Picture-only channel

Restrict a Discord channel to messages that carry an attachment. Plain-text
messages are deleted automatically. Useful for showcase, meme, or screenshot
channels.

## Quick flow

1. Run `/picture-only-channel watch` in the target channel.
2. Plain-text messages in the channel are deleted as soon as they are sent.
3. Messages with any attachment are kept (the message body text is not
   constrained).
4. Run `/picture-only-channel stop-watch` to remove the restriction.

## Commands

Both commands require the Discord `Manage Channels` permission, enforced via
`defaultMemberPermissions`.

| Command | Description |
|---------|-------------|
| `/picture-only-channel watch` | Register the current channel as picture-only. |
| `/picture-only-channel stop-watch` | Remove the restriction. |

## Rules

### Attachment detection

A message is kept when `message.attachments.size > 0`. That covers images,
videos, audio, and files. Discord stickers and embeds do not count as
attachments and do not satisfy the rule on their own.

### Exemptions and edge cases

- Messages the bot posts itself are subject to the same rule.
- Enforcement runs through `messageCreate`; messages sent while the bot is
  offline are not retroactively deleted.
- A reply that adds text to an image-bearing message but carries no
  attachment of its own is deleted.

## Required bot permissions

- `View Channels`
- `Read Message History`
- `Manage Messages` (to delete violating messages)

## Storage

- `PictureOnlyChannel(channelId, guildId)` — which channels are watched.

## Source

| File | Purpose |
|------|---------|
| `src/modules/builtin-features/picture-only/picture-only-channel.commands.ts` | Slash command handlers |
| `src/modules/builtin-features/picture-only/picture-only-channel.events.ts` | `messageCreate` filter |
| `src/modules/builtin-features/picture-only/picture-only-channel.model.ts` | Channel registration model |
