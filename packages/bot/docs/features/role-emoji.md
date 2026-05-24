# Role emoji

Let members claim a Discord role by adding a reaction emoji to a designated
message. Removing the reaction revokes the role. Typical uses: opt-in
notifications, self-assigned game roles, self-assigned interest categories.

Mappings are organised into **emoji groups**. A guild may have multiple
independent groups; each watched message is bound to exactly one group, and
reactions on that message resolve against the group's mappings.

## Quick flow

1. `/role-emoji group add name:<group>` — create an emoji group.
2. `/role-emoji add group:<group> emoji:<emoji> role:<role>` — define an
   emoji → role mapping inside the group.
3. Post an announcement message (or pick an existing one).
4. `/role-emoji watch message-id:<id> group:<group>` — register the message
   and bind it to the group. The bot adds the group's emojis as reactions.
5. A member adds a reaction — the bot grants the matching role.
6. The member removes the reaction — the bot revokes the role.

## Commands

All commands require the Discord `Manage Roles` permission, enforced via
`defaultMemberPermissions`.

### Group management

| Command | Description |
|---------|-------------|
| `/role-emoji group add name:<name>` | Create a group. Names are unique per guild. |
| `/role-emoji group remove name:<name>` | Delete a group. All mappings under it and all message bindings to it cascade-delete. |
| `/role-emoji group list` | List all groups and their mappings. |

### Mapping management

| Command | Description |
|---------|-------------|
| `/role-emoji add group:<group> emoji:<emoji> role:<role>` | Create an emoji → role mapping in the group. The same emoji may map to different roles in different groups, but only once per group. |
| `/role-emoji remove group:<group> emoji:<emoji>` | Remove a mapping. Existing reactions on watched messages are not stripped. |

`emoji` accepts a Unicode emoji (`👍`, `❤️`) or a custom emoji literal
(`<:name:id>` or `<a:name:id>` for animated).

### Message watching

| Command | Description |
|---------|-------------|
| `/role-emoji watch message-id:<id> group:<group>` | Register the message as a claim point and bind it to the group. The bot adds each mapped emoji as a reaction. |
| `/role-emoji stop-watch message-id:<id>` | Stop watching the message. Members keep any roles they have already claimed. |

Running `watch` again on an already-watched message rebinds it to the new
group and seeds the new group's reactions; reactions left over from the
old group are not removed automatically.

`message-id` is the Discord message ID: enable developer mode, then
right-click the message → Copy ID.

## Rules

### Emoji format support

The internal regex matches:

- Common Unicode emoji (copyright, registered, U+2000–U+3300 range,
  surrogate pair emoji).
- Custom emoji literals — `<:name:id>` and `<a:name:id>` (animated).

These types are not currently supported:

- ZWJ sequences (`👨‍👩‍👧‍👦`).
- Skin-tone modifiers (`👍🏽`).
- Regional flags (`🇹🇼`).

### Group binding resolution

When a reaction fires, the bot reads the message's single bound group
(`RoleReceiveMessage.groupId`) and looks up the mapping in that group only.
A miss is silently ignored. `groupId` is `NOT NULL`, enforced by the
schema.

## Required bot permissions

- `View Channels`
- `Read Message History` (to fetch messages)
- `Add Reactions` (to seed reactions)
- `Manage Roles` (to grant and revoke roles)

Discord requires the bot's highest role to outrank any role it manipulates.

## Storage

- `RoleEmojiGroup(id, guildId, name)` — emoji group. `(guildId, name)` is
  unique.
- `RoleEmoji(groupId, emojiId, emojiChar, emojiName, roleId, sortOrder)` —
  emoji → role mapping. `(groupId, emojiId, emojiChar)` is the primary
  key; `groupId` is a FK to `RoleEmojiGroup` with cascade delete.
  `sortOrder` is the group-local insertion order used when seeding
  reactions.
- `RoleReceiveMessage(guildId, channelId, messageId, groupId)` — watched
  message. `groupId` is `NOT NULL` and FK to `RoleEmojiGroup` with cascade
  delete; each message binds exactly one group.

## Source

| File | Purpose |
|------|---------|
| `src/modules/builtin-features/role-emoji/role-emoji.commands.ts` | Slash command handlers |
| `src/modules/builtin-features/role-emoji/role-emoji.events.ts` | Reaction add / remove handlers |
| `src/modules/builtin-features/role-emoji/role-emoji.model.ts` | Emoji → role mapping model |
| `src/modules/builtin-features/role-emoji/role-emoji-group.model.ts` | Group model |
| `src/modules/builtin-features/role-emoji/role-receive-message.model.ts` | Watched-message model |
