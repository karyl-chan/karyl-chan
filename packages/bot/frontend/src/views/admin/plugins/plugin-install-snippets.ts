/**
 * Copyable wiring snippets for the plugin install journey (PD-1.2).
 *
 * The `KARYL_PLUGIN_SETUP_SECRET_<KEY>` root-.env naming convention and
 * the "PLUGIN_URL must match the container name" rule previously lived
 * only in docker-compose comments — these generators put them in the
 * operator's clipboard at the exact moment they're needed (Add Plugin
 * modal, Security tab regenerate). Keep in sync with
 * packages/bot/docs/operator-guide.md.
 */

/** Root-.env variable name: plugin key uppercased, `-` → `_`. */
export function secretEnvName(pluginKey: string): string {
  return `KARYL_PLUGIN_SETUP_SECRET_${pluginKey.toUpperCase().replace(/-/g, "_")}`;
}

/** The line to paste into the compose root `.env`. */
export function rootEnvLine(pluginKey: string, secret: string): string {
  return `${secretEnvName(pluginKey)}=${secret}`;
}

/**
 * A self-contained docker-compose service stub following the
 * karyl-plugin-<key> conventions. Compose interpolation turns the
 * suffixed root-.env name into the unsuffixed KARYL_PLUGIN_SETUP_SECRET
 * the SDK reads; PLUGIN_URL is explicit because the SDK default
 * (http://<key>:3000) doesn't match the container-name convention.
 */
export function composeServiceStub(pluginKey: string): string {
  const name = `karyl-plugin-${pluginKey}`;
  return [
    `  ${name}:`,
    `    container_name: ${name}`,
    `    image: ${name}`,
    `    build:`,
    `      context: ./plugin-${pluginKey}   # adjust to the plugin's path`,
    `    restart: unless-stopped`,
    `    networks:`,
    `      - karyl-chan-net`,
    `    environment:`,
    `      PLUGIN_URL: http://${name}:3000`,
    `      KARYL_PLUGIN_SETUP_SECRET: \${${secretEnvName(pluginKey)}:-}`,
  ].join("\n");
}
