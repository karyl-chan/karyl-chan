# create-karyl-plugin

Scaffold a new [karyl-chan](https://github.com/karyl-chan/karyl-chan) plugin
— a minimal hello-world that responds to a slash command.

## Usage

```bash
# Published (once on a registry):
pnpm create karyl-plugin my-plugin
# or npm:
npm create karyl-plugin@latest my-plugin

# From a checkout of this monorepo:
node packages/create-karyl-plugin/index.js my-plugin
```

Flags:

| Flag | Default | What |
|------|---------|------|
| `<target-dir>` | — (required) | Directory to create the plugin in. |
| `--key <key>` | derived from the dir name | Manifest key (`[a-z0-9][a-z0-9-]*`). |
| `--name "<name>"` | title-cased key | Human-readable plugin name. |

The generated plugin registers one command, `/<key>-ping`, that replies
`pong 🏓`. Its own README walks through installing, wiring a setup secret,
and `npm run dev`.

## What it generates

```
my-plugin/
  package.json        # deps: @karyl-chan/plugin-sdk, fastify
  tsconfig.json
  .env.example        # BOT_URL, KARYL_PLUGIN_SETUP_SECRET, PLUGIN_URL, PORT
  .gitignore
  .npmrc              # @karyl-chan → GitHub Packages
  README.md
  src/
    plugin.ts         # definePlugin + one definePluginCommand
    index.ts          # plugin.start()
```

The SDK version pinned in the generated `package.json` is the `SDK_VERSION`
constant in `index.js` — bump it on each plugin-sdk release.
