/**
 * command-system/behavior-callback-token.ts
 *
 * Behavior callback tokens (#113): each time a behavior's webhook action
 * runs, the bot issues one opaque token for that run and sends it to the
 * receiver in `_meta.callback`. With it the receiver may answer later,
 * through `/api/plugin/interactions.respond` / `followup` /
 * `edit_followup` / `delete_followup` — for that run's reply only.
 *
 * The token stands in for the Discord interaction token, which never
 * leaves the bot: the interaction itself stays here, in the token's
 * principal. A token lives 15 minutes, like Discord's interaction token.
 *
 * In memory only, like the plugin defer state and plugin tokens: a token
 * means nothing to another process, and a restart forgets every token
 * (the receiver's next call gets 401). The token itself is never kept,
 * only its SHA-256.
 */

import { createHash, randomBytes } from "crypto";
import type { ChatInputCommandInteraction } from "discord.js";
import { config } from "../../config.js";
import type { ReplyVisibility } from "../behavior/models/behavior-definition.model.js";

/** How long a callback token is good for: Discord's interaction token lifetime. */
export const CALLBACK_TOKEN_TTL_MS = 15 * 60 * 1000;

const SWEEP_INTERVAL_MS = 60_000;

/**
 * What a callback answers. A command trigger's run keeps its (already
 * deferred) interaction. Message triggers (#200) add their own member.
 */
export type CallbackTarget = { kind: "interaction"; interaction: ChatInputCommandInteraction };

/** What the token is issued for. */
export interface CallbackIssue {
  behaviorId: number;
  target: CallbackTarget;
  /** The behavior's stored reply default (replyVisibility). */
  visibility: ReplyVisibility | null;
}

/**
 * The principal a callback token resolves to: what one run may still
 * change. `createdMessageIds` are the follow-ups sent with this token —
 * the only messages `edit_followup` / `delete_followup` may touch.
 */
export interface BehaviorCallbackPrincipal extends CallbackIssue {
  readonly expiresAt: number;
  readonly createdMessageIds: Set<string>;
}

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export class BehaviorCallbackTokenStore {
  private readonly byHash = new Map<string, BehaviorCallbackPrincipal>();
  private sweepTimer: NodeJS.Timeout | null = null;

  /** Issue a token for one run. The token is returned once and never stored. */
  issue(input: CallbackIssue): { token: string; expiresAt: Date } {
    this.ensureSweep();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + CALLBACK_TOKEN_TTL_MS;
    this.byHash.set(hashToken(token), { ...input, expiresAt, createdMessageIds: new Set() });
    return { token, expiresAt: new Date(expiresAt) };
  }

  /** The token's principal, or null when it is unknown, revoked or expired. */
  resolve(token: string): BehaviorCallbackPrincipal | null {
    const hash = hashToken(token);
    const principal = this.byHash.get(hash);
    if (!principal) return null;
    if (principal.expiresAt <= Date.now()) {
      this.byHash.delete(hash);
      return null;
    }
    return principal;
  }

  /** End a token early (its run failed: the user was already told). */
  revoke(token: string): void {
    this.byHash.delete(hashToken(token));
  }

  /** Tests only. */
  clear(): void {
    this.byHash.clear();
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [hash, principal] of this.byHash) {
        if (principal.expiresAt <= now) this.byHash.delete(hash);
      }
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }
}

/** `_meta.callback` of a webhook request (#113). */
export interface CallbackMeta {
  token: string;
  /** ISO 8601. */
  expires_at: string;
  /** The bot's public base URL; the receiver calls `<api_base>/api/plugin/interactions.*`. */
  api_base: string;
}

/** The bot's public base URL (WEB_BASE_URL), as the admin login link uses it. */
function publicBaseUrl(): string {
  if (config.web.baseUrl) return config.web.baseUrl.replace(/\/+$/, "");
  return `http://localhost:${config.web.port}`;
}

export function callbackMetaOf(issued: { token: string; expiresAt: Date }): CallbackMeta {
  return {
    token: issued.token,
    expires_at: issued.expiresAt.toISOString(),
    api_base: publicBaseUrl(),
  };
}

/** The process's callback tokens: issued by runWebhookAction, read by the /api/plugin/* auth hook. */
export const behaviorCallbackTokens = new BehaviorCallbackTokenStore();
