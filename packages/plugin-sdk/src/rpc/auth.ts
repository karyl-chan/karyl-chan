/**
 * Typed `auth.*` namespace — currently just `mintSession`.
 *
 * The bot's `/api/plugin/auth.session` accepts two `kind` values:
 *   - `'manage'`: requires the user to hold `admin` OR
 *     `plugin:<thisPluginKey>:manage`. Returns `{ allowed: false }` when
 *     they don't. Short TTL (default 15 min) — re-mint as needed.
 *   - `'session'`: no capability gate; the slash command that produced
 *     the link is itself permission-gated. Default 6 h. `guildId` is
 *     embedded in the JWT so the WebUI scopes to that session.
 *
 * The README of pre-0.9 SDKs documented `'webui'` as the value — that
 * was always wrong, the bot has only ever accepted `'manage' | 'session'`.
 */

import type { RpcCaller } from "./index.js";

export type SessionKind = "manage" | "session";

export interface MintSessionArgs {
  userId: string;
  kind?: SessionKind;
  guildId?: string;
  /** Override default TTL (ms). Clamped server-side to [60_000, 7d]. */
  ttlMs?: number;
}

/**
 * Discriminated return — `allowed: false` is the `kind: 'manage'` no-cap
 * path; every other failure throws (network, http_status, …).
 */
export type MintSessionResult =
  | { allowed: true; token: string; expiresAt: number }
  | { allowed: false };

export interface Auth {
  /**
   * Mint a `plugin-session` JWT for a Discord user. Pair the returned
   * token with `verifyPluginSession()` on the WebUI side to authenticate
   * the request without round-tripping the bot.
   */
  mintSession(args: MintSessionArgs): Promise<MintSessionResult>;
}

export function createAuth(call: RpcCaller): Auth {
  return {
    async mintSession(args) {
      const res = (await call("/api/plugin/auth.session", {
        user_id: args.userId,
        ...(args.kind !== undefined ? { kind: args.kind } : {}),
        ...(args.guildId !== undefined ? { guild_id: args.guildId } : {}),
        ...(args.ttlMs !== undefined ? { ttl_ms: args.ttlMs } : {}),
      })) as {
        allowed?: boolean;
        token?: string;
        expiresAt?: number;
      };
      if (res.allowed === false) return { allowed: false };
      if (typeof res.token !== "string" || typeof res.expiresAt !== "number") {
        return { allowed: false };
      }
      return { allowed: true, token: res.token, expiresAt: res.expiresAt };
    },
  };
}
