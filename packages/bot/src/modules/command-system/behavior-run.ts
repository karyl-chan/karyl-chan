/**
 * command-system/behavior-run.ts
 *
 * What every run of a behavior's action shares once it has gone out — a
 * webhook's (webhook-action.ts) and a plugin action's (plugin-action.ts):
 *
 *   - showDeferred: the reply comes later, through the callback token —
 *     a command keeps its "thinking…", a message trigger shows typing;
 *   - failRun: a failed run, in its reply turn — a callback `respond`
 *     that already answered makes it ok (the user saw a reply); otherwise
 *     the token is revoked and the user told, before any later callback
 *     call can get in;
 *   - recordRun: the outcome in the behavior's statistics and delivery
 *     log, and a warning in the bot event log when it failed. The detail
 *     never reaches the user (#114).
 */

import type { ReplyVisibility } from "../behavior/models/behavior-definition.model.js";
import { recordForwardOutcome } from "../behavior/models/behavior-stats.model.js";
import { recordDelivery, type DeliveryErrorCode } from "../behavior/behavior-deliveries.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import {
  behaviorCallbackTokens,
  serializeReply,
  type BehaviorCallbackPrincipal,
} from "./behavior-callback-token.js";
import { renderFailure, sendTypingFor, type ReplyTarget } from "./reply-renderer.js";

/** The run's reply comes later: a message trigger shows typing (a command's placeholder stays). */
export async function showDeferred(
  target: ReplyTarget,
  visibility: ReplyVisibility | null,
  principal: BehaviorCallbackPrincipal,
): Promise<void> {
  if (target.kind === "message" && !principal.answeredByCallback) {
    await sendTypingFor(target.message, visibility);
  }
}

/**
 * Settle a failed run in its reply turn. True when a callback `respond`
 * already answered: the run is then ok and deferred. Otherwise the token
 * is revoked and — unless `tellUser` is false (an author who can't be
 * DMed) — the user gets the failure line.
 */
export function failRun(
  token: string,
  principal: BehaviorCallbackPrincipal,
  target: ReplyTarget,
  tellUser = true,
): Promise<boolean> {
  return serializeReply(principal, async () => {
    if (principal.answeredByCallback) return true;
    behaviorCallbackTokens.revoke(token);
    if (tellUser) await renderFailure(target);
    return false;
  });
}

export interface RunOutcome {
  behaviorId: number;
  firedAt: Date;
  target: ReplyTarget;
  ok: boolean;
  deferred: boolean;
  httpStatus: number | null;
  durationMs: number;
  errorCode: DeliveryErrorCode | null;
  error: string | undefined;
  verified: "hmac" | "token" | null;
  /** The action in the event log's words: `webhook action`, `plugin action <key>/<action>`. */
  what: string;
  /** Extra context for the event log's warning. */
  context?: Record<string, unknown>;
}

/** Statistics, the delivery log, and a warning when the run failed. */
export async function recordRun(run: RunOutcome): Promise<void> {
  const { behaviorId, target, ok, error } = run;
  await recordForwardOutcome(behaviorId, ok, error);
  await recordDelivery({
    behaviorId,
    firedAt: run.firedAt,
    via: target.kind === "interaction" ? "command" : "message",
    ok,
    httpStatus: run.httpStatus,
    durationMs: run.durationMs,
    errorCode: run.errorCode,
    error: ok ? null : (error ?? "unknown"),
    verified: run.verified,
    deferred: run.deferred,
  });
  if (ok) return;
  botEventLog.record(
    "warn",
    "bot",
    `${run.what} of behavior ${behaviorId} failed (${target.kind}): ${error ?? "unknown"}`,
    { behaviorId, via: target.kind, ...run.context },
  );
}
