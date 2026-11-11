/**
 * command-system/behavior-action.ts
 *
 * Running a custom behavior's action, whatever its source: a webhook
 * (webhook-action.ts) or a plugin action (plugin-action.ts, #203). The
 * InteractionDispatcher and the MessageTriggerMatcher build the trigger's
 * webhook payload and ReplyTarget, then hand over here; a plugin action
 * gets that payload's `_meta`.
 */

import type { CatalogAction, CatalogBehavior } from "../behavior/behavior-catalog.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { runPluginAction, type PluginActionDeps } from "./plugin-action.js";
import type { ReplyTarget } from "./reply-renderer.js";
import { runWebhookAction } from "./webhook-action.js";
import type { WebhookForwarder } from "./webhook-forwarder.service.js";

/**
 * The behavior's action, or null — with a warning in the event log,
 * tagged by `caller` — when it has none to run (its action row is
 * missing). The caller decides what the user sees.
 */
export function actionToRun(behavior: CatalogBehavior, caller: string): CatalogAction | null {
  if (behavior.action) return behavior.action;
  botEventLog.record(
    "warn",
    "bot",
    `${caller}: behavior ${behavior.id} 沒有 ${behavior.actionSource} 動作`,
    { behaviorId: behavior.id },
  );
  return null;
}

export interface BehaviorActionRun {
  behavior: CatalogBehavior;
  action: CatalogAction;
  /** The trigger's webhook payload (Discord webhook fields + `_meta`). */
  payload: Record<string, unknown>;
  target: ReplyTarget;
  forwarder: WebhookForwarder;
  plugins: PluginActionDeps;
}

/** Run the action. Never throws. */
export async function runBehaviorAction(run: BehaviorActionRun): Promise<void> {
  const { behavior, action, payload, target } = run;
  switch (action.source) {
    case "webhook":
      await runWebhookAction({
        forwarder: run.forwarder,
        behaviorId: behavior.id,
        webhook: action.webhook,
        payload,
        target,
        visibility: behavior.replyVisibility,
      });
      return;
    case "plugin":
      await runPluginAction({
        deps: run.plugins,
        behaviorId: behavior.id,
        binding: action.binding,
        meta: (payload._meta ?? {}) as Record<string, unknown>,
        target,
        visibility: behavior.replyVisibility,
      });
      return;
  }
}
