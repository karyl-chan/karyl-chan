/**
 * command-system/behavior-callback.ts
 *
 * What a behavior callback token (#113) may do: answer its own run, through
 * the plugin RPC paths a plugin answers an interaction with. The routes in
 * plugin-rpc-routes.ts hand a request here when the /api/plugin/* auth
 * hook resolved a callback principal instead of a plugin; this module
 * keeps the rules, the routes keep the transport.
 *
 *   interactions.respond          the run's reply: edits the message that
 *                                 holds it now (the placeholder, the
 *                                 synchronous answer or the last respond),
 *                                 or replaces it when the visibility changes
 *   interactions.followup         a new message; returns its id
 *   interactions.edit_followup    edit a message this token sent
 *   interactions.delete_followup  delete a message this token sent
 *
 * The body is a Behavior Reply, read with the same rules as a webhook's
 * synchronous answer (parseBehaviorReply) — except that a component other
 * than an https link button is refused instead of dropped. Who sees it
 * follows the same order too: the body's `ephemeral`, then the behavior's
 * stored visibility, then the command's default — so without `ephemeral`
 * a public command's reply stays public. `interaction_token` is optional
 * and ignored: the principal knows its interaction.
 *
 * A call the bot refuses, or one Discord refuses, is a failed delivery of
 * the same behavior (`callback_invalid` / `callback_failed`).
 */

import { recordDelivery, type DeliveryErrorCode } from "../behavior/behavior-deliveries.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";
import { hasVisibleReply, parseBehaviorReply, type BehaviorReply } from "./behavior-reply.js";
import { serializeReply, type BehaviorCallbackPrincipal } from "./behavior-callback-token.js";
import { deleteFollowup, editFollowup, renderFollowup, renderReply } from "./reply-renderer.js";

/** The HTTP answer for the route to send. */
export interface CallbackAnswer {
  status: number;
  body: Record<string, unknown>;
}

const COMPONENTS_REFUSED =
  "components: only link buttons (type 2, style 5) with an https url, in action rows, at most 5 rows of 5";
const NOTHING_TO_SHOW = "content, embeds or components required";
const NOT_OURS = "message_id was not sent with this callback token";

/** One callback call: the outcome, before it is recorded and answered. */
type Outcome =
  | { ok: true; body: Record<string, unknown> }
  /** The bot refused the call (`callback_invalid`). */
  | { ok: false; refused: true; status: number; error: string }
  /** Discord refused it (`callback_failed`). */
  | { ok: false; refused: false; error: string }
  /** The token was revoked while the call waited its turn: as if unknown. */
  | { ok: false; gone: true };

const refused = (status: number, error: string): Outcome => ({ ok: false, refused: true, status, error });
const failed = (error: string): Outcome => ({ ok: false, refused: false, error });
const GONE: Outcome = { ok: false, gone: true };

type Call = { principal: BehaviorCallbackPrincipal; body: Record<string, unknown> };

/** The reply in a callback body: the reply model, components refused rather than dropped. */
function readReply(body: Record<string, unknown>): { ok: true; reply: BehaviorReply } | { ok: false; error: string } {
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

/** The `message_id` of a call, when this token sent that message. */
function ownMessageId({ principal, body }: Call): string | null {
  const id = body.message_id;
  return typeof id === "string" && principal.createdMessageIds.has(id) ? id : null;
}

async function respond(call: Call): Promise<Outcome> {
  const read = readReply(call.body);
  if (!read.ok) return refused(400, read.error);
  const { principal } = call;
  const rendered = await renderReply(read.reply, principal.target, {
    visibility: principal.visibility,
    replyMessage: principal.replyMessage,
  });
  if (!rendered.ok) return failed(rendered.error);
  principal.replyMessage = rendered.replyMessage ?? null;
  principal.answeredByCallback = true;
  return { ok: true, body: { ok: true } };
}

async function followup(call: Call): Promise<Outcome> {
  const read = readReply(call.body);
  if (!read.ok) return refused(400, read.error);
  const { principal } = call;
  const sent = await renderFollowup(read.reply, principal.target.interaction, {
    visibility: principal.visibility,
  });
  if (!sent.ok) return failed(sent.error);
  principal.createdMessageIds.add(sent.messageId);
  return { ok: true, body: { ok: true, id: sent.messageId } };
}

async function editOwnFollowup(call: Call): Promise<Outcome> {
  const messageId = ownMessageId(call);
  if (!messageId) return refused(403, NOT_OURS);
  const read = readReply(call.body);
  if (!read.ok) return refused(400, read.error);
  const edited = await editFollowup(read.reply, call.principal.target.interaction, messageId);
  return edited.ok ? { ok: true, body: { ok: true } } : failed(edited.error);
}

async function deleteOwnFollowup(call: Call): Promise<Outcome> {
  const messageId = ownMessageId(call);
  if (!messageId) return refused(403, NOT_OURS);
  const deleted = await deleteFollowup(call.principal.target.interaction, messageId);
  if (!deleted.ok) return failed(deleted.error);
  call.principal.createdMessageIds.delete(messageId);
  return { ok: true, body: { ok: true } };
}

/**
 * The only /api/plugin/* methods a callback principal may call, each with
 * its handler and the prefix its Discord failure is named with (as the
 * plugin family names it). The auth hook's allow-list is these keys.
 */
const METHODS = {
  "interactions.respond": { run: respond, failedAs: "respond failed" },
  "interactions.followup": { run: followup, failedAs: "followup failed" },
  "interactions.edit_followup": { run: editOwnFollowup, failedAs: "edit followup failed" },
  "interactions.delete_followup": { run: deleteOwnFollowup, failedAs: "delete followup failed" },
} as const;

export type BehaviorCallbackMethod = keyof typeof METHODS;

export const BEHAVIOR_CALLBACK_METHODS = Object.keys(METHODS) as BehaviorCallbackMethod[];

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
    // only command triggers issue tokens so far (#200 adds messages)
    via: "command",
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

/**
 * Run one callback call for its principal, in its run's turn
 * (serializeReply): never interleaved with the synchronous answer or the
 * failure line, and refused as 401 when the token was revoked meanwhile.
 * Never throws.
 */
export async function runBehaviorCallback(
  method: BehaviorCallbackMethod,
  principal: BehaviorCallbackPrincipal,
  body: Record<string, unknown>,
): Promise<CallbackAnswer> {
  const firedAt = new Date();
  const started = performance.now();
  const { run, failedAs } = METHODS[method];
  const outcome = await serializeReply(principal, () =>
    principal.revoked ? Promise.resolve(GONE) : run({ principal, body }),
  ).catch((err: unknown) => failed(err instanceof Error ? err.message : String(err)));
  if (outcome.ok) return { status: 200, body: outcome.body };
  // the auth hook's own answer for a token it no longer knows
  if ("gone" in outcome) return { status: 401, body: { error: "plugin token invalid or expired" } };
  if (outcome.refused) {
    await recordFailure(principal, method, "callback_invalid", outcome.error, firedAt, started);
    return { status: outcome.status, body: { error: outcome.error } };
  }
  await recordFailure(principal, method, "callback_failed", outcome.error, firedAt, started);
  return { status: 400, body: { error: `${failedAs}: ${outcome.error}` } };
}
