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
 * A command trigger's run also gets a callback token (#113), sent in
 * `_meta.callback`: the receiver may answer `{"defer": true}` and reply
 * later with it. A deferred run is an ok delivery marked `deferred`; a
 * failed run's token is revoked, since the user was already told.
 * The synchronous answer and the callback calls take turns on the reply
 * (serializeReply); once a callback `respond` has landed, a synchronous
 * answer — or failure line — arriving after it is not shown, and the
 * delivery is ok and marked `deferred` (its reply came through the
 * token), even when the synchronous request itself failed.
 */

import type { BehaviorWebhookActionRow } from "../behavior/models/behavior-webhook-action.model.js";
import type { ReplyVisibility } from "../behavior/models/behavior-definition.model.js";
import { recordForwardOutcome } from "../behavior/models/behavior-stats.model.js";
import {
  recordDelivery,
  type DeliveryErrorCode,
} from "../behavior/behavior-deliveries.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { renderFailure, renderReply, type ReplyTarget } from "./reply-renderer.js";
import {
  behaviorCallbackTokens,
  callbackMetaOf,
  serializeReply,
  type BehaviorCallbackPrincipal,
  type CallbackMeta,
} from "./behavior-callback-token.js";
import type { BehaviorReply } from "./behavior-reply.js";
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

/**
 * Show the synchronous answer — in the run's current reply message when
 * it has a callback principal, and not at all ("superseded") when a
 * callback `respond` already answered.
 */
async function renderAnswer(
  run: WebhookActionRun,
  principal: BehaviorCallbackPrincipal | null,
  reply: BehaviorReply,
): Promise<RenderOutcome | "superseded"> {
  if (!principal) return renderReply(reply, run.target, { visibility: run.visibility });
  return serializeReply(principal, async () => {
    if (principal.answeredByCallback) return "superseded" as const;
    const rendered = await renderReply(reply, run.target, {
      visibility: run.visibility,
      replyMessage: principal.replyMessage,
    });
    if (rendered.ok) principal.replyMessage = rendered.replyMessage ?? null;
    return rendered;
  });
}

export async function runWebhookAction(run: WebhookActionRun): Promise<void> {
  const { behaviorId, target } = run;
  const firedAt = new Date();
  // message triggers get theirs in #200
  const issued =
    target.kind === "interaction"
      ? behaviorCallbackTokens.issue({ behaviorId, target, visibility: run.visibility })
      : null;
  const principal = issued?.principal ?? null;
  const payload = issued ? withCallback(run.payload, callbackMetaOf(issued)) : run.payload;
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
  try {
    const result = await run.forwarder.forward(run.webhook, payload);
    ok = result.ok;
    error = result.error;
    httpStatus = result.status ?? null;
    verified = result.verified ?? null;
    if (!result.ok) errorCode = forwardErrorCode(result);
    // the placeholder stays; the receiver answers with the token
    if (result.ok && principal && result.reply.defer) deferred = true;
    else if (result.ok) {
      const rendered = await renderAnswer(run, principal, result.reply);
      if (rendered === "superseded") deferred = true;
      else if (!rendered.ok) {
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

  // A failed run with a callback principal: in the run's turn, either a
  // callback respond already answered — the user saw a reply, so the
  // delivery is ok and marked deferred — or the token is revoked and the
  // user told, before any later callback call can get in.
  let told = false;
  if (!ok && principal && issued) {
    const answered = await serializeReply(principal, async () => {
      if (principal.answeredByCallback) return true;
      behaviorCallbackTokens.revoke(issued.token);
      if (!unreachable) await renderFailure(target);
      return false;
    });
    told = true;
    if (answered) {
      ok = true;
      deferred = true;
      errorCode = null;
      error = undefined;
    }
  }

  // the detail goes to the log, the stats and the delivery log only (#114)
  await recordForwardOutcome(behaviorId, ok, error);
  await recordDelivery({
    behaviorId,
    firedAt,
    via: target.kind === "interaction" ? "command" : "message",
    ok,
    httpStatus,
    durationMs,
    errorCode,
    error: ok ? null : (error ?? "unknown"),
    verified,
    deferred,
  });
  if (ok) return;
  botEventLog.record(
    "warn",
    "bot",
    `webhook action of behavior ${behaviorId} failed (${target.kind}): ${error ?? "unknown"}`,
    { behaviorId, via: target.kind },
  );
  if (!unreachable && !told) await renderFailure(target);
}
