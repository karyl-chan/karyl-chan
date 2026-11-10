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
import { behaviorCallbackTokens, callbackMetaOf } from "./behavior-callback-token.js";
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
  callback: ReturnType<typeof callbackMetaOf>,
): Record<string, unknown> {
  const meta = (payload._meta ?? {}) as Record<string, unknown>;
  return { ...payload, _meta: { ...meta, callback } };
}

export async function runWebhookAction(run: WebhookActionRun): Promise<void> {
  const { behaviorId, target } = run;
  const firedAt = new Date();
  // message triggers get theirs in #200
  const issued =
    target.kind === "interaction"
      ? behaviorCallbackTokens.issue({ behaviorId, target, visibility: run.visibility })
      : null;
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
    if (result.ok && issued && result.reply.defer) deferred = true;
    else if (result.ok) {
      const rendered = await renderReply(result.reply, target, {
        visibility: run.visibility,
      });
      if (!rendered.ok) {
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
  if (issued) behaviorCallbackTokens.revoke(issued.token);
  botEventLog.record(
    "warn",
    "bot",
    `webhook action of behavior ${behaviorId} failed (${target.kind}): ${error ?? "unknown"}`,
    { behaviorId, via: target.kind },
  );
  if (!unreachable) await renderFailure(target);
}
