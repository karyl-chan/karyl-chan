# Operations runbook

Day-2 procedures: backup, logs, upgrades, common troubleshooting.

> The `docker compose … bot` commands below assume a deployment compose
> with a `bot` service. A ready-made compose example is not yet provided
> in-repo (to be added later) — see [`setup.md`](setup.md#docker-deployment).

## Database

SQLite, single file:

| Environment | Path |
|-------------|------|
| Local (no `SQLITE_DB_PATH`) | `./data/database.sqlite` |
| Docker container | `/usr/src/app/data/database.sqlite` |
| Docker bind-mount | `./data` → `/usr/src/app/data` (dev and Docker share the same file). |

### Backup

The Docker setup bind-mounts `./data`, so the host's
`./data/database.sqlite` is the same inode as the container's file. Copy
it directly:

```bash
cp ./data/database.sqlite ./backup/karyl-chan-$(date +%Y%m%d).sqlite
```

For an atomic snapshot of a live database, use `VACUUM INTO` instead of a
raw copy to avoid catching a half-written page:

```bash
docker compose exec bot sqlite3 /usr/src/app/data/database.sqlite \
  "VACUUM INTO '/usr/src/app/data/backup.sqlite'"
mv data/backup.sqlite ./karyl-chan-$(date +%Y%m%d).sqlite
```

### Restore

Stop the bot, overwrite the host file (the bind-mount picks up the
change), and start the bot:

```bash
docker compose stop bot
cp ./karyl-chan-20260422.sqlite ./data/database.sqlite
docker compose start bot
```

### Schema

| Table | Purpose |
|-------|---------|
| `TodoChannels` | Todo channel registrations. |
| `TodoMessages` | Todo entry records. |
| `PictureOnlyChannels` | Picture-only channel registrations. |
| `RoleEmojis` | Emoji → role mappings. |
| `RoleReceiveMessages` | Watched messages for role-emoji. |
| `RconForwardChannels` | RCON forward settings (with encrypted password). |
| `behavior_commands`, `behavior_definitions`, `behavior_webhook_actions` | Behaviors: commands, triggers + action sources, webhook actions (encrypted). |
| `behavior_stats`, `behavior_group_members` | Per-behavior forward stats; audience group lists. |
| `plugins` and `plugin_commands` | Plugin registry and commands. |
| `admin_roles` and `admin_role_capabilities` | Admin roles and capability tokens. |

This is a representative subset. The full schema is defined by the
Sequelize models under `src/modules/*/models/`. See
[Upgrades](#upgrades) for how `sequelize.sync()` handles schema changes.

## Logs

The container writes to stdout and stderr (Docker default):

```bash
docker compose logs -f bot                # follow
docker compose logs --tail 200 bot        # last 200 lines
docker compose logs --since 1h bot        # last hour
```

### Notable log lines

| Message | Meaning |
|---------|---------|
| `bot started` | Logged in to the gateway and finished slash command registration. |
| `Connection authenticated` (+ `connectionName` field) | RCON handshake succeeded. |
| `Received response` (+ `connectionName`, `bytes` fields) | RCON response received; the line records the body length only, never the contents. |
| `decryptSecret: unsupported pre-v2 encryption format detected` | The database holds a pre-v2 encrypted value that this build cannot decrypt. |
| `Cleaning up inactive connection` (+ `connectionName` field) | An idle RCON connection was reaped after the idle timeout (default 30 minutes). |
| `Unhandled promise rejection: ...` | An uncaught promise rejection that needs investigation. |

## Upgrades

### Upgrading the deployed version

Pull the new bot image (or new code, if your deployment compose builds
from source) and recreate the container:

```bash
docker compose pull bot && docker compose up -d bot   # published image
# or, for a source-building compose:
git pull && docker compose up -d --build bot
```

### Schema changes on upgrade

The schema is defined by the Sequelize models, and `sequelize.sync()`
creates missing tables at startup. `sync()` only **creates** missing
tables; it never ALTERs an existing table's columns or CHECKs. (It does
add a model's missing indexes to an existing table, which is why indexes
that depend on a migration live in that migration.)

Incremental schema changes are handled by an Umzug-backed migration runner
(`packages/bot/src/db-migrations.ts`), called on every boot right after
`sync()` (`runMigrations(sequelize, "main")` in `main.ts`). Applied
migrations are tracked in the `SequelizeMeta` table:

- **Fresh install.** `sync()` builds the current table shapes; the runner
  then runs every `src/migrations/NNN-*` file, each of which is a no-op
  against the current shapes (a migration on a table that no longer
  exists skips itself).
- **Existing DB schema changes.** Add `src/migrations/NNN-short-name.ts`
  with an `up(ctx)` (optional `down(ctx)`); the runner applies it on next
  boot in filename-lexical order. See `src/migrations/README.md`.
- **Upgrading to 2.0.0** runs behavior migrations that cannot be
  undone: see [Upgrading to 2.0.0](#upgrading-to-200-behaviors-phase-1).
- **Pre-v2 DB compatibility.** The one-time encryption-v2 uplift
  migration is gone; this build can only decrypt v2 ciphertexts.
  Restoring a pre-v2 backup will throw when reading an encrypted
  column. See [Encryption / decryption errors](#encryption--decryption-errors).

### Upgrading to 2.0.0 (behaviors phase 1)

Bot 2.0.0 rebuilds behaviors as triggers bound to actions
([ADR 0003](adr/0003-behavior-trigger-action-split.md),
[behaviors.md](features/behaviors.md)). Its migrations change the
database in ways that **cannot be undone**, and it changes the webhook
protocol for receiver authors.

**Before upgrading:**

1. **Back up the database** ([Backup](#backup); on Postgres, `pg_dump`
   the `DB_URL` database). The only way back to 1.x is restoring that
   backup.
2. **Update every webhook receiver** for the BREAKING protocol changes
   listed in
   [Changes in bot 2.0.0](features/behavior-webhook-protocol.md#changes-in-bot-200)
   (nonce-bound response signatures and test-fire signing among them).
   A deployment with no custom behaviors (only the login) has nothing to
   update.
3. A private-network webhook target needs `WEBHOOK_PRIVATE_ALLOWLIST`
   ([webhook targets](features/behaviors.md#webhook-targets));
   `WEBHOOK_ALLOW_PRIVATE` is deprecated.

**The migrations** run once, at the first boot, in order:

| Migration | Does | Reversible |
|-----------|------|------------|
| 010 | Removes conversation sessions: deletes the `manual` and `break` system behaviors and their stats, turns continuous behaviors into one-shot ones, drops `behavior_sessions`. The login is untouched. | No |
| 011 | Moves `behaviors` + `behavior_scope_tabs` to `behavior_commands`, `behavior_definitions` and `behavior_webhook_actions` (details below), rebuilds `behavior_stats` against the new table, removes stored `behavior:<scopeKey>.manage` grants, then drops the old tables. One transaction; a re-run is a no-op. | No |
| 012 | Adds the previous-secret columns for webhook secret rotation. | Yes |
| 013 | Deletes audience group member lists that no message trigger uses. | No |
| 014 | Adds `behavior_definitions.replyVisibility` (null: the trigger's default). | Yes |

Migration 011 in detail:

- The login keeps its trigger exactly; a trigger that cannot be expressed
  any more becomes the default DM `!login`. The login is never dropped.
- Every copied behavior gets a **new id**, so a webhook's
  `_meta.behavior_id` changes.
- A message pattern that fired in both bot DMs and servers becomes two
  triggers; its stats follow only the bot DM one. If it was limited to a
  user or an audience group, only the bot DM half is kept (with the
  audience); a server-only pattern with such an audience is dropped.
- A slash command registered for all servers becomes a global command
  usable only in servers.
- Dropped: slash commands limited to a user, an audience group or a
  channel (Discord cannot express them), patterns that only matched in
  group DMs (the bot never receives those), custom rows without a
  webhook URL, and slash commands whose name or shape Discord would
  refuse or whose name an enabled row already holds.
- Each dropped row is listed in the bot event log as
  `migration 011: …`; the removed grants are logged as one count.

**Other breaking changes in 2.0.0:**

- Roles that relied on `behavior:<scopeKey>.manage` lose behavior
  access; the module needs `behavior.manage` (or `admin`).
- The behavior admin API changed: scope-tab routes are gone, the write
  routes take the new shapes, unknown fields are refused, errors are
  `{ error: { code, message, field? } }`, and reads no longer return
  webhook secrets (`secretSet` instead). See the
  [write API](features/behaviors.md#write-api).
- Only a bot owner can change the login's trigger.

**After upgrading:**

- Check that the login still works (by default, DM the bot `!login`).
- Read the `migration 011` and `migration 013` lines in the bot event
  log for anything dropped.
- Commands re-register with Discord when the bot connects. Check that
  behavior commands appear where expected, and that no `/manual` or
  `/break` command is left.

### Dependency audit

```bash
pnpm audit --prod             # production-only vulnerabilities
pnpm audit --fix              # attempt automatic fixes (breaking upgrades need testing)
```

## Troubleshooting

### Boot log shows `Unhandled promise rejection: Error: Used disallowed intents`

Privileged intents are not enabled in the Discord developer portal. See
[`setup.md`](setup.md#discord-bot-setup), step 3.

### Slash commands not visible in a guild

- Confirm the bot started successfully — look for `bot started`.
- Confirm the invite URL included the `applications.commands` scope.
- Confirm the calling member has the slash command's
  `defaultMemberPermissions`, or that an override exists in
  Server Settings → Integrations.
- Refresh the Discord client (`Ctrl+R`).

### RCON configured but nothing happens

1. `/rcon-forward-channel status` confirms the configuration exists.
2. Verify the trigger prefix matches (default `/`).
3. Read the container log; the bot logs `Connection authenticated` on
   handshake.

### RCON connection keeps failing

- Confirm the RCON target is reachable from the bot container
  (`docker exec bot ping <host>`).
- Confirm the `karyl-chan-net` network exists and the game server's
  container is attached to it.
- Verify the RCON server is listening on the right port with the right
  password.
- If the host is a cloud metadata endpoint, the host policy rejects it
  by design.

### Encryption / decryption errors

- `ENCRYPTION_KEY is not set` — the environment variable is missing.
- `ENCRYPTION_KEY must be 32 bytes` — the key has the wrong length;
  regenerate with `openssl rand -hex 32`.
- `Unsupported state or unable to authenticate data` — GCM tag
  verification failed. Common causes:
  - The key was rotated but the encrypted password was not re-entered
    (use `/rcon-forward-channel edit`).
  - The ciphertext was truncated or tampered with.

### Discord command permissions look wrong

- Confirm the role has the slash command's required
  `defaultMemberPermissions` (see [`permissions.md`](permissions.md)),
  or override the command in Server Settings → Integrations.
- Confirm the member actually has that role in the right guild.

### Admin web capability not taking effect

- Confirm the admin role carries the relevant capability token (in the
  admin role-permission page).
- Role and capability changes take up to `ADMIN_SESSION_CACHE_TTL_MS`
  (default 30 seconds) to propagate.

## Container behaviour

### Restart policy

Set `restart: unless-stopped` on the bot service in your deployment compose:
the container is then restarted automatically after a crash; it stays down
after a manual `docker compose stop`.

### Data volume

The DB file lives in a bind mount at `./data/database.sqlite` in the
project. `docker compose down -v` does **not** delete it (the host file
is outside Docker's volume scope). To wipe data: stop the bot, then
`rm ./data/database.sqlite`.
