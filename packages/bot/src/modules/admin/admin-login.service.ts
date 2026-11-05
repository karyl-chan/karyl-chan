import { jwtService } from "../web-core/jwt.service.js";
import { resolveLoginRole } from "./authorized-user.service.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { config } from "../../config.js";

/**
 * Admin login link issuance: resolve the caller's role, sign a one-time
 * login token, build the admin URL. The system login's built-in action
 * (command-system/builtin-login-action.ts) turns the result into a
 * behavior reply; the ReplyRenderer delivers it like any other reply.
 */

function buildBaseUrl(): string {
  if (config.web.baseUrl) return config.web.baseUrl.replace(/\/+$/, "");
  return `http://localhost:${config.web.port}`;
}

export type LoginLinkResult =
  | { ok: false; reason: string }
  | { ok: true; url: string; minutesUntilExpiry: number; role: string };

export interface LoginContextRefs {
  guildId: string | null;
  channelId: string;
  /** Source message id, when triggered from a chat message; null for slash. */
  messageId: string | null;
}

export async function mintLoginLink(
  userId: string,
  ctx: LoginContextRefs,
): Promise<LoginLinkResult> {
  // Owner OR anyone listed in authorized_users with at least one
  // active capability. Strip-of-all-capabilities is treated as
  // "deauthorized" — caller stays silent rather than tipping off
  // the sender that their userId is in the table.
  const role = await resolveLoginRole(userId);
  if (!role) return { ok: false, reason: "not authorized" };
  const { token, expiresAt } = jwtService.sign({
    purpose: "login",
    userId,
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    // jwt.service.sign requires messageId — for slash-command
    // invocations there's no source message, so use the interaction
    // id (also stored on ctx.channelId? no — interaction-route caller
    // passes interaction.id semantically here via the channelId
    // shouldn't conflate). Easiest fix: synthesize a stable sentinel
    // so the audit trail still has SOMETHING the verify side accepts.
    messageId: ctx.messageId ?? `slash:${ctx.channelId}:${userId}`,
  });
  const url = `${buildBaseUrl()}/admin/auth?token=${encodeURIComponent(token)}`;
  const minutesUntilExpiry = Math.max(
    1,
    Math.round((expiresAt - Date.now()) / 60_000),
  );
  botEventLog.record(
    "info",
    "feature",
    `Admin login link issued to ${userId}`,
    {
      userId,
      role,
      expiresAt,
      guildId: ctx.guildId,
      channelId: ctx.channelId,
    },
  );
  return { ok: true, url, minutesUntilExpiry, role };
}
