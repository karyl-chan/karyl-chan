/**
 * Admin capability tokens recognized by the backend. Mirrors
 * `src/modules/admin/admin-capabilities.ts` on the server. The server is
 * the authority for validation; this file lets the UI render the
 * catalog and apply local guards without a round-trip for data that
 * never changes at runtime.
 *
 * Descriptions resolve through i18n under `admin.capabilityDesc.<key>`
 * so the UI matches the active locale instead of a hard-coded string.
 */
export const GLOBAL_CAPABILITY_KEYS = [
  "admin",
  "dm.message",
  "guild.message",
  "guild.manage",
  "system.read",
  "behavior.manage",
] as const;

export type GlobalCapability = (typeof GLOBAL_CAPABILITY_KEYS)[number];

export const GUILD_SCOPES = ["message", "manage"] as const;
export type GuildScope = (typeof GUILD_SCOPES)[number];

export type GuildScopedCapability = `guild:${string}.${GuildScope}`;
/** Capability a plugin declared for its own use: `plugin:<pluginKey>:<capKey>`. */
export type PluginScopedCapability = `plugin:${string}:${string}`;

/** Anything that can be persisted in the role→capability mapping. */
export type AdminCapability =
  | GlobalCapability
  | GuildScopedCapability
  | PluginScopedCapability;

const SCOPED_GUILD_RE = /^guild:([^.:]+)\.(message|manage)$/;
/** pluginKey = plugin.id shape; capKey = [a-z0-9][a-z0-9._-]*. Mirrors the backend. */
const SCOPED_PLUGIN_RE = /^plugin:([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9._-]*)$/;

export function makeGuildScopedCapability(
  guildId: string,
  scope: GuildScope,
): GuildScopedCapability {
  return `guild:${guildId}.${scope}`;
}

function parseScopedGuild(
  value: string,
): { guildId: string; scope: GuildScope } | null {
  const m = SCOPED_GUILD_RE.exec(value);
  if (!m) return null;
  return { guildId: m[1], scope: m[2] as GuildScope };
}

/** Build a `plugin:<pluginKey>:<capKey>` token. */
export function makePluginCapabilityToken(
  pluginKey: string,
  capKey: string,
): PluginScopedCapability {
  return `plugin:${pluginKey}:${capKey}`;
}

/** Parse a plugin-scoped token; null on any other shape. */
export function parsePluginCapabilityToken(
  value: string,
): { pluginKey: string; capKey: string } | null {
  const m = SCOPED_PLUGIN_RE.exec(value);
  if (!m) return null;
  return { pluginKey: m[1], capKey: m[2] };
}

/** True iff `token` is structurally a `plugin:<pluginKey>:<capKey>` token. */
export function isPluginCapabilityToken(token: string): boolean {
  return SCOPED_PLUGIN_RE.test(token);
}

/**
 * "Does this user satisfy a plugin-scoped capability?" — `admin`
 * always passes, otherwise the exact `plugin:<pluginKey>:<capKey>`
 * token. Mirror of the backend's hasPluginCapability; plugins use the
 * client-side equivalent on the `capabilities` claim in their session JWT.
 */
export function hasPluginCapability(
  granted: Iterable<string>,
  pluginKey: string,
  capKey: string,
): boolean {
  const token = makePluginCapabilityToken(pluginKey, capKey);
  for (const cap of granted) {
    if (cap === "admin") return true;
    if (cap === token) return true;
  }
  return false;
}

/**
 * "Does this user satisfy a global capability?" `admin` always passes.
 * Use for non-guild surfaces (DM, system, admin panel itself).
 */
export function hasAdminCapability(
  granted: Iterable<string>,
  required: GlobalCapability,
): boolean {
  for (const cap of granted) {
    if (cap === "admin") return true;
    if (cap === required) return true;
  }
  return false;
}

/**
 * "Does this user satisfy a guild-scoped capability for this guild?"
 * Satisfied by `admin`, the global guild token (`guild.<scope>`), or
 * the matching per-guild token (`guild:<guildId>.<scope>`).
 *
 * `manage` does NOT imply `message` and vice versa — they're sibling
 * scopes, mirroring the backend's evaluator.
 */
export function hasGuildCapability(
  granted: Iterable<string>,
  guildId: string,
  scope: GuildScope,
): boolean {
  const globalToken = `guild.${scope}`;
  const scopedToken = makeGuildScopedCapability(guildId, scope);
  for (const cap of granted) {
    if (cap === "admin") return true;
    if (cap === globalToken) return true;
    if (cap === scopedToken) return true;
  }
  return false;
}

/**
 * Returns `'all'` if the user has unrestricted guild access (admin /
 * global guild token), otherwise the explicit set of guild ids they
 * carry per-guild grants for. Surfaces the union of `message` +
 * `manage` scopes.
 */
export function accessibleGuildIds(
  granted: Iterable<string>,
): "all" | Set<string> {
  const ids = new Set<string>();
  for (const cap of granted) {
    if (cap === "admin") return "all";
    if (cap === "guild.message" || cap === "guild.manage") return "all";
    const parsed = parseScopedGuild(cap);
    if (parsed) ids.add(parsed.guildId);
  }
  return ids;
}
