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
 * principal. A token ends when the interaction token does — 15 minutes
 * after the interaction was created — so a late call is a 401, never a
 * Discord refusal.
 *
 * In memory only, like the plugin defer state and plugin tokens: a token
 * means nothing to another process, and a restart forgets every token
 * (the receiver's next call gets 401). The token itself is never kept,
 * only its SHA-256.
 */

import { createHash, randomBytes } from "crypto";
import type { ChatInputCommandInteraction } from "discord.js";
import type { ReplyVisibility } from "../behavior/models/behavior-definition.model.js";
import { publicBaseUrl } from "../web-core/public-base-url.js";
import type { ReplySlot } from "./reply-renderer.js";

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
 * The principal a callback token resolves to: one run, and the state its
 * reply is in. Only `serializeReply` callers change `replyMessage` and
 * `answeredByCallback`.
 */
export interface BehaviorCallbackPrincipal extends CallbackIssue {
  readonly expiresAt: number;
  /**
   * The message that holds the run's reply now: the deferred placeholder
   * at first, then whatever the synchronous answer or the last `respond`
   * left; null once it is gone (an empty answer deleted it). `respond`
   * edits it, or replaces it when the visibility changes.
   */
  replyMessage: ReplySlot | null;
  /** A callback `respond` landed: a synchronous answer arriving after it is not shown. */
  answeredByCallback: boolean;
  /** The follow-ups sent with this token — the only messages `edit_followup` / `delete_followup` may touch. */
  readonly createdMessageIds: Set<string>;
  /** Tail of the run's reply operations (serializeReply). */
  replyQueue: Promise<unknown>;
}

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** When the run's Discord token was born: the interaction's creation, else now. */
function startOf(target: CallbackTarget): number {
  const created = target.interaction.createdTimestamp;
  return typeof created === "number" && Number.isFinite(created) ? created : Date.now();
}

export class BehaviorCallbackTokenStore {
  private readonly byHash = new Map<string, BehaviorCallbackPrincipal>();
  private sweepTimer: NodeJS.Timeout | null = null;

  /** Issue a token for one run. The token is returned once and never stored. */
  issue(input: CallbackIssue): { token: string; expiresAt: Date; principal: BehaviorCallbackPrincipal } {
    this.ensureSweep();
    const token = randomBytes(32).toString("base64url");
    const { interaction } = input.target;
    const principal: BehaviorCallbackPrincipal = {
      ...input,
      expiresAt: startOf(input.target) + CALLBACK_TOKEN_TTL_MS,
      // a webhook's command is deferred before the token is issued
      replyMessage:
        interaction.deferred || interaction.replied
          ? { messageId: "@original", ephemeral: interaction.ephemeral ?? true }
          : null,
      answeredByCallback: false,
      createdMessageIds: new Set(),
      replyQueue: Promise.resolve(),
    };
    this.byHash.set(hashToken(token), principal);
    return { token, expiresAt: new Date(principal.expiresAt), principal };
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

/**
 * Run `fn` after every earlier reply operation of the same run: the
 * synchronous answer's render and callback calls never interleave, so
 * neither works from a reply message the other has just replaced.
 */
export function serializeReply<T>(principal: BehaviorCallbackPrincipal, fn: () => Promise<T>): Promise<T> {
  const run = principal.replyQueue.then(fn, fn);
  principal.replyQueue = run.catch(() => {});
  return run;
}

/** `_meta.callback` of a webhook request (#113). */
export interface CallbackMeta {
  token: string;
  /** ISO 8601. */
  expires_at: string;
  /** The bot's public base URL; the receiver calls `<api_base>/api/plugin/interactions.*`. */
  api_base: string;
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
