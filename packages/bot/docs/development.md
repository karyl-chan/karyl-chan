# Development guide

`@karyl-chan/bot` is one package in the karyl-chan pnpm monorepo at
`packages/bot/`. This guide covers bot-package development. Workspace-level
commands (install, build, publish) live in the root
[`README.md`](../../../README.md).

## Requirements

- Node.js `>= 22` (enforced by `engines`).
- pnpm — pinned by the root `packageManager`; install via
  `corepack enable`.
- C/C++ toolchain — `sqlite3` and `@discordjs/opus` build from source.
  Without one, use Docker development instead.

## Quick start

```bash
# From the monorepo root
pnpm install
cd packages/bot
cp .env.example .env       # fill in BOT_TOKEN, ENCRYPTION_KEY, ...
pnpm start                 # nodemon watch mode; reloads on save
```

Any script can also be invoked from the monorepo root with a filter:
`pnpm --filter @karyl-chan/bot <script>`.

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm build` | `tsc` — emits compiled JS into `build/` (used by `serve` and Docker). |
| `pnpm dev` | Run `src/main.ts` once with `ts-node/esm/transpile-only` (no watch). |
| `pnpm start` | `nodemon` watch mode; reloads on save. |
| `pnpm serve` | Run the compiled `build/main.js` (production). |
| `pnpm test` | Run all vitest tests. |
| `pnpm test:watch` | vitest watch mode. |
| `pnpm test:typecheck` | `tsc -p tsconfig.test.json --noEmit`; type-checks `tests/`. |
| `pnpm frontend:build` / `pnpm frontend:test` | Build / test the nested frontend. |
| `pnpm preflight` | `build` + `test:typecheck` + `test` + frontend build/test in one go. |

## Project layout

Full architecture is documented in [`architecture.md`](architecture.md).
Top-level shape:

```
src/
  db.ts                        # Sequelize singleton
  main.ts                      # entry point
  config.ts / config-metadata.ts / logger.ts
  bootstrap-events.ts          # central registration of Discord events
  bootstrap-in-process.ts      # central registration of in-process slash commands
  types/                       # ambient declarations
  utils/                       # pure-function utilities
  modules/                     # 11 business modules
    plugin-system/             # external RPC plugin lifecycle
    behavior/                  # behaviors — "Discord trigger → action" rules
    command-system/            # command reconcile + interaction dispatch + DM pattern
    builtin-features/          # in-process Discord features (picture-only / rcon-forward / role-emoji / todo-channel / voice)
    feature-toggle/            # feature on/off state
    voice/                     # voice connection manager + voice RPC
    admin/                     # admin identity, login, capabilities, audit
    dm-inbox/                  # DM inbox + SSE push
    guild-management/          # Discord guild management web API
    bot-events/                # bot event log
    web-core/                  # Fastify infrastructure + JWT signing authority

tests/                         # vitest unit tests (flat)
frontend/                      # nested admin SPA (Vue); built and served by the bot
docs/                          # this file lives here
```

DB schema is defined per module under `models/`; `sequelize.sync()` builds
the tables at startup. There is no separate migration system.
Schema-evolution notes are in [`operations.md`](operations.md#upgrades).

The SOPs for adding a feature, an endpoint, an event handler, or a model
are in [`architecture.md`](architecture.md).

## Code style

- TypeScript strict mode.
- ESM modules (`"type": "module"`); relative imports keep the `.js`
  extension.
- Explicit register pattern (no decorators). Each `events/*.events.ts`
  and `*.commands.ts` exports a `register*` function; the two
  `bootstrap-*.ts` files wire them to the client.
- One Sequelize model per file; the model is the single source of truth
  for its table's schema.
- Module boundary rules are documented in
  [`architecture.md`](architecture.md#dependency-rules).

### Naming

- File names — `kebab-case.ts`.
- Class names — `PascalCase`.
- Functions and variables — `camelCase`.
- Constants — `SCREAMING_SNAKE_CASE`.
- Capability tokens — see [`permissions.md`](permissions.md) (for
  example, `guild.manage`, `behavior.manage`).

### Error handling

- Outer `try/catch` around every interaction and event handler — the
  process must not crash because of one handler.
- `main.ts` registers `unhandledRejection` and `uncaughtException`
  handlers as a last line of defence.
- User-facing errors reply ephemerally.
- Structured logging via `logger.ts` and `moduleLogger(...)`. Discord
  embeds show only user-readable summaries; technical detail goes to
  the log.

## Tests

`tests/` is a flat vitest suite; imports come from `../src/...`. Coverage
focuses on pure-function utilities (crypto, hmac, host-policy,
rate-limiter, validators) and the service / route layer (jwt,
auth-store, route-guards, admin capability and audit, behavior trigger,
dm-inbox, plugin subsystems, guild routes, and so on).

discord.js-coupled command and event handlers are integration-tested
only when needed. Add tests alongside new pure logic.

```bash
pnpm test                       # one-shot
pnpm test:watch                 # watch mode
pnpm test:typecheck             # type-check tests/
```

## Adding a capability

1. Add a key to `CAPABILITIES` in
   `src/modules/admin/admin-capabilities.ts`, in `feature.action` form.
2. Add the corresponding default to `EVERYONE_DEFAULTS`.
3. Use `requireCapability(...)` or `requireGuildCapability(...)` in the
   route or event handler (import from `web-core/route-guards.js`).
4. Add a case in `tests/admin-capabilities.test.ts` covering the default.
5. Update the capability list in [`permissions.md`](permissions.md).

## CI and release

GitHub Actions workflows live at the monorepo root in
`.github/workflows/`:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | push / pull request | `pnpm install` + build + test for `bot` and `plugin-sdk`. |
| `release-please.yml` | push to `main` | Maintain a release PR per package (version proposal + CHANGELOG). |
| `publish-bot-image.yml` | push to `main` or tag `bot-v*` | Build the bot Docker image and push to ghcr. |
| `publish-plugin-sdk.yml` | tag `plugin-sdk-v*` | Publish `@karyl-chan/plugin-sdk` to GitHub Packages. |

Release-please drives versioning from conventional commits. See the root
[`README.md`](../../../README.md#release-process). Self-verify locally
with `pnpm preflight`.

### Branch strategy

The bot is currently maintained by a small team:

- Work directly on `main` (or short-lived feature branches).
- One logical change per commit; conventional-commit style (`feat:`,
  `fix:`, `chore:`, `refactor:`, `test:`, `docs:`, `style:`, and so on).
- Larger changes or external collaborators go through a PR.

## Troubleshooting (development)

### Startup logs `Unhandled promise rejection: TokenInvalid`

The `.env` `BOT_TOKEN` is wrong or has been revoked.

### `ts-node` reports `Cannot use import statement outside a module`

Confirm `package.json` has `"type": "module"`. Execution must use
`--loader ts-node/esm/transpile-only` (already wired into `dev` and
`start`).

### `sqlite3` or `@discordjs/opus` fails to install

The build needs a C/C++ toolchain (on Windows: Visual Studio Build
Tools; on Linux: `build-essential`). Alternative: use the Docker
development path with `pnpm docker:up`.

### Vitest cannot find `dns/promises`

`tsconfig.test.json` sets `"types": ["node"]`; keep that entry if you
customise tsconfig.
