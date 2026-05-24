# Operations runbook

Day-2 procedures: backup, logs, upgrades, common troubleshooting.

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
| `behaviors` and `behavior_scope_tabs` | Behavior rules and scope tabs. |
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
| `Connection authenticated: <host>:<port>` | RCON handshake succeeded. |
| `Received response from <host>:<port> (N bytes)` | RCON response received; the line records the body length only, never the contents. |
| `decryptSecret: unsupported pre-v2 encryption format detected` | The database holds a pre-v2 encrypted value that this build cannot decrypt. |
| `Cleaning up inactive connection: <host>:<port>` | An idle RCON connection was reaped after 30 minutes. |
| `Unhandled promise rejection: ...` | An uncaught promise rejection that needs investigation. |

## Upgrades

### Upgrading the deployed version

The shipped `docker-compose.yml` builds from source. Upgrade by pulling
new code and rebuilding:

```bash
git pull
pnpm docker:up        # docker compose up -d --build
```

### Schema changes on upgrade

The schema is defined by the Sequelize models, and `sequelize.sync()`
creates missing tables at startup. `sync()` only **creates** missing
tables; it never ALTERs an existing table (no column additions, no index
changes, no CHECK changes).

The old Umzug migration system has been removed. There is currently **no
mechanism** for evolving the schema of an existing database:

- **Fresh install.** `sync()` builds the full and correct schema in one
  step; nothing else to do.
- **Existing DB schema changes.** No automatic mechanism — ALTER
  manually. The long-term policy is unresolved (see the
  `TODO(schema-evolution)` note in `packages/bot/src/main.ts`).
- **Pre-v2 DB compatibility.** The one-time encryption-v2 uplift
  migration is gone; this build can only decrypt v2 ciphertexts.
  Restoring a pre-v2 backup will throw when reading an encrypted
  column. See [Encryption / decryption errors](#encryption--decryption-errors).

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

`docker-compose.yml` sets `restart: unless-stopped`. The container is
restarted automatically after a crash; it stays down after a manual
`docker compose stop`.

### Data volume

The DB file lives in a bind mount at `./data/database.sqlite` in the
project. `docker compose down -v` does **not** delete it (the host file
is outside Docker's volume scope). To wipe data: stop the bot, then
`rm ./data/database.sqlite`.
