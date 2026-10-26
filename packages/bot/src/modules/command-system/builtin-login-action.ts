/**
 * command-system/builtin-login-action.ts
 *
 * The System Behavior's built-in action (login) answers with the same
 * BehaviorReply a webhook does (#140), so the ReplyRenderer delivers it:
 * an embed (role + how long the link lives) and a link button. The URL is
 * only the button's target — never in the text, so a link preview or a
 * log line can't pick up the one-time token.
 *
 * Always `ephemeral: true`: a command shows it to the invoker only, a bot
 * DM ignores the flag, and were the login ever answered in a guild channel
 * the renderer would DM the author rather than post it.
 */

import { mintLoginLink, type LoginContextRefs } from "../admin/admin-login.service.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { moduleLogger } from "../../logger.js";
import type { BehaviorReply } from "./behavior-reply.js";
import { renderFailure, renderReply, type ReplyTarget } from "./reply-renderer.js";

const log = moduleLogger("admin-login");

const NOT_AUTHORIZED = "你目前不在授權清單,請聯絡管理員。";

/**
 * The login reply for `userId`, or null when nothing should be said: a
 * message trigger stays silent for someone who isn't authorised (no hint
 * that the bot knows the user), a command tells them.
 */
export async function loginActionReply(
  userId: string,
  ctx: LoginContextRefs,
  surface: "command" | "message",
): Promise<BehaviorReply | null> {
  const result = await mintLoginLink(userId, ctx);
  if (!result.ok) {
    return surface === "command" ? { content: NOT_AUTHORIZED, ephemeral: true } : null;
  }
  return {
    embeds: [
      {
        color: 0x5865f2,
        title: "後台登入連結",
        description: "點下方按鈕在瀏覽器開啟後台。連結為一次性，請勿轉發。",
        fields: [
          { name: "角色", value: result.role, inline: true },
          { name: "有效時間", value: `約 ${result.minutesUntilExpiry} 分鐘`, inline: true },
        ],
      },
    ],
    components: [
      { type: 1, components: [{ type: 2, style: 5, label: "前往登入", url: result.url }] },
    ],
    ephemeral: true,
  };
}

/**
 * Run the login for whoever triggered it — a command or a message — and
 * deliver the reply through the ReplyRenderer. Never throws: a failure is
 * logged (with its stack), recorded in the bot event log, and the user
 * gets the generic failure line (#114).
 */
export async function runLoginAction(target: ReplyTarget): Promise<void> {
  const userId =
    target.kind === "interaction" ? target.interaction.user.id : target.message.author.id;
  try {
    const reply =
      target.kind === "interaction"
        ? await loginActionReply(
            userId,
            {
              guildId: target.interaction.guildId,
              channelId: target.interaction.channelId,
              messageId: null,
            },
            "command",
          )
        : await loginActionReply(
            userId,
            {
              guildId: target.message.guildId ?? null,
              channelId: target.message.channel.id,
              messageId: target.message.id,
            },
            "message",
          );
    if (!reply) return;
    const rendered = await renderReply(reply, target);
    if (!rendered.ok) {
      log.warn({ error: rendered.error }, `admin-login reply refused (${target.kind})`);
      botEventLog.record("error", "feature", "Admin login reply failed", {
        userId,
        via: target.kind,
        error: rendered.error,
      });
      // a login that couldn't be DMed stays silent; otherwise the generic
      // line, which in a guild goes to the author's DMs — never the channel
      if (!rendered.dmFailed) await renderFailure(target);
    }
  } catch (err) {
    log.error({ err }, `admin-login issue failed (${target.kind})`);
    botEventLog.record("error", "feature", "Admin login failed", { userId, via: target.kind });
    await renderFailure(target);
  }
}
