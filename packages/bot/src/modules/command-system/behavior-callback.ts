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
 * stored visibility, then the trigger's default — so without `ephemeral`
 * a public command's reply stays public, and a guild message's private
 * reply goes to the author's DM. `interaction_token` is optional and
 * ignored: the principal knows its interaction or message.
 *
 * A message trigger has no interaction (#200): its first `respond` sends
 * the reply (to the channel, or the author's DM), later ones edit that
 * message, and follow-ups are new messages placed the same way.
 *
 * A reply's attachments (#156) are downloaded from the run's webhook
 * origin, as for the synchronous answer; when they can't be had the call
 * fails (`attachment_failed`) and nothing is shown.
 *
 * `respond` and `followup` take `direct_messages` (#157): sent after the
 * reply (or alone, leaving the reply as it is), each outcome returned and
 * logged in the DM log, none failing the call.
 *
 * A call the bot refuses, or one Discord refuses, is a failed delivery of
 * the same behavior (`callback_invalid` / `callback_failed`).
 */

import { recordDelivery, type DeliveryErrorCode } from "../behavior/behavior-deliveries.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";
import { hasVisibleReply, parseBehaviorReply, type BehaviorReply, type DirectMessage } from "./behavior-reply.js";
import { sendDirectMessages } from "./behavior-direct-messages.js";
import { readyToRender, type RenderableReply } from "./reply-files.js";
import { serializeReply, type BehaviorCallbackPrincipal } from "./behavior-callback-token.js";
import {
  deleteFollowup,
  editFollowup,
  renderFollowup,
  renderReply,
  type ReplySlot,
} from "./reply-renderer.js";

/** The HTTP answer for the route to send. */
export interface CallbackAnswer {
  status: number;
  body: Record<string, unknown>;
}

const COMPONENTS_REFUSED =
  "components: only link buttons (type 2, style 5) with an https url, in action rows, at most 5 rows of 5";
const NOTHING_TO_SHOW = "content, embeds, components, attachments or direct_messages required";
const DMS_NOT_HERE = "direct_messages: only with interactions.respond or interactions.followup";
const DMS_BEFORE_REPLY =
  "direct_messages: the run's reply must be shown first — send content, embeds, components or attachments with them, or respond before";
const NOT_OURS = "message_id was not sent with this callback token";

/** One callback call: the outcome, before it is recorded and answered. */
type Outcome =
  | { ok: true; body: Record<string, unknown> }
  /** The bot refused the call (`callback_invalid`). */
  | { ok: false; refused: true; status: number; error: string }
  /**
   * Discord refused it (`callback_failed`), a private reply could not be
   * DMed (`dm_failed`), or its attachments could not be had (`attachment_failed`).
   */
  | { ok: false; refused: false; error: string; code: FailedCode }
  /** The token was revoked while the call waited its turn: as if unknown. */
  | { ok: false; gone: true };

const refused = (status: number, error: string): Outcome => ({ ok: false, refused: true, status, error });
type FailedCode = "callback_failed" | "dm_failed" | "attachment_failed";
const failed = (error: string, code: FailedCode = "callback_failed"): Outcome => ({
  ok: false,
  refused: false,
  error,
  code,
});
/** A render the renderer refused: Discord's refusal, or an author it could not DM. */
const renderFailed = (outcome: { error: string; dmFailed?: true }): Outcome =>
  failed(outcome.error, outcome.dmFailed ? "dm_failed" : "callback_failed");
const GONE: Outcome = { ok: false, gone: true };

type Call = { principal: BehaviorCallbackPrincipal; body: Record<string, unknown> };

/**
 * The reply in a callback body: the reply model, components refused rather
 * than dropped; `direct_messages` (#157) only where `acceptDirectMessages`.
 */
function readReply(
  body: Record<string, unknown>,
  acceptDirectMessages: boolean,
): { ok: true; reply: BehaviorReply } | { ok: false; error: string } {
  const { interaction_token: _token, message_id: _id, ...rest } = body;
  const parsed = parseBehaviorReply(rest);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.notes.some((n) => n.kind === "components_dropped" || (n.kind === "invalid_field" && n.field === "components"))) {
    return { ok: false, error: COMPONENTS_REFUSED };
  }
  const { defer: _defer, ...reply } = parsed.reply;
  if (reply.direct_messages && !acceptDirectMessages) return { ok: false, error: DMS_NOT_HERE };
  if (!hasVisibleReply(reply) && !reply.direct_messages) return { ok: false, error: NOTHING_TO_SHOW };
  return { ok: true, reply };
}

/**
 * The call's reply, ready to render: read, then its attachments
 * downloaded from the run's webhook origin (#156) — in the run's turn,
 * after the revoked check, so a refused call downloads nothing. `reply`
 * is null when the call only asks for direct messages (#157).
 */
async function replyOf(
  call: Call,
  acceptDirectMessages = false,
): Promise<
  | { ok: true; reply: RenderableReply | null; directMessages: DirectMessage[] | undefined }
  | { ok: false; outcome: Outcome }
> {
  const read = readReply(call.body, acceptDirectMessages);
  if (!read.ok) return { ok: false, outcome: refused(400, read.error) };
  const directMessages = read.reply.direct_messages;
  if (!hasVisibleReply(read.reply)) {
    // DMs alone only once the user has their reply: never while "thinking…" hangs
    if (!call.principal.replyShown) return { ok: false, outcome: refused(400, DMS_BEFORE_REPLY) };
    return { ok: true, reply: null, directMessages };
  }
  const ready = await readyToRender(read.reply, call.principal.fetchFiles);
  return ready.ok
    ? { ok: true, reply: ready.reply, directMessages }
    : { ok: false, outcome: failed(ready.error, ready.errorCode) };
}

/**
 * Send the call's direct messages (#157) once its reply was shown; their
 * outcomes go back in the answer, `direct_messages: [{ user_id, outcome }]`.
 */
async function sendCallDirectMessages(
  { principal }: Call,
  messages: DirectMessage[] | undefined,
  body: Record<string, unknown>,
): Promise<Outcome> {
  if (!messages) return { ok: true, body };
  const results = await sendDirectMessages(
    { behaviorId: principal.behaviorId, target: principal.target, fetchFiles: principal.fetchFiles },
    messages,
  );
  return { ok: true, body: { ...body, direct_messages: results } };
}

/** The message a call's `message_id` names, when this token sent it. */
function ownMessage({ principal, body }: Call): ReplySlot | null {
  const id = body.message_id;
  return typeof id === "string" ? (principal.createdMessages.get(id) ?? null) : null;
}

async function respond(call: Call): Promise<Outcome> {
  const read = await replyOf(call, true);
  if (!read.ok) return read.outcome;
  const { principal } = call;
  // only direct messages: the run's reply stays as it is
  if (read.reply) {
    const rendered = await renderReply(read.reply, principal.target, {
      visibility: principal.visibility,
      replyMessage: principal.replyMessage,
    });
    if (!rendered.ok) return renderFailed(rendered);
    principal.replyMessage = rendered.replyMessage ?? null;
    principal.answeredByCallback = true;
    principal.replyShown = true;
  }
  return sendCallDirectMessages(call, read.directMessages, { ok: true });
}

async function followup(call: Call): Promise<Outcome> {
  const read = await replyOf(call, true);
  if (!read.ok) return read.outcome;
  const { principal } = call;
  // only direct messages: no follow-up, so no id
  if (!read.reply) return sendCallDirectMessages(call, read.directMessages, { ok: true });
  const sent = await renderFollowup(read.reply, principal.target, {
    visibility: principal.visibility,
  });
  if (!sent.ok) return renderFailed(sent);
  principal.createdMessages.set(sent.sent.messageId, sent.sent);
  return sendCallDirectMessages(call, read.directMessages, { ok: true, id: sent.sent.messageId });
}

async function editOwnFollowup(call: Call): Promise<Outcome> {
  const own = ownMessage(call);
  if (!own) return refused(403, NOT_OURS);
  const read = await replyOf(call);
  if (!read.ok) return read.outcome;
  if (!read.reply) return refused(400, NOTHING_TO_SHOW);
  const edited = await editFollowup(read.reply, own);
  return edited.ok ? { ok: true, body: { ok: true } } : failed(edited.error);
}

async function deleteOwnFollowup(call: Call): Promise<Outcome> {
  const own = ownMessage(call);
  if (!own) return refused(403, NOT_OURS);
  const deleted = await deleteFollowup(own);
  if (!deleted.ok) return failed(deleted.error);
  call.principal.createdMessages.delete(own.messageId);
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
  // a private reply that could not reach the author, and attachments that
  // could not be had, are what the synchronous path calls them too
  await recordFailure(principal, method, outcome.code, outcome.error, firedAt, started);
  return { status: 400, body: { error: `${failedAs}: ${outcome.error}` } };
}
