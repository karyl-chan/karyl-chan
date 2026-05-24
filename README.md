# karyl-chan

A pnpm monorepo containing the karyl-chan Discord bot and its plugin SDK.

## Layout

```
packages/
├── bot/         # @karyl-chan/bot         Discord bot (HTTP API + nested Vue admin SPA)
│   └── frontend/  # karyl-chan-frontend   Admin SPA, served as static assets by the bot
└── plugin-sdk/  # @karyl-chan/plugin-sdk  Shared SDK consumed by external plugins
```

A `ui` package for shared UI components is not yet created.

## Requirements

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | `>= 22` | Enforced by each package's `engines`. |
| pnpm | pinned by `packageManager` in the root `package.json` | Install via `corepack enable`. |
| C/C++ toolchain | any recent | `sqlite3` and `@discordjs/opus` build from source (`.npmrc` sets `build_from_source=true`) to avoid prebuilt glibc-linkage issues. |

## Development

Run from the repo root:

```bash
pnpm install                # install workspace dependencies
pnpm build                  # build all packages
pnpm test                   # test all packages
pnpm build:bot              # build only the bot
pnpm build:sdk              # build only the plugin SDK
```

### Bot

```bash
pnpm --filter @karyl-chan/bot dev         # transpile-only run (no watch)
pnpm --filter @karyl-chan/bot start       # nodemon watch mode
pnpm --filter @karyl-chan/bot preflight   # build + typecheck + test + frontend
pnpm docker:up                            # build + start in Docker, wait for healthy
pnpm docker:down                          # stop the Docker bot
```

Configuration lives in `packages/bot/.env` (copy from `.env.example`). See
[`packages/bot/docs/setup.md`](packages/bot/docs/setup.md). Docker Compose
configuration is at `packages/bot/docker-compose.yml`.

## Release process

Releases are driven by
[release-please](https://github.com/googleapis/release-please). Every push to
`main` updates one release PR per package, with the version and
`CHANGELOG.md` computed from conventional commits.

Merging a release PR:

1. Commits a `chore` to `main` that bumps the package's `package.json` and
   updates its `CHANGELOG.md`.
2. Creates a GitHub release and a tag of the form `bot-v<x.y.z>` or
   `plugin-sdk-v<x.y.z>`.
3. Triggers the package's publish workflow.

| Workflow | Trigger | Output |
|----------|---------|--------|
| `.github/workflows/release-please.yml` | push to `main` | release PR per package (version proposal + CHANGELOG) |
| `.github/workflows/publish-bot-image.yml` | push to `main` → `:edge`; tag `bot-v*` → `:<version>` + `:latest` | `ghcr.io/<owner>/karyl-chan-bot` (`:latest` only moves on a real release) |
| `.github/workflows/publish-plugin-sdk.yml` | tag `plugin-sdk-v*` | `@karyl-chan/plugin-sdk` on GitHub Packages npm |
| `.github/workflows/ci.yml` | push / pull request | build + test for both packages |

Commit messages must follow conventional commits to drive release-please
decisions: `feat:` → minor, `fix:` → patch, footer `BREAKING CHANGE:` → major.
Scope a commit to one package with the package name, e.g. `feat(bot): ...` or
`fix(plugin-sdk): ...`.
