# Self-hosting a bot + your plugin (external authors)

You wrote a plugin in its own repo and want to run it against your own
karyl-chan bot — typically one `docker-compose.yml` with both services.
This guide is the blessed shape for that setup, plus the operational
facts (setup secret, enable flow, readiness semantics) that are easy to
get wrong the first time.

> Written after the first external plugin integration (2026-06-11).
> Every section here maps to something that actually went wrong or was
> guessed incorrectly during it.

## TL;DR checklist

1. Run the bot from the **official image** (`ghcr.io/karyl-chan/karyl-chan-bot`)
   unless you have a reason to build from source.
2. `depends_on: { karyl-chan: { condition: service_healthy } }` with the
   healthcheck on `/api/health/ready` — this genuinely waits for the
   Discord gateway, not just the web server.
3. Get `KARYL_PLUGIN_SETUP_SECRET` **from the bot admin UI** — it is a
   per-plugin credential minted by the bot, not a value you invent.
4. After the first successful register, **enable the plugin** (and its
   guild feature) in the admin UI. Registration alone does not enable it.
5. Iterating? Rebuild **only the plugin service**. Don't `docker compose
   up --build` the whole stack for a plugin-only change.

## Compose template

```yaml
services:
  karyl-chan:
    # Official multi-arch image. :latest tracks the newest bot-v* release;
    # :edge tracks main. Building from the monorepo source instead also
    # works (build: { context: ./karyl-chan, dockerfile: packages/bot/Dockerfile })
    # but you then own keeping that checkout in sync with the SDK version
    # your plugin uses.
    image: ghcr.io/karyl-chan/karyl-chan-bot:latest
    container_name: karyl-chan-bot
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      BOT_TOKEN: ${BOT_TOKEN:?set BOT_TOKEN}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY:?set ENCRYPTION_KEY}   # openssl rand -hex 32
      BOT_OWNER_IDS: ${BOT_OWNER_IDS:?set BOT_OWNER_IDS}
      NODE_ENV: production
      WEB_BASE_URL: http://localhost:3000
    volumes:
      - ./data:/usr/src/app/data    # SQLite lives here — this mount IS your bot state
    healthcheck:
      # /api/health/ready = web up AND db up AND Discord gateway ready
      # (see "Readiness semantics" below). Plugins that depends_on this
      # healthcheck never register against a half-booted bot.
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:3000/api/health/ready', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 10s
      timeout: 10s
      retries: 10
      start_period: 60s

  my-plugin:
    build:
      context: ./my-plugin
    container_name: my-plugin
    restart: unless-stopped
    environment:
      PORT: 3000
      HOST: 0.0.0.0
      BOT_URL: http://karyl-chan-bot:3000
      # Must be the URL the BOT can reach THIS container at:
      PLUGIN_URL: http://my-plugin:3000
      # Minted by the bot admin — see "Setup secret" below.
      KARYL_PLUGIN_SETUP_SECRET: ${KARYL_PLUGIN_SETUP_SECRET:?mint via admin UI first}
    depends_on:
      karyl-chan:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s
```

## Setup secret — minted by the bot, not invented by you

`KARYL_PLUGIN_SETUP_SECRET` authenticates `POST /api/plugins/register`.
The bot only accepts it if an admin **pre-registered the secret for your
exact plugin key** (the `key` you pass to `definePlugin`):

1. Bring the bot up and invite it to your server.
2. As a `BOT_OWNER_IDS` user, run `/login` in a DM → open the admin link.
3. Admin → Plugins → add your plugin key → the UI mints a setup secret.
   **The cleartext is shown exactly once.**
4. Put it in your `.env` as `KARYL_PLUGIN_SETUP_SECRET`, then
   `docker compose up -d my-plugin`.

(Equivalent API: `POST /api/plugins/setup-secret` with an admin session,
body `{"pluginKey": "my-plugin"}`.)

## Register ≠ enabled

A successful register stores your manifest and credentials, but the
plugin row created during secret-minting starts **disabled**. Until an
admin enables the plugin — and the relevant guild feature in each guild —
your slash commands won't dispatch. Both toggles live in the same admin
Plugins view. Slash commands are synced to Discord **in the background**
after register (response field `commandSync: "deferred"`); the plugin
card in the admin UI shows the sync state, and a badge appears if it
failed or got rate-limited.

## Readiness semantics

| Endpoint | Meaning |
|---|---|
| `/api/health/live` (alias `/api/health`) | process answers HTTP |
| `/api/health/ready` | web **and** DB (live roundtrip) **and** Discord gateway ready, **and** not draining |

`ready` is the signal sibling containers should `depends_on`. In
`BOT_SKIP_DISCORD=true` dev mode there is no gateway; `ready` then turns
200 with `checks.botMode: "skipped"` so probes can tell the difference.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| Register answers `401 invalid setup secret` | Secret never minted for this plugin key, or key mismatch with `definePlugin` | Bot event log: `Plugin registration rejected (...)`; compare keys exactly |
| Register answers `400` | Manifest problem — common ones: a command missing `scope` / `integrationTypes` / `contexts` (V-06/07/08, all mandatory), or a command name colliding with a reserved/other plugin's command | The 400 body carries the exact reason; fix the manifest |
| Plugin-side RPC answers `403` | Scope not declared/approved (note: scope names are snake_case wire-side, e.g. `me.enabled_guilds`), or the plugin simply isn't **enabled** yet — every RPC is gated on the admin enable switch | The 403 body says which; check `rpcMethodsUsed` and the admin enable toggle |
| Register answers `429` | Register loop — the bot throttles per-plugin registers (10/min) | Stop the restart loop; the SDK backs off by itself, just wait |
| Plugin log: `register timed out after 30000ms` (3× escalates to error) | Bot-side register handler wedged or unreachable | Bot log: an `/api/plugins/register` "incoming request" with no completion; bot event log warns after 10s |
| Commands visible in Discord but every use fails fast | Plugin restarted and hasn't completed its register handshake — it refuses dispatches (503) until then | Plugin log: `dispatch refused: register handshake not completed`; bot event log names the same state; it self-heals when register succeeds |
| Discord shows "互動失敗" / no response at all | Plugin handler crashed or timed out mid-command | Plugin log around the `/commands/<name>` POST |
| Commands never appear in Discord | Plugin or guild feature not enabled; or command sync failed/rate-limited | Admin plugin card: enable toggles + `commandSync` badge |
| Everything worked, then broke after `docker compose down && up` | Bot state lives in the `./data` mount — if you deleted it, the setup secret and registration are gone | Re-mint the secret, re-register |

## Iterating on your plugin

Re-registering with an **unchanged** manifest costs zero Discord API
writes, and the bot throttles registers per plugin key — so a normal
edit-rebuild-restart loop is safe. Still, prefer rebuilding only the
plugin service (`docker compose up --build -d my-plugin`); a full-stack
rebuild restarts the bot for no reason and re-runs its boot reconcile.
