# @karyl-chan/bot

A Discord bot that combines three concerns in one process:

- **Discord client** — runs slash commands and event handlers for the builtin
  features (todo channel, picture-only channel, role emoji, RCON forward,
  voice).
- **Admin web panel** — HTTP API plus a nested Vue SPA at
  `packages/bot/frontend/` for managing guilds, the DM inbox, permissions,
  plugins, and system settings.
- **Plugin host** — external plugins run as separate processes and interact
  with the bot through HMAC-signed RPC.

The package lives at `packages/bot` in the karyl-chan monorepo.
Workspace-level commands (install, build, publish) are documented in the root
[`README.md`](../../README.md).

## Quick start

```bash
# From the monorepo root
pnpm install
cd packages/bot
cp .env.example .env        # fill in BOT_TOKEN, ENCRYPTION_KEY, ...
pnpm start                  # nodemon watch mode

# Or, from the monorepo root, to run in Docker
pnpm docker:up              # build + start, wait for healthy
```

See [`docs/setup.md`](docs/setup.md) for the full setup walkthrough.

## Documentation

### Setup and operations

| Topic | Path |
|-------|------|
| Setup and deployment | [`docs/setup.md`](docs/setup.md) |
| Operations runbook (backup, logs, upgrade, troubleshooting) | [`docs/operations.md`](docs/operations.md) |

### Permission model

| Topic | Path |
|-------|------|
| Discord command permissions and capability tokens | [`docs/permissions.md`](docs/permissions.md) |

### Features

| Feature | Path |
|---------|------|
| Todo channel | [`docs/features/todo-channel.md`](docs/features/todo-channel.md) |
| Picture-only channel | [`docs/features/picture-only-channel.md`](docs/features/picture-only-channel.md) |
| Role emoji | [`docs/features/role-emoji.md`](docs/features/role-emoji.md) |
| RCON forward channel | [`docs/features/rcon-forward-channel.md`](docs/features/rcon-forward-channel.md) |
| Voice | [`docs/features/voice.md`](docs/features/voice.md) |
| Behaviors (Discord trigger → action rules) | [`docs/features/behaviors.md`](docs/features/behaviors.md) |

### Development

| Topic | Path |
|-------|------|
| Development guide (scripts, structure, tests, CI) | [`docs/development.md`](docs/development.md) |
| Architecture (modules, dependency rules, SOPs for adding code) | [`docs/architecture.md`](docs/architecture.md) |
| Plugin protocol (bot side: authentication, dispatch, RPC) | [`docs/development/plugin-guide.md`](docs/development/plugin-guide.md) |
