# Setup and deployment

The bot is packaged as `@karyl-chan/bot` and lives at `packages/bot/` in
the karyl-chan pnpm monorepo.

## Requirements

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | `>= 22` | Not needed if you run only the Docker deployment. |
| pnpm | pinned by the monorepo `packageManager` | Install via `corepack enable`. |
| Docker / Compose | 24+ | Required for the Docker deployment path. |
| Discord bot token | n/a | See [Discord bot setup](#discord-bot-setup). |

## Discord bot setup

1. Create an Application in the
   [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Bot**, create a bot and copy the token.
3. Enable the privileged gateway intents:
   - `SERVER MEMBERS INTENT`
   - `MESSAGE CONTENT INTENT`
4. Generate an invite URL (**OAuth2 → URL Generator**):
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Manage Channels`, `Manage Messages`,
     `Manage Roles`, `Add Reactions`, `Read Message History`,
     `Send Messages`, `View Channels`, `Connect`, `Speak`
5. Use the URL to add the bot to your guild.

## Environment variables

Configuration lives in `packages/bot/.env` (copy from `.env.example`).
The main variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | yes | Discord bot token. |
| `ENCRYPTION_KEY` | yes (production) | 32-byte hex string used to encrypt RCON passwords, webhook secrets, and so on. Generate with `openssl rand -hex 32`. |
| `BOT_OWNER_IDS` | yes (production) | Comma-separated Discord user IDs of bot owners. Each listed user can invoke `/login` in DM with the bot to obtain an admin login link without needing an `authorized_users` row. Unset (and `BOT_OWNER_ID` also unset) → `/api/*` runs without authentication (local dev only). |
| `BOT_OWNER_ID` | no | Legacy single-owner alias. Used only when `BOT_OWNER_IDS` is unset; prefer the plural form for new deployments. |
| `WEB_PORT` | no | HTTP port the admin API listens on. Default `3000`. |
| `WEB_BASE_URL` | no | Public base URL. Admin login links and the plugin proxy use this as their base. |
| `NODE_ENV` | no | Default `development`. |
| `SQLITE_DB_PATH` | no | SQLite file path. Default `<bot>/data/database.sqlite`. |
| `CERTS_DIR` and `TRUSTED_PROXY` | no | HTTPS certificate path and reverse-proxy trust settings. |

`.env.example` also exposes many optional tuning knobs (JWT TTLs, plugin
timeouts, RCON, rate limits). They all have sensible defaults; the
comments in `.env.example` describe each one.

```bash
cd packages/bot
cp .env.example .env
# Edit .env with the real values.
```

## Local development

```bash
# From the monorepo root
pnpm install
cd packages/bot
pnpm start             # nodemon + ts-node, reloads on save
pnpm test              # unit tests
pnpm build             # compile to build/
```

See [`development.md`](development.md) for the full development guide.

## Docker deployment

A Docker Compose deployment example is not yet provided in-repo (to be
added later). When deploying, note:

- The bot image is published to `ghcr.io/<owner>/karyl-chan-bot` on every
  push to `main` (`:edge`) and every release (`:<version>` + `:latest`), so
  a deployment compose can pull that image rather than build from source.
- The container needs the `packages/bot/.env` configuration, a bind mount
  for the SQLite data directory (`./data/database.sqlite`), and — if
  `CERTS_DIR` is set — the certificate directory.

## Installing plugins

Plugins are separate services that self-register with the bot. The whole
operator journey (secret → compose wiring → verify → enable → per-guild
features) is in the [plugin operator guide](operator-guide.md).

## First-run checklist

1. The container log emits `bot started`.
2. `/api/health/ready` returns `200` (this is what the container's
   healthcheck looks at).
3. Typing `/` in a guild shows the bot's slash commands.
4. If RCON is configured, `/rcon-forward-channel watch` opens the modal.
5. A user listed in `BOT_OWNER_IDS` invokes the `/login` slash command
   in DM with the bot and receives an admin login link.

## Upgrades

The DB schema is defined by Sequelize models and built at startup via
`sequelize.sync()` (creates missing tables), followed by an Umzug-backed
migration runner for incremental schema changes (`src/db-migrations.ts`,
tracked in `SequelizeMeta`). Upgrade-time schema notes (including the caveat
that `sync()` never ALTERs existing tables, and the "pre-v2 encrypted values
are not supported" caveat) are in the
[operations runbook](operations.md#upgrades).
