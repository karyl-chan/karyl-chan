/**
 * command-system/behavior-callback-token.ts
 *
 * Behavior callback tokens (#113): each time a behavior's webhook action
 * runs, the bot issues one opaque token for that run and sends it to the
 * receiver in `_meta.callback` — and to a plugin action's plugin in the
 * dispatch's `callback` (#203). With it the receiver may answer later,
 * through `/api/plugin/interactions.respond` / `followup` /
 * `edit_followup` / `delete_followup` — for that run's reply only.
 *
 * The token stands in for the Discord interaction token, which never
 * leaves the bot: the interaction itself stays here, in the token's
 * principal. A token ends when the interaction token does — 15 minutes
 * after the interaction was created — so a late call is a 401, never a
 * Discord refusal. A message trigger (#200) has no interaction: its token
 * keeps the triggering message and ends 15 minutes after it was sent; the
 * bot answers by sending and editing messages of its own.
 *
 * In memory only, like the plugin defer state and plugin tokens: a token
 * means nothing to another process, and a restart forgets every token
 * (the receiver's next call gets 401). The token itself is never kept,
 * only its SHA-256.
 */

import { createHash, randomBytes } from "crypto";
import type { ReplyVisibility } from "../behavior/models/behavior-definition.model.js";
import { publicBaseUrl } from "../web-core/public-base-url.js";
import type { ReplySlot, ReplyTarget } from "./reply-renderer.js";
import type { ReplyFileFetcher } from "./reply-files.js";

/** How long a callback token is good for: Discord's interaction token lifetime. */
export const CALLBACK_TOKEN_TTL_MS = 15 * 60 * 1000;

const SWEEP_INTERVAL_MS = 60_000;

/**
 * What the token is issued for: a command trigger's (already deferred)
 * interaction, or a message trigger's message.
 */
export interface CallbackIssue {
  behaviorId: number;
  target: ReplyTarget;
  /** The behavior's stored reply default (replyVisibility). */
  visibility: ReplyVisibility | null;
  /**
   * Downloads a reply's attachments for this run (#156): a webhook run's
   * come from its webhook URL's origin, a plugin action's from the
   * plugin's registered URL, path prefix included (#203). Unset: a reply with attachments is
   * refused.
   */
  fetchFiles?: ReplyFileFetcher;
}

/**
 * The principal a callback token resolves to: one run, and the state its
 * reply is in. Only `serializeReply` callers change `replyMessage` and
 * `answeredByCallback`.
 *
 * What it keeps for up to 15 minutes, and what bounds it: a command's
 * interaction; for a message trigger only the TriggerMessage (ids, a
 * timestamp, and its channel, author and guild — cache objects the bot
 * holds anyway), never the message; per sent message a slot of ids plus
 * its channel; and a webhook run's fetcher, which holds the run's
 * (encrypted) webhook action row and the forwarder. Runs are
 * capped by takeBehaviorRun (5 per 10 s per command user, per guild
 * channel, per bot-DM user); a run's follow-ups by the 60-a-minute
 * callback throttle.
 */
export interface BehaviorCallbackPrincipal extends Readonly<CallbackIssue> {
  readonly expiresAt: number;
  /**
   * The message that holds the run's reply now: a command's deferred
   * placeholder at first (a message trigger has none), then whatever the
   * synchronous answer or the last `respond` left; null when there is
   * none (an empty answer deleted it, or nothing was sent yet). `respond`
   * edits it, replaces it when the visibility changes, or sends one.
   */
  replyMessage: ReplySlot | null;
  /** A callback `respond` landed: a synchronous answer arriving after it is not shown. */
  answeredByCallback: boolean;
  /**
   * The run's reply was shown — its synchronous answer or a `respond`
   * rendered — so a call of only `direct_messages` (#157) no longer
   * leaves "thinking…" hanging while others get DMs.
   */
  replyShown: boolean;
  /**
   * Revoked (its run failed and the user was told): a call that passed
   * the auth hook before that is refused when its turn comes.
   */
  revoked: boolean;
  /** This run's key (not the token): what its write throttle counts by. */
  readonly runKey: string;
  /** The follow-ups sent with this token, by id — the only messages `edit_followup` / `delete_followup` may touch. */
  readonly createdMessages: Map<string, ReplySlot>;
  /** Tail of the run's reply operations (serializeReply). */
  replyQueue: Promise<unknown>;
}

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** When the run began: the interaction's creation or the message's, else now. */
function startOf(target: ReplyTarget): number {
  const created =
    target.kind === "interaction" ? target.interaction.createdTimestamp : target.message.createdTimestamp;
  return typeof created === "number" && Number.isFinite(created) ? created : Date.now();
}

export class BehaviorCallbackTokenStore {
  private readonly byHash = new Map<string, BehaviorCallbackPrincipal>();
  private sweepTimer: NodeJS.Timeout | null = null;

  /** Issue a token for one run. The token is returned once and never stored. */
  issue(input: CallbackIssue): { token: string; expiresAt: Date; principal: BehaviorCallbackPrincipal } {
    this.ensureSweep();
    const token = randomBytes(32).toString("base64url");
    const { target } = input;
    const hash = hashToken(token);
    const principal: BehaviorCallbackPrincipal = {
      behaviorId: input.behaviorId,
      visibility: input.visibility,
      ...(input.fetchFiles ? { fetchFiles: input.fetchFiles } : {}),
      target:
        target.kind === "interaction"
          ? target
          : {
              kind: "message",
              message: {
                id: target.message.id,
                guildId: target.message.guildId,
                createdTimestamp: target.message.createdTimestamp,
                channel: target.message.channel,
                author: target.message.author,
                guild: target.message.guild,
              },
            },
      runKey: hash,
      expiresAt: startOf(target) + CALLBACK_TOKEN_TTL_MS,
      // a webhook's command is deferred before the token is issued
      replyMessage:
        target.kind === "interaction" && (target.interaction.deferred || target.interaction.replied)
          ? {
              kind: "interaction",
              interaction: target.interaction,
              messageId: "@original",
              ephemeral: target.interaction.ephemeral ?? true,
            }
          : null,
      answeredByCallback: false,
      replyShown: false,
      revoked: false,
      createdMessages: new Map(),
      replyQueue: Promise.resolve(),
    };
    this.byHash.set(hash, principal);
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
    const hash = hashToken(token);
    const principal = this.byHash.get(hash);
    if (principal) principal.revoked = true;
    this.byHash.delete(hash);
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
