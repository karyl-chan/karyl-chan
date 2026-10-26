/**
 * Behavior writes → admin_audit_log (#98). Every write route records one
 * entry after its change is committed; the hash chain makes the trail
 * tamper-evident.
 *
 * Actions are `behavior.<thing>.<verb>`; targets name the row
 * (`behavior:<id>`, `command:<id>`, `group:<name>`, `location:<key>` —
 * a Message Trigger Location).
 * Contexts carry what changed — never a webhook secret, never a webhook
 * URL in plaintext (a URL often embeds a token): see webhookAuditView.
 */

import type { FastifyRequest } from "fastify";
import { recordAudit } from "../admin/admin-audit.service.js";
import { botEventLog } from "../bot-events/bot-event-log.js";

export type BehaviorAuditAction =
  | "behavior.create"
  | "behavior.update"
  | "behavior.delete"
  | "behavior.reorder"
  | "behavior.webhook_secret.rotate"
  | "behavior.group_members.replace";

/**
 * Record one behavior write. Never throws: it runs after the write is
 * committed (and, for commands, registered with Discord), so failing the
 * request here would report as failed a change that took effect. The
 * audit observes, it does not veto — recordAudit already logs its own DB
 * failures; anything else is logged here as an error.
 */
export async function auditBehaviorWrite(
  request: FastifyRequest,
  action: BehaviorAuditAction,
  target: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await recordAudit(request.authUserId ?? "unknown", action, target, context);
  } catch (err) {
    botEventLog.record(
      "error",
      "error",
      `behavior audit write failed: ${action} ${target} (${err instanceof Error ? err.message : String(err)})`,
      { action, target },
    );
  }
}
