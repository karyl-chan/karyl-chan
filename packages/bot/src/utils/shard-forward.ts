/**
 * Shard-aware cross-shard forwarding (PR-3.3).
 *
 * Discord routes every guild's gateway events to exactly one shard
 * (`(guild_id >> 22) % totalShards`). A guild-scoped plugin RPC (e.g.
 * voice.play / messages.send into a guild the caller resolved) must
 * execute on the shard that holds that guild's live discord.js handle —
 * otherwise `bot.guilds.cache.get(id)` is null and the op fails even
 * though a sibling shard could do it. Traefik / kube-proxy can't route
 * on guild_id (it's in the body, not the path), so the bot itself must
 * forward the call to the owning shard.
 *
 * This module is the forward client + the routing decision; it is built
 * on the existing `shard-routing.ts` helpers and reuses the bot↔voice
 * signed-HTTP primitives (`signedJsonPost` / `verifyInboundSignature-
 * FromHeaders`) so there is exactly one HMAC scheme on the wire.
 *
 * Single-shard invariant: with `totalShards === 1` (the default)
 * `targetShardForGuild` is always 0 === this shard, so `decideForward`
 * always returns `{ forward: false }` and nothing here ever runs — the
 * caller proceeds with its existing in-process path, byte-for-byte.
 */

import { config } from "../config.js";
import { targetShardForGuild } from "./shard-routing.js";
import {
  signedJsonPost,
  verifyInboundSignatureFromHeaders,
  type SignatureCheck,
} from "./hmac.js";

export type ForwardDecision =
  | { forward: false; reason: "mine" | "single-shard" }
  | { forward: false; reason: "no-target"; shardId: number }
  | { forward: false; reason: "no-secret"; shardId: number }
  | { forward: true; shardId: number; baseUrl: string };

/**
 * Decide whether a guild-scoped op should be handled locally or
 * forwarded to another shard.
 *
 *  - single-shard deployment      → handle locally
 *  - guild owned by THIS shard     → handle locally
 *  - guild owned by another shard:
 *      - SHARD_URLS has its base   → forward
 *      - no base / no secret        → can't forward (caller falls back to
 *                                     its existing "guild not found" path)
 *
 * Pure: reads only config + the guildId. Parameters default to the live
 * config but are injectable so the decision is unit-testable without
 * mutating process state.
 */
export function decideForward(
  guildId: string,
  opts?: {
    shardId?: number;
    totalShards?: number;
    urls?: Record<number, string>;
    hmacSecret?: string | null;
  },
): ForwardDecision {
  const totalShards = opts?.totalShards ?? config.bot.totalShards;
  const myShard = opts?.shardId ?? config.bot.shardId;
  const urls = opts?.urls ?? config.shard.urls;
  const secret =
    opts?.hmacSecret !== undefined ? opts.hmacSecret : config.shard.hmacSecret;

  if (totalShards <= 1) return { forward: false, reason: "single-shard" };

  const owner = targetShardForGuild(guildId, totalShards);
  if (owner === myShard) return { forward: false, reason: "mine" };

  const baseUrl = urls[owner];
  if (!baseUrl) return { forward: false, reason: "no-target", shardId: owner };
  if (!secret) return { forward: false, reason: "no-secret", shardId: owner };

  return { forward: true, shardId: owner, baseUrl };
}

/** Internal route prefix all forwarded shard ops land on. */
export const SHARD_FORWARD_PATH_PREFIX = "/internal/shard";

export interface ForwardResult {
  /** HTTP status the owning shard returned. */
  status: number;
  /** Parsed JSON body (or null when the body wasn't JSON). */
  body: unknown;
}

/**
 * Forward an already-validated guild op to the shard that owns the guild.
 * `path` is the internal route on the target shard (e.g.
 * `/internal/shard/messages.send`); `body` is JSON-serialised and HMAC-
 * signed with the shared secret. Returns the owning shard's status +
 * parsed body so the caller can relay it back to the plugin unchanged.
 *
 * Throws only on a transport failure (the owning shard unreachable) so
 * the caller can surface a 502/503; an application-level error from the
 * owning shard comes back as a non-2xx `status` + `body`, not a throw.
 */
export async function forwardToShard(
  decision: Extract<ForwardDecision, { forward: true }>,
  secret: string,
  path: string,
  body: unknown,
): Promise<ForwardResult> {
  const res = await signedJsonPost(secret, decision.baseUrl, path, body);
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

/**
 * Verify an inbound forwarded request on the owning shard. Thin wrapper
 * over `verifyInboundSignatureFromHeaders` so the inter-shard route and
 * any future caller share one verification call shape. `rawBody` MUST be
 * the exact bytes the signature was computed over (register a raw-string
 * content-type parser on the scope, as the voice internal routes do).
 */
export function verifyInboundShardRequest(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  method: string,
  urlPath: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): SignatureCheck {
  return verifyInboundSignatureFromHeaders(
    secret,
    headers,
    rawBody,
    nowSec,
    method,
    urlPath,
  );
}
