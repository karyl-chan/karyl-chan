# create-karyl-plugin

Scaffold a new [karyl-chan](https://github.com/karyl-chan/karyl-chan) plugin
— a minimal hello-world that responds to a slash command.

## Usage

```bash
pnpm create karyl-plugin my-plugin
# or
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
`pong 🏓`. It installs entirely from the public npm registry; no GitHub PAT
or scope-specific `.npmrc` is required. Its README walks through the full
register, approval, enable, and invoke journey.

## What it generates

```
my-plugin/
  package.json        # deps: @karyl-chan/plugin-sdk, fastify
  tsconfig.json
  .env.example        # BOT_URL, KARYL_PLUGIN_SETUP_SECRET, PLUGIN_URL, PORT
  .gitignore
  README.md
  src/
    plugin.ts         # definePlugin + one definePluginCommand
    index.ts          # plugin.start()
```

## Supported release contract

The plugin SDK and initializer are a release-please `linked-versions` group.
They share one version and one release PR; release-please also rewrites the
annotated `SDK_VERSION` line. The unit suite independently checks the package
versions and emitted range. A release cannot pass CI if any of those drift.
This is the deliberate coordination rule: fresh projects never silently lag
behind the current supported SDK.

Both packages are packed and exercised in the
`create-karyl-plugin-golden-path` CI job. That job invokes the packed CLI in
a clean directory, installs the packed candidate SDK without npm
credentials, typechecks and builds the result, then probes its dark-mode
liveness and readiness routes.

Publishing is handled by release-please and npm Trusted Publishers. The
`create-karyl-plugin-v*` tag dispatches
`.github/workflows/publish-create-karyl-plugin.yml`, which publishes with
OIDC provenance and no long-lived npm token. The workflow waits until the
same-version SDK is visible on npm before publishing the initializer, so the
generated range is installable as soon as the initializer becomes public.

### One-time first publish

An unscoped npm package belongs to the npm user who first publishes it, so its
Trusted Publisher cannot be configured until that first version exists. The
workflow has an explicit manual-only bootstrap path for this circular setup:

1. The npm maintainer creates a short-lived granular token that can publish a
   new public package and stores it as the `NPM_BOOTSTRAP_TOKEN` repository
   secret. Never put the token in an issue, command argument, or workflow file.
2. A repository maintainer dispatches the workflow from the release commit:

   ```bash
   gh workflow run publish-create-karyl-plugin.yml \
     --repo karyl-chan/karyl-chan \
     --ref main \
     -f bootstrap=true
   ```

3. After the package is public, configure its npm Trusted Publisher with:
   GitHub Actions, owner `karyl-chan`, repository `karyl-chan`, workflow
   `publish-create-karyl-plugin.yml`, no environment, and direct publish
   permission.
4. Delete the repository secret and revoke the granular token immediately:

   ```bash
   gh secret delete NPM_BOOTSTRAP_TOKEN --repo karyl-chan/karyl-chan
   ```

5. The next release must pass the normal `bootstrap=false` path to prove OIDC
   publishing before the release setup is considered complete.

The bootstrap path still runs on GitHub-hosted infrastructure with
`--provenance`; it changes authentication for one version, not the artifact or
attestation checks. Tag-triggered releases never select the bootstrap step.
