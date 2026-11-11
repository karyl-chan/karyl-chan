/**
 * command-system/service-login-action.ts
 *
 * A Service Behavior's action (#126): log whoever triggered it in to the
 * service. A Service Token is minted for them (service-token.ts: `sub`,
 * `name`, `avatar`, `aud` = the service's audience, 120 s, one `jti`) and
 * the reply — a RenderableReply, delivered by the ReplyRenderer like the
 * login's — is an embed and a link button to the service's redirect URL
 * with the token as its `token` parameter. The URL is only the button's
 * target, never in the text, so a link preview or a log line can't pick
 * up the token.
 *
 * Always `ephemeral: true`: a bot DM ignores the flag, a command shows it
 * to the invoker only, and were it ever answered in a guild channel the
 * renderer would DM the author rather than post it.
 *
 * Who may log in is decided by the trigger (its audience); the action
 * vouches for whoever reached it, and the service decides what they may do.
 */

import type { User } from "discord.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { moduleLogger } from "../../logger.js";
import { serviceBehaviorTitle, type ServiceRow } from "../behavior/models/service.model.js";
import { mintServiceToken, type ServiceTokenUser } from "../web-core/service-token.js";
import { SERVICE_TOKEN_TTL_SECONDS } from "../web-core/jwt.service.js";
import type { RenderableReply } from "./reply-files.js";
import { renderFailure, renderReply, type ReplyTarget } from "./reply-renderer.js";

const log = moduleLogger("service-login");

/** What the action needs of a service. */
export type ServiceLoginTarget = Pick<ServiceRow, "name" | "audience" | "redirectUrl">;

/** The user a token vouches for, as Discord shows them. */
export function serviceTokenUserOf(
  user: Pick<User, "id" | "username"> & {
    globalName?: string | null;
    avatarURL?: () => string | null;
  },
): ServiceTokenUser {
  return {
    id: user.id,
    name: user.globalName ?? user.username,
    avatar: user.avatarURL?.() ?? null,
  };
}

/** The redirect URL with the token as its `token` parameter. */
export function serviceLoginLink(redirectUrl: string, token: string): string {
  const url = new URL(redirectUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export function serviceLoginReply(service: ServiceLoginTarget, link: string): RenderableReply {
  return {
    embeds: [
      {
        color: 0x5865f2,
        title: serviceBehaviorTitle(service.name),
        description: "點下方按鈕登入。連結只能使用一次，請勿轉發。",
        fields: [{ name: "有效時間", value: `${SERVICE_TOKEN_TTL_SECONDS} 秒`, inline: true }],
      },
    ],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: "前往登入", url: link }] }],
    ephemeral: true,
  };
}

/**
 * Run the service login for whoever triggered it and deliver the reply.
 * Never throws: a failure is logged, recorded in the bot event log, and
 * the user gets the generic failure line (#114) — unless the reply could
 * not be DMed, when nothing is said anywhere.
 */
export async function runServiceLoginAction(
  target: ReplyTarget,
  service: ServiceLoginTarget,
): Promise<void> {
  const user = target.kind === "interaction" ? target.interaction.user : target.message.author;
  try {
    const { token, jti } = mintServiceToken(serviceTokenUserOf(user), service.audience);
    const rendered = await renderReply(
      serviceLoginReply(service, serviceLoginLink(service.redirectUrl, token)),
      target,
    );
    if (!rendered.ok) {
      log.warn({ error: rendered.error, audience: service.audience }, `service login reply refused (${target.kind})`);
      botEventLog.record("error", "feature", "Service login reply failed", {
        userId: user.id,
        audience: service.audience,
        via: target.kind,
        error: rendered.error,
      });
      if (!rendered.dmFailed) await renderFailure(target);
      return;
    }
    log.info({ userId: user.id, audience: service.audience, jti }, "service login link issued");
  } catch (err) {
    log.error({ err, audience: service.audience }, `service login failed (${target.kind})`);
    botEventLog.record("error", "feature", "Service login failed", {
      userId: user.id,
      audience: service.audience,
      via: target.kind,
    });
    await renderFailure(target);
  }
}
