/**
 * command-system/plugin-action.ts
 *
 * Running a behavior's plugin action (#127 phase 2, #203), the same way for
 * every trigger — the plugin-action twin of webhook-action.ts:
 *
 *   1. the plugin must be able to take the run: installed, enabled and
 *      active, ready, with a dispatch key (the Plugin Dispatch gate, kind
 *      `behavior_action`) — and its current manifest must still declare
 *      the action. Otherwise nothing is dispatched: the user gets the
 *      failure line and the delivery a code of its own
 *      (`plugin_unavailable`, `action_undeclared`).
 *   2. a callback token is issued for the run (behavior-callback-token.ts)
 *      — the same token, principal and routes a webhook receiver gets —
 *      with a file fetcher on the plugin's registered URL, so a reply's
 *      attachments come from the plugin as its own RPC replies' do
 *      (`<plugin.url><path>`).
 *   3. the run is dispatched, signed like every Plugin Dispatch, to
 *      `endpoints.behavior_action` with the trigger's webhook `_meta` plus
 *      `callback` and `action_key` (CONTRACT_FIXTURES dispatchEnvelope
 *      `behavior_action`). No Feature or Guild Reach applies: the binding
 *      is the authorization (ADR 0003 addendum).
 *   4. the plugin answers 2xx at once and replies later with the token,
 *      like a webhook that answered `{"defer": true}`: a command keeps its
 *      "thinking…" placeholder (the caller deferred it), a message trigger
 *      shows typing, and the delivery is ok and marked `deferred`. A
 *      failed dispatch revokes the token and tells the user — unless a
 *      callback `respond` already answered, as for a webhook.
 *
 * The callers (InteractionDispatcher, MessageTriggerMatcher) build `_meta`
 * and the ReplyTarget, then hand over here. Never throws.
 */

import type { ReplyVisibility } from "../behavior/models/behavior-definition.model.js";
import type { BehaviorPluginActionRow } from "../behavior/models/behavior-plugin-action.model.js";
import type { DeliveryErrorCode } from "../behavior/behavior-deliveries.js";
import { findPluginByKey, type PluginRow } from "../plugin-system/models/plugin.model.js";
import {
  pluginDispatcher,
  type PluginDispatchDelivery,
  type PluginDispatcher,
} from "../plugin-system/plugin-dispatch.service.js";
import { declaredBehaviorActions } from "../plugin-system/plugin-behavior-actions.js";
import { behaviorCallbackTokens, callbackMetaOf } from "./behavior-callback-token.js";
import { failRun, recordRun, showDeferred } from "./behavior-run.js";
import { renderFailure, type ReplyTarget } from "./reply-renderer.js";
import { PLUGIN_FILE_TIMEOUT_MS, pluginReplyFileFetcher } from "./webhook-forwarder.service.js";

/** What a plugin action run needs from the plugin system; tests inject their own. */
export interface PluginActionDeps {
  dispatcher: Pick<PluginDispatcher, "gate" | "deliver">;
  findPlugin: (pluginKey: string) => Promise<PluginRow | null>;
  /** How long one reply's attachment downloads may take (a webhook's: its forward timeout). */
  fileTimeoutMs: number;
}

export const defaultPluginActionDeps: PluginActionDeps = {
  dispatcher: pluginDispatcher,
  findPlugin: findPluginByKey,
  fileTimeoutMs: PLUGIN_FILE_TIMEOUT_MS,
};

export interface PluginActionRun {
  deps: PluginActionDeps;
  behaviorId: number;
  binding: BehaviorPluginActionRow;
  /** The trigger's webhook `_meta`: the dispatch body, before `callback` and `action_key`. */
  meta: Record<string, unknown>;
  target: ReplyTarget;
  /** The behavior's stored reply default (replyVisibility). */
  visibility: ReplyVisibility | null;
}

/** Why a plugin can't take the run, before anything is dispatched; null when it can. */
async function refusalOf(
  run: PluginActionRun,
  plugin: PluginRow | null,
): Promise<{ errorCode: DeliveryErrorCode; error: string } | null> {
  const { pluginKey, actionKey } = run.binding;
  if (!plugin) {
    return { errorCode: "plugin_unavailable", error: `plugin '${pluginKey}' is not installed` };
  }
  const gate = await run.deps.dispatcher.gate({
    kind: "behavior_action",
    plugin,
    guildId: run.target.kind === "interaction" ? run.target.interaction.guildId : run.target.message.guildId,
  });
  if (!gate.ok) {
    return { errorCode: "plugin_unavailable", error: `plugin '${pluginKey}' cannot take it (${gate.reason})` };
  }
  if (!declaredBehaviorActions(plugin).some((a) => a.key === actionKey)) {
    return {
      errorCode: "action_undeclared",
      error: `plugin '${pluginKey}' no longer declares behavior action '${actionKey}'`,
    };
  }
  return null;
}

/** A dispatch that did not go through: its delivery code and detail. */
function deliveryFailure(
  delivery: Exclude<PluginDispatchDelivery, { status: "ok" }>,
): { errorCode: DeliveryErrorCode; error: string } {
  if (delivery.status === "skipped") {
    return { errorCode: "plugin_unavailable", error: `the plugin cannot take it (${delivery.reason})` };
  }
  switch (delivery.reason) {
    case "http_error":
      return {
        errorCode: "http_error",
        error: `the plugin answered HTTP ${delivery.httpStatus ?? "?"}${delivery.detail ? `: ${delivery.detail}` : ""}`,
      };
    case "unresolvable_endpoint":
    case "preflight_denied":
      return { errorCode: "plugin_unavailable", error: `the plugin cannot be reached: ${delivery.detail}` };
    default:
      return { errorCode: "request_failed", error: `the dispatch failed: ${delivery.detail}` };
  }
}

export async function runPluginAction(run: PluginActionRun): Promise<void> {
  const { behaviorId, binding, target } = run;
  const firedAt = new Date();
  const started = performance.now();
  let ok = false;
  let deferred = false;
  let errorCode: DeliveryErrorCode | null = null;
  let error: string | undefined;
  let httpStatus: number | null = null;

  const plugin = await run.deps.findPlugin(binding.pluginKey).catch(() => null);
  const refusal = await refusalOf(run, plugin).catch((err: unknown) => ({
    errorCode: "plugin_unavailable" as const,
    error: err instanceof Error ? err.message : String(err),
  }));
  if (refusal || !plugin) {
    // nothing went out, so there is no token to revoke
    errorCode = refusal?.errorCode ?? "plugin_unavailable";
    error = refusal?.error;
    await renderFailure(target);
  } else {
    const issued = behaviorCallbackTokens.issue({
      behaviorId,
      target,
      visibility: run.visibility,
      fetchFiles: pluginReplyFileFetcher(plugin, { behaviorId }, run.deps.fileTimeoutMs),
    });
    const { principal } = issued;
    const body = JSON.stringify({
      ...run.meta,
      callback: callbackMetaOf(issued),
      action_key: binding.actionKey,
    });
    let delivery: PluginDispatchDelivery;
    try {
      delivery = await run.deps.dispatcher.deliver({
        kind: "behavior_action",
        plugin,
        label: binding.actionKey,
        endpointVars: { action_key: binding.actionKey },
        payload: { body: () => body },
      });
    } catch (err) {
      delivery = {
        status: "failed",
        reason: "network",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    httpStatus = delivery.status === "skipped" ? null : (delivery.httpStatus ?? null);
    if (delivery.status === "ok") {
      // the plugin replies through the token
      ok = true;
      deferred = true;
      await showDeferred(target, run.visibility, principal);
    } else {
      ({ errorCode, error } = deliveryFailure(delivery));
      if (await failRun(issued.token, principal, target)) {
        ok = true;
        deferred = true;
        errorCode = null;
        error = undefined;
      }
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
    durationMs: Math.round(performance.now() - started),
    errorCode,
    error,
    verified: null,
    what: `plugin action ${binding.pluginKey}/${binding.actionKey}`,
    context: { pluginKey: binding.pluginKey, actionKey: binding.actionKey },
  });
}
