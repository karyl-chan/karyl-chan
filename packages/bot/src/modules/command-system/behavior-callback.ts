/**
 * command-system/behavior-callback.ts
 *
 * What a behavior callback token (#113) may do: answer its own run, through
 * the plugin RPC paths a plugin answers an interaction with. The routes in
 * plugin-rpc-routes.ts hand a request here when the /api/plugin/* auth
 * hook resolved a callback principal instead of a plugin; this module
 * keeps the rules, the routes keep the transport.
 *
 *   interactions.respond          fill (or replace) the run's reply, as the
 *                                 synchronous answer would have
 *   interactions.followup         a new message; returns its id
 *   interactions.edit_followup    edit a message this token sent
 *   interactions.delete_followup  delete a message this token sent
 *
 * The body is a Behavior Reply, read with the same rules as a webhook's
 * synchronous answer (parseBehaviorReply) — except that a component other
 * than an https link button is refused instead of dropped. Who sees it
 * follows the behavior's stored visibility, so a public command's reply
 * is never turned private. `interaction_token` is optional and ignored:
 * the principal knows its interaction.
 *
 * A call the bot refuses, or one Discord refuses, is a failed delivery of
 * the same behavior (`callback_invalid` / `callback_failed`).
 */

import { recordDelivery, type DeliveryErrorCode } from "../behavior/behavior-deliveries.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";
import { hasVisibleReply, parseBehaviorReply, type BehaviorReply } from "./behavior-reply.js";
import type { BehaviorCallbackPrincipal } from "./behavior-callback-token.js";
import { deleteFollowup, editFollowup, renderFollowup, renderReply } from "./reply-renderer.js";

/** The only /api/plugin/* methods a callback principal may call. */
export const BEHAVIOR_CALLBACK_METHODS = [
  "interactions.respond",
  "interactions.followup",
  "interactions.edit_followup",
  "interactions.delete_followup",
] as const;

export type BehaviorCallbackMethod = (typeof BEHAVIOR_CALLBACK_METHODS)[number];

/** The HTTP answer for the route to send. */
export interface CallbackAnswer {
  status: number;
  body: Record<string, unknown>;
}

const COMPONENTS_REFUSED =
  "components: only link buttons (type 2, style 5) with an https url, in action rows, at most 5 rows of 5";
const NOTHING_TO_SHOW = "content, embeds or components required";
const NOT_OURS = "message_id was not sent with this callback token";

/** The Discord verb each method's failure is named after, as the plugin family names it. */
const FAILED_PREFIX: Record<BehaviorCallbackMethod, string> = {
  "interactions.respond": "respond failed",
  "interactions.followup": "followup failed",
  "interactions.edit_followup": "edit followup failed",
  "interactions.delete_followup": "delete followup failed",
};

type ReplyRead = { ok: true; reply: BehaviorReply } | { ok: false; error: string };

/** The reply in a callback body: the reply model, components refused rather than dropped. */
function readReply(body: Record<string, unknown>): ReplyRead {
  const { interaction_token: _token, message_id: _id, ...rest } = body;
  const parsed = parseBehaviorReply(rest);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.notes.some((n) => n.kind === "components_dropped" || (n.kind === "invalid_field" && n.field === "components"))) {
    return { ok: false, error: COMPONENTS_REFUSED };
  }
  const { defer: _defer, ...reply } = parsed.reply;
  if (!hasVisibleReply(reply)) return { ok: false, error: NOTHING_TO_SHOW };
  return { ok: true, reply };
}

async function recordFailure(
  principal: BehaviorCallbackPrincipal,
  method: BehaviorCallbackMethod,
  errorCode: DeliveryErrorCode,
  error: string,
  firedAt: Date,
  started: number,
): Promise<void> {
  const detail = `${method}: ${error}`;
  await recordDelivery({
    behaviorId: principal.behaviorId,
    firedAt,
    via: principal.target.kind === "interaction" ? "command" : "message",
    ok: false,
    httpStatus: null,
    durationMs: Math.round(performance.now() - started),
    errorCode,
    error: detail,
    verified: null,
  });
  if (shouldRecord(`behavior-callback-failed:${principal.behaviorId}`)) {
    botEventLog.record(
      "warn",
      "bot",
      `behavior callback of behavior ${principal.behaviorId} failed: ${detail}`,
      { behaviorId: principal.behaviorId, method },
    );
  }
}

/** Run one callback call for its principal. Never throws. */
export async function runBehaviorCallback(
  method: BehaviorCallbackMethod,
  principal: BehaviorCallbackPrincipal,
  body: Record<string, unknown>,
): Promise<CallbackAnswer> {
  const firedAt = new Date();
  const started = performance.now();
  const refuse = async (status: number, error: string): Promise<CallbackAnswer> => {
    await recordFailure(principal, method, "callback_invalid", error, firedAt, started);
    return { status, body: { error } };
  };
  const fail = async (error: string): Promise<CallbackAnswer> => {
    await recordFailure(principal, method, "callback_failed", error, firedAt, started);
    return { status: 400, body: { error: `${FAILED_PREFIX[method]}: ${error}` } };
  };
  const { interaction } = principal.target;
  const messageId = typeof body.message_id === "string" ? body.message_id : null;

  if (method === "interactions.delete_followup") {
    if (!messageId || !principal.createdMessageIds.has(messageId)) return refuse(403, NOT_OURS);
    const deleted = await deleteFollowup(interaction, messageId);
    if (!deleted.ok) return fail(deleted.error);
    principal.createdMessageIds.delete(messageId);
    return { status: 200, body: { ok: true } };
  }

  if (method === "interactions.edit_followup" && (!messageId || !principal.createdMessageIds.has(messageId))) {
    return refuse(403, NOT_OURS);
  }
  const read = readReply(body);
  if (!read.ok) return refuse(400, read.error);
  const { reply } = read;

  switch (method) {
    case "interactions.respond": {
      const rendered = await renderReply(reply, principal.target, { visibility: principal.visibility });
      if (!rendered.ok) return fail(rendered.error);
      return { status: 200, body: { ok: true } };
    }
    case "interactions.followup": {
      const sent = await renderFollowup(reply, interaction, { visibility: principal.visibility });
      if (!sent.ok) return fail(sent.error);
      principal.createdMessageIds.add(sent.messageId);
      return { status: 200, body: { ok: true, id: sent.messageId } };
    }
    case "interactions.edit_followup": {
      const edited = await editFollowup(reply, interaction, messageId!);
      if (!edited.ok) return fail(edited.error);
      return { status: 200, body: { ok: true } };
    }
  }
}
