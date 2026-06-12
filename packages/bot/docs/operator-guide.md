# Plugin operator guide

How to take a plugin from "I have its image/repo" to "members are using
it in my guilds", as the **bot operator**. If you are *writing* a plugin,
read [`development/plugin-guide.md`](development/plugin-guide.md) instead;
if you are a plugin author hosting your plugin away from the bot's
compose, see the SDK's
[`self-host-deployment.md`](../../plugin-sdk/docs/self-host-deployment.md).

## How plugin ↔ bot wiring works (30 seconds)

A plugin is a separate HTTP service. At startup it **registers itself**
with the bot — manifest + its own reachable URL — authenticated by a
**one-time setup secret** you mint in the admin UI. After that it
heartbeats every 30s; the bot marks it offline after ~75s of silence
(`PLUGIN_HEARTBEAT_TIMEOUT_MS`) and recovers it automatically on the next
heartbeat. The bot needs **no per-plugin configuration**: no bot-side env
vars, no bot compose edits. Everything the bot knows about a plugin
arrives through registration.

Consequence: installing a plugin is exactly three pieces of wiring, all
on the **plugin's** side — the secret, the container, and the container's
`PLUGIN_URL`.

## Install a plugin

### 1. Mint the setup secret (admin UI)

Plugins page → **Add Plugin** → enter the plugin key (lowercase
`a-z0-9-`, must match the `key` the plugin declares — check its README).
The UI shows the secret **once**, together with copyable snippets for
steps 2 and 3. Until the plugin registers, the entry is listed under
**awaiting first registration** — that's the journey position, not an
error.

### 2. Put the secret in the compose root `.env`

```bash
KARYL_PLUGIN_SETUP_SECRET_<KEY>=<secret>
```

`<KEY>` is the plugin key uppercased with `-` → `_` (plugin key
`quest-game` → `KARYL_PLUGIN_SETUP_SECRET_QUEST_GAME`). This suffixed
name exists only in the root `.env`; compose interpolation passes it into
the container as the **unsuffixed** `KARYL_PLUGIN_SETUP_SECRET`, which is
what the SDK reads. If you run the plugin without compose, set the
unsuffixed variable directly.

### 3. Add the compose service

```yaml
  karyl-plugin-<key>:
    container_name: karyl-plugin-<key>
    image: karyl-plugin-<key>
    build:
      context: ./plugin-<key>        # adjust to the plugin's path
    restart: unless-stopped
    networks:
      - karyl-chan-net               # the bot's shared network
    environment:
      PLUGIN_URL: http://karyl-plugin-<key>:3000
      KARYL_PLUGIN_SETUP_SECRET: ${KARYL_PLUGIN_SETUP_SECRET_<KEY>:-}
```

Two values matter:

- **`PLUGIN_URL`** is the address the plugin advertises to the bot in its
  manifest — the bot dispatches events/commands and proxies the WebUI to
  it. It must be reachable *from the bot's container*, i.e. match the
  container name on the shared network. The SDK default is
  `http://<plugin-key>:3000`, which usually does **not** match the
  `karyl-plugin-<key>` container-name convention — set it explicitly.
- **`BOT_URL`** defaults to `http://karyl-chan:3000`; override it only if
  your bot container is named differently.

### 4. Start it

```bash
docker compose -f docker-compose.plugins.yml up -d karyl-plugin-<key>
```

The plugin registers itself; nothing else to wire.

### 5. Verify registration

On the Plugins page the entry should move out of **awaiting first
registration** within seconds: version flips from `0.0.0` to the
manifest's, command sync settles in the background, and ~3s after
register the bot fires a signed **dispatch probe** so a bot↔SDK signature
mismatch surfaces immediately instead of on first use.

### 6. Enable it

**Registered ≠ enabled.** A fresh registration stays disabled so a
just-installed plugin can't dispatch before you've looked at it. Flip the
toggle on its card.

### 7. Approve RPC scopes (only when auto-approve is off)

With `PLUGIN_AUTO_APPROVE` unset (default `true`) the scopes a plugin
declares are granted at registration. If you run `PLUGIN_AUTO_APPROVE=false`,
pending scopes show on the plugin card and in its **Security** tab —
the plugin's bot-RPC calls fail until you approve them there.

### 8. Turn features on per guild

Guild page → **Bot 功能** panel lists every guild feature the plugin
declares, with the effective state and where it comes from:

- **explicit per-guild override** (set right there), else
- **operator default** ("All Servers" page), else
- the **manifest default** the plugin shipped.

Per-guild feature *config* (if the feature declares a schema) is editable
in the same panel. "清除覆寫" removes the per-guild row — both the
override and its per-guild config — and the guild follows the default
again.

## Plugin config vs guild feature config

| | Plugin config | Guild feature config |
|---|---|---|
| Scope | one per plugin, global | one per (guild, feature) |
| Who | operator | guild admin / operator |
| Where | plugin detail page → 外掛設定 | guild page → Bot 功能 |
| Typical content | API keys, global tuning | channel ids, per-guild options |

Secret-typed fields in both are encrypted at rest and never echoed back
in plaintext (`********` means "a value is stored; leave blank to keep it").

## Troubleshooting

| Symptom (Plugins page) | Meaning | Fix |
|---|---|---|
| Stuck in **awaiting first registration** | The container never called register. | Container running? `KARYL_PLUGIN_SETUP_SECRET` actually set (the root-`.env`-name vs container-name mismatch is the classic miss)? Plugin logs show register retries/401s? Bot reachable at `BOT_URL` on the shared network? |
| Registered but **offline** | Heartbeats stopped (>75s). | Container down or network broken. It self-recovers on the next heartbeat; SIGTERM'd plugins deregister cleanly and go offline immediately. |
| Dispatch badge red / commands fail with 401 | Bot and plugin SDK disagree on the dispatch signature (version mismatch). | Rebuild the plugin against the current SDK and redeploy. The register-time probe catches this within seconds of registration. |
| Scope-pending badge | `PLUGIN_AUTO_APPROVE=false` and new scopes await review. | Approve (or deny) in the plugin's Security tab. |
| Register returns 429 | Per-plugin register throttle (10/min) — usually a crash-loop re-registering. | Fix the crash; the throttle clears itself. |
| Secret lost | Secrets are stored hashed, not retrievable. | Plugin card → regenerate setup secret (invalidates the old one), update the root `.env`, restart the plugin. |

The bot event log (admin UI) records every register / expiry / sync
problem with the plugin key attached — it's the first place to look when
a symptom isn't in this table.
