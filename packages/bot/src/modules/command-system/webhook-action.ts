/**
 * command-system/webhook-action.ts
 *
 * Running a behavior's webhook action, the same way for every trigger:
 * forward → render the reply → count the outcome and log the delivery →
 * on failure, log the detail and give the user only the generic line
 * (#114, #140, #120).
 *
 * The InteractionDispatcher (command triggers) and the MessageTriggerMatcher
 * (message triggers) each build their payload and their ReplyTarget, then
 * hand over here. Never throws.
 *
 * Every run also gets a callback token (#113, #200), sent in
 * `_meta.callback`: the receiver may answer `{"defer": true}` and reply
 * later with it — a command keeps its "thinking…" placeholder, a message
 * trigger shows typing — and the rest of that answer is not shown. A
 * deferred run is an ok delivery marked `deferred`; a failed run's token
 * is revoked, since the user was already told.
 * The synchronous answer and the callback calls take turns on the reply
 * (serializeReply); once a callback `respond` has landed, a synchronous
 * answer — or failure line — arriving after it is not shown, and the
 * delivery is ok and marked `deferred` (its reply came through the
 * token), even when the synchronous request itself failed.
 *
 * A reply with attachments (#156) is shown only with its files, which the
 * forwarder downloads from the webhook URL's origin in the run's turn, once
 * the answer is known to be shown (not superseded); when they can't be
 * had the run fails (`attachment_failed`) and the user gets the failure
 * line — never the reply without them.
 *
 * A reply's direct messages (#157) are sent after it was shown, and only
 * then (not for a deferred, superseded or failed answer); each has its own
 * outcome in the DM log and none fails the run.
 */

import type { BehaviorWebhookActionRow } from "../behavior/models/behavior-webhook-action.model.js";
import type { ReplyVisibility } from "../behavior/models/behavior-definition.model.js";
import type { DeliveryErrorCode } from "../behavior/behavior-deliveries.js";
import { renderReply, type ReplyTarget } from "./reply-renderer.js";
import {
  behaviorCallbackTokens,
  callbackMetaOf,
  serializeReply,
  type BehaviorCallbackPrincipal,
  type CallbackMeta,
} from "./behavior-callback-token.js";
import { failRun, recordRun, showDeferred } from "./behavior-run.js";
import type { BehaviorReply, DirectMessage } from "./behavior-reply.js";
import { sendDirectMessages } from "./behavior-direct-messages.js";
import { readyToRender, type ReplyFileFetcher } from "./reply-files.js";
import type { RenderOutcome } from "./reply-renderer.js";
import type { ForwardResult } from "./types.js";
import type { WebhookForwarder } from "./webhook-forwarder.service.js";

export interface WebhookActionRun {
  forwarder: WebhookForwarder;
  behaviorId: number;
  webhook: BehaviorWebhookActionRow;
  payload: Record<string, unknown>;
  target: ReplyTarget;
  /** The behavior's stored reply default (replyVisibility). */
  visibility: ReplyVisibility | null;
}

/** A failed forward's code: the forwarder's own, else what its status says. */
function forwardErrorCode(result: ForwardResult): DeliveryErrorCode {
  if (result.errorCode) return result.errorCode;
  if (result.status === undefined) return "request_failed";
  return result.status >= 200 && result.status < 300 ? "invalid_reply" : "http_error";
}

/** The payload with `_meta.callback` added. */
function withCallback(
  payload: Record<string, unknown>,
  callback: CallbackMeta,
): Record<string, unknown> {
  const meta = (payload._meta ?? {}) as Record<string, unknown>;
  return { ...payload, _meta: { ...meta, callback } };
}

/** The synchronous answer's attachments could not be had (#156). */
type AttachmentFailure = Extract<Awaited<ReturnType<typeof readyToRender>>, { ok: false }>;

/**
 * Show the synchronous answer in the run's current reply message, or not
 * at all ("superseded") when a callback `respond` already answered. Its
 * attachments are downloaded in the run's turn, once it is known to be
 * shown: a superseded answer downloads nothing.
 */
async function renderAnswer(
  run: WebhookActionRun,
  principal: BehaviorCallbackPrincipal,
  reply: BehaviorReply,
): Promise<RenderOutcome | AttachmentFailure | "superseded"> {
  return serializeReply(principal, async () => {
    if (principal.answeredByCallback) return "superseded" as const;
    const ready = await readyToRender(reply, principal.fetchFiles);
    if (!ready.ok) return ready;
    const rendered = await renderReply(ready.reply, run.target, {
      visibility: run.visibility,
      replyMessage: principal.replyMessage,
    });
    if (rendered.ok) {
      principal.replyMessage = rendered.replyMessage ?? null;
      principal.replyShown = true;
    }
    return rendered;
  });
}

export async function runWebhookAction(run: WebhookActionRun): Promise<void> {
  const { behaviorId, target } = run;
  const firedAt = new Date();
  // a reply's attachments come from the run's webhook origin (#156), for
  // the synchronous answer and the callback calls alike
  const fetchFiles: ReplyFileFetcher = (attachments) =>
    run.forwarder.fetchReplyFiles(run.webhook, attachments);
  const issued = behaviorCallbackTokens.issue({ behaviorId, target, visibility: run.visibility, fetchFiles });
  const { principal } = issued;
  const payload = withCallback(run.payload, callbackMetaOf(issued));
  let deferred = false;
  const started = performance.now();
  let ok: boolean;
  let error: string | undefined;
  let errorCode: DeliveryErrorCode | null = null;
  let httpStatus: number | null = null;
  let verified: ForwardResult["verified"] | null = null;
  // an ephemeral guild reply that could not be DMed: the author can't be
  // reached privately, and the channel must not hear about it
  let unreachable = false;
  let directMessages: DirectMessage[] | undefined;
  try {
    const result = await run.forwarder.forward(run.webhook, payload);
    ok = result.ok;
    error = result.error;
    httpStatus = result.status ?? null;
    verified = result.verified ?? null;
    if (!result.ok) errorCode = forwardErrorCode(result);
    // the receiver answers with the token: a command's placeholder
    // stays, a message trigger shows typing
    if (result.ok && result.reply.defer) {
      deferred = true;
      await showDeferred(target, run.visibility, principal);
    } else if (result.ok) {
      const rendered = await renderAnswer(run, principal, result.reply);
      // its direct messages go once the reply itself was shown (#157)
      if (rendered !== "superseded" && rendered.ok) directMessages = result.reply.direct_messages;
      if (rendered === "superseded") deferred = true;
      else if (!rendered.ok && "errorCode" in rendered) {
        // a reply is never shown without its files (#156)
        ok = false;
        errorCode = rendered.errorCode;
        error = rendered.error;
      } else if (!rendered.ok) {
        ok = false;
        unreachable = rendered.dmFailed === true;
        errorCode = unreachable ? "dm_failed" : "render_failed";
        error = unreachable
          ? `could not DM the author: ${rendered.error}`
          : `Discord refused the reply: ${rendered.error}`;
      }
    }
  } catch (err) {
    ok = false;
    errorCode = "request_failed";
    error = err instanceof Error ? err.message : String(err);
  }
  const durationMs = Math.round(performance.now() - started);

  // a failed run: ok after all when a callback respond already answered
  // (behavior-run.ts); an author who can't be DMed is not told again
  if (!ok) {
    const answered = await failRun(issued.token, principal, target, !unreachable);
    if (answered) {
      ok = true;
      deferred = true;
      errorCode = null;
      error = undefined;
    }
  }

  // the detail goes to the log, the stats and the delivery log only (#114)
  await recordRun({
    behaviorId,
    firedAt,
    target,
    ok,
    deferred,
    httpStatus,
    durationMs,
    errorCode,
    error,
    verified,
    what: "webhook action",
  });
  // after the delivery is logged: a DM's outcome is its own, never the run's
  await sendDirectMessages({ behaviorId, target, fetchFiles }, directMessages);
}
