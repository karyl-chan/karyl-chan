import { jwtService } from "../web-core/jwt.service.js";
import { resolveUserCapabilities } from "../admin/authorized-user.service.js";
import { hasPluginCapability } from "../admin/admin-capabilities.js";

/**
 * Minting the plugin-session **manage** token a human carries into a
 * plugin's own WebUI.
 *
 * Distinct from `plugin-auth.service.ts`, which stores the bearer token a
 * *plugin* uses to call the bot: different subject (a user, not a plugin)
 * and a different lifecycle. It lives in its own module so both route
 * families can reach it without importing each other (#46).
 */

/**
 * Mint a plugin-session **manage** token for `userId` against `pluginKey`.
 * Shared by the plugin-facing `auth.session` RPC (kind=manage) and the
 * admin-UI manage-link endpoint so the authorization rule lives in ONE
 * place: `hasPluginCapability` (which bypasses `admin` as a superuser —
 * no hand-rolled `admin ||` per call site), and the token carries only
 * the holder's `admin` + `plugin:<key>:*` subset, never another plugin's
 * grants. Signed with this plugin's own derived key, so it verifies only
 * against that plugin's WebUI.
 *
 * Returns `{ allowed: false }` when the user holds neither `admin` nor
 * `plugin:<key>:manage`.
 */
export async function mintPluginManageToken(
  pluginKey: string,
  userId: string,
  ttlMs: number = 15 * 60_000,
): Promise<
  { allowed: true; token: string; expiresAt: number } | { allowed: false }
> {
  const allCaps = await resolveUserCapabilities(userId);
  if (!hasPluginCapability(allCaps, pluginKey, "manage")) {
    return { allowed: false };
  }
  const pluginCaps = [...allCaps].filter(
    (c) => c === "admin" || c.startsWith(`plugin:${pluginKey}:`),
  );
  const { token, expiresAt } = jwtService.signPluginSession(
    pluginKey,
    {
      purpose: "plugin-session",
      userId,
      guildId: null,
      capabilities: pluginCaps,
    },
    { ttlMs },
  );
  return { allowed: true, token, expiresAt };
}
