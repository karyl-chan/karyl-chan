import { config } from "../../config.js";
import { findPluginById } from "./models/plugin.model.js";
import { parsePluginManifest } from "./plugin-dispatch-util.js";

/**
 * How a plugin's guild-KV quota is derived from its manifest, and the
 * ceiling that derivation clamps to.
 *
 * Both plugin route families need the answer: the plugin-facing RPC
 * surface enforces the quota on every write, and Plugin Admin reports
 * usage against it. It lives here so neither family has to import the
 * other — an operator-facing concern reaching into the plugin-facing
 * module was the only dependency between them (#46).
 *
 * Note for anyone comparing with the SDK: `@karyl-chan/plugin-sdk` has
 * its own `KV_VALUE_MAX_BYTES` with the same name and different meaning
 * — a fixed 64 KiB the SDK refuses to send, versus this operator-tunable
 * ceiling the bot refuses to store.
 */

/** Per-row hard ceiling, regardless of what the manifest asks for. */
export const KV_VALUE_MAX_BYTES = config.plugin.kvValueMaxBytes;

/** Quota for a plugin whose manifest declares none. */
const DEFAULT_KV_QUOTA_BYTES = 64 * 1024;

export async function quotaForGuildKv(pluginId: number): Promise<number> {
  // Read quota from the plugin's stored manifest. Falls back to a
  // bot-wide default if the plugin didn't declare one.
  const plugin = await findPluginById(pluginId);
  if (!plugin) return DEFAULT_KV_QUOTA_BYTES;
  const manifest = parsePluginManifest(plugin);
  const declaredKb = manifest?.storage?.guildKvQuotaKb;
  if (typeof declaredKb === "number" && declaredKb > 0) {
    return Math.min(declaredKb * 1024, KV_VALUE_MAX_BYTES * 16);
  }
  return DEFAULT_KV_QUOTA_BYTES;
}
