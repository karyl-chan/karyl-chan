/**
 * command-system/webhook-action.ts
 *
 * Running a behavior's webhook action, the same way for every trigger:
 * forward → render the reply → count the outcome → on failure, log the
 * detail and give the user only the generic line (#114, #140).
 *
 * The InteractionDispatcher (command triggers) and the MessageTriggerMatcher
 * (message triggers) each build their payload and their ReplyTarget, then
 * hand over here. Never throws.
 */

import type { BehaviorWebhookActionRow } from "../behavior/models/behavior-webhook-action.model.js";
import { recordForwardOutcome } from "../behavior/models/behavior-stats.model.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { renderFailure, renderReply, type ReplyTarget } from "./reply-renderer.js";
import type { WebhookForwarder } from "./webhook-forwarder.service.js";

export interface WebhookActionRun {
  forwarder: WebhookForwarder;
  behaviorId: number;
  webhook: BehaviorWebhookActionRow;
  payload: Record<string, unknown>;
  target: ReplyTarget;
}

export async function runWebhookAction(run: WebhookActionRun): Promise<void> {
  const { behaviorId, target } = run;
  let ok: boolean;
  let error: string | undefined;
  // an ephemeral guild reply that could not be DMed: the author can't be
  // reached privately, and the channel must not hear about it
  let unreachable = false;
  try {
    const result = await run.forwarder.forward(run.webhook, run.payload);
    ok = result.ok;
    error = result.error;
    if (result.ok) {
      const rendered = await renderReply(result.reply, target);
      if (!rendered.ok) {
        ok = false;
        unreachable = rendered.dmFailed === true;
        error = unreachable
          ? `could not DM the author: ${rendered.error}`
          : `Discord refused the reply: ${rendered.error}`;
      }
    }
  } catch (err) {
    ok = false;
    error = err instanceof Error ? err.message : String(err);
  }

  // the detail goes to the log and the stats only (#114)
  await recordForwardOutcome(behaviorId, ok, error);
  if (ok) return;
  botEventLog.record(
    "warn",
    "bot",
    `webhook action of behavior ${behaviorId} failed (${target.kind}): ${error ?? "unknown"}`,
    { behaviorId, via: target.kind },
  );
  if (!unreachable) await renderFailure(target);
}
