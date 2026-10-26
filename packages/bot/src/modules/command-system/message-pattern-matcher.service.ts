/**
 * command-system/message-pattern-matcher.service.ts
 *
 * MessagePatternMatcher：messageCreate handler for `message_pattern`
 * behaviors, in bot DMs and guild text channels (BH-3).
 *
 *   1. 查 applicable behaviors（依 audienceKind 三層 user → group → all）
 *   2. reach 過濾（contexts / placement / ignoreBots）
 *   3. matchTrigger（startswith/endswith/regex）
 *   4. system behavior → 內建 handler；其餘呼叫 WebhookForwarder.forward
 *
 * Continuous sessions, `break` and `manual` were removed by ADR 0003.
 *
 * onMessage(djsMessage) 暴露給 testing。
 */

import {
  type Client,
  type Message as DjsMessage,
  type DMChannel,
  ChannelType,
} from "discord.js";
import { Op } from "sequelize";
import {
  Behavior,
  rowOfBehavior,
  type BehaviorRow,
} from "../behavior/models/behavior.model.js";
import { findGroupMembersBulk } from "../behavior/models/behavior-group-member.model.js";
import { recordForwardOutcome } from "../behavior/models/behavior-stats.model.js";
import { matchesTrigger } from "../behavior/behavior-trigger.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import type { MessageMatchOutcome } from "./types.js";
import type { WebhookForwarder } from "./webhook-forwarder.service.js";
import { issueLoginLinkAndReply } from "../admin/admin-login.service.js";

// BH-0.3 multi-match：一則訊息可以連發多條 behavior，
// outcome 取聯集；behaviorId 報第一條命中的（log 用途）。
// BH-3：guild 頻道 forward 的 per-channel rate limit（防高頻頻道把 webhook
// 刷爆 / webhook 回貼造成的迴圈放大）。sliding window，超量靜默丟棄並記
// botEventLog（每 channel 每 window 至多記一次）。DM 不限流。
const GUILD_FORWARD_LIMIT = 5;
const GUILD_FORWARD_WINDOW_MS = 10_000;
const guildForwardWindows = new Map<string, number[]>();
const guildForwardWarned = new Map<string, number>();

function guildForwardAllowed(channelId: string): boolean {
  const now = Date.now();
  const stamps = (guildForwardWindows.get(channelId) ?? []).filter(
    (ts) => now - ts < GUILD_FORWARD_WINDOW_MS,
  );
  if (stamps.length >= GUILD_FORWARD_LIMIT) {
    guildForwardWindows.set(channelId, stamps);
    const lastWarn = guildForwardWarned.get(channelId) ?? 0;
    if (now - lastWarn >= GUILD_FORWARD_WINDOW_MS) {
      guildForwardWarned.set(channelId, now);
      botEventLog.record(
        "warn",
        "bot",
        `message-pattern-matcher: guild channel ${channelId} 觸發超過 ${GUILD_FORWARD_LIMIT}/${GUILD_FORWARD_WINDOW_MS / 1000}s，rate limit 丟棄`,
        { channelId },
      );
    }
    return false;
  }
  stamps.push(now);
  guildForwardWindows.set(channelId, stamps);
  if (stamps.length === 1) guildForwardWarned.delete(channelId);
  return true;
}

/** 測試用：清空 rate limit 視窗。 */
export function __resetGuildForwardWindowsForTests(): void {
  guildForwardWindows.clear();
  guildForwardWarned.clear();
}

function mergeOutcomes(
  a: MessageMatchOutcome,
  b: MessageMatchOutcome,
): MessageMatchOutcome {
  return {
    handled: a.handled || b.handled,
    behaviorId: a.behaviorId ?? b.behaviorId,
    error: a.error ?? b.error,
  };
}

// ── MessagePatternMatcher ─────────────────────────────────────────────────────

export class MessagePatternMatcher {
  /**
   * Per-user in-process mutex: a user's messages are matched and
   * forwarded in the order they arrived, sequential per user and
   * parallel across users.
   */
  private readonly userLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly forwarder: WebhookForwarder) {}

  private async withUserLock<T>(
    userId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.userLocks.get(userId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Store as `unknown` so generic T doesn't widen the map's value type.
    this.userLocks.set(userId, next);
    try {
      return await next;
    } finally {
      // Only clear when we're still the tail — concurrent callers chain on
      // top of `next` and will install their own promise.
      if (this.userLocks.get(userId) === next) {
        this.userLocks.delete(userId);
      }
    }
  }

  /**
   * 掛載到 bot client：真實掛載 messageCreate listener。
   *
   * system behavior 的訊息觸發路徑：admin 把登入的 system behavior 切到
   * message_pattern 時，matcher 命中後走 handleMatchedSystemBehavior，
   * dispatch 到內建 handler（不送 WebhookForwarder — system 沒有 webhookUrl）。
   */
  register(client: Client): void {
    client.on("messageCreate", (msg) => {
      void this.onMessage(msg).catch((err: unknown) => {
        botEventLog.record(
          "error",
          "bot",
          `message-pattern-matcher: messageCreate handler 拋出例外：${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    botEventLog.record(
      "info",
      "bot",
      "message-pattern-matcher: messageCreate listener 已掛載",
    );
  }

  /**
   * 處理一條 DjsMessage（供 testing 直接呼叫；production 由 register 的 listener 呼叫）。
   */
  async onMessage(djsMessage: DjsMessage): Promise<MessageMatchOutcome> {
    const isDm = djsMessage.channel.type === ChannelType.DM;

    if (isDm) {
      // DM：bot 訊息無條件丟棄（bot 之間不會 DM；防 echo）
      if (djsMessage.author.bot) {
        return { handled: false };
      }
    } else {
      // BH-3：guild 文字頻道。其他型別（group DM 等）不處理。
      if (!djsMessage.guildId) {
        return { handled: false };
      }
      // 本 bot 自身訊息無條件丟棄（防自我迴圈）——即使 behavior 取消勾選
      // ignoreBots 也擋。其他 bot/webhook 作者由 per-behavior ignoreBots
      // 在比對階段決定。
      if (
        djsMessage.author.id !== undefined &&
        djsMessage.author.id === djsMessage.client?.user?.id
      ) {
        return { handled: false };
      }
    }

    const userId = djsMessage.author.id;
    return this.withUserLock(userId, () =>
      this.onMessageLocked(djsMessage, userId, isDm),
    );
  }

  private async onMessageLocked(
    djsMessage: DjsMessage,
    userId: string,
    isDm: boolean,
  ): Promise<MessageMatchOutcome> {
    const channelId = djsMessage.channel.id;
    const content = djsMessage.content ?? "";

    // ─ 查 applicable behaviors（三層：user → group → all）
    const applicableBehaviors = await this.collectApplicableBehaviors(userId);
    if (applicableBehaviors.length === 0) {
      return { handled: false };
    }

    // ─ 匹配 trigger（BH-0.3 multi-match：依 sortOrder 走訪，stopOnMatch
    //   決定命中後是否擋住後續比對）
    //
    // 停止規則：
    //   system → 必停（terminal UX：登入連結是收尾動作）
    //   custom → stopOnMatch=true 停；false 繼續比對下一條
    let aggregate: MessageMatchOutcome | null = null;
    for (const behavior of applicableBehaviors) {
      if (behavior.triggerType !== "message_pattern") continue;
      if (!behavior.messagePatternKind || !behavior.messagePatternValue)
        continue;

      // ─ BH-3 reach 過濾：contexts 決定 DM / guild 哪邊生效；guild 再按
      //   placement（specific_guild/channel tab 的承諾）與 ignoreBots 過濾。
      const contexts = behavior.contexts ?? "";
      if (isDm) {
        if (!contexts.includes("BotDM")) continue;
      } else {
        if (!contexts.includes("Guild")) continue;
        if (
          behavior.placementGuildId !== null &&
          behavior.placementGuildId !== djsMessage.guildId
        )
          continue;
        if (
          behavior.placementChannelId !== null &&
          behavior.placementChannelId !== channelId
        )
          continue;
        if (djsMessage.author.bot && behavior.ignoreBots) continue;
      }

      const matched = matchesTrigger(
        behavior.messagePatternKind,
        behavior.messagePatternValue,
        content,
      );
      if (!matched) continue;

      // ─ system source 不走 webhook，直接 dispatch 到對應 system handler
      if (behavior.source === "system") {
        const outcome = await this.handleMatchedSystemBehavior(
          behavior,
          djsMessage,
          userId,
        );
        return aggregate ? mergeOutcomes(aggregate, outcome) : outcome;
      }

      const outcome = await this.handleMatchedBehavior(
        behavior,
        djsMessage,
        userId,
        channelId,
      );
      aggregate = aggregate ? mergeOutcomes(aggregate, outcome) : outcome;

      if (behavior.stopOnMatch) {
        return aggregate;
      }
    }

    return aggregate ?? { handled: false };
  }

  // ── 私有：matched behavior 觸發 ─────────────────────────────────────────

  private async handleMatchedBehavior(
    behavior: BehaviorRow,
    djsMessage: DjsMessage,
    userId: string,
    channelId: string,
  ): Promise<MessageMatchOutcome> {
    // BH-3：guild 頻道 forward 受 per-channel rate limit
    if (djsMessage.guildId && !guildForwardAllowed(channelId)) {
      return { handled: false };
    }

    const payload = this.buildPayload(djsMessage, behavior);
    const result = await this.forwarder.forward(behavior, payload);
    await recordForwardOutcome(behavior.id, result.ok, result.error);
    const dmChannel = djsMessage.channel as DMChannel;

    if (result.ok) {
      if (result.relayContent || result.relayEmbeds) {
        // No allowed_mentions parsing — the response content comes from
        // an external webhook server, which we don't trust to set ping
        // policy. DMs don't honour @everyone but role/user pings can
        // still notify in group-DM contexts, and this also guards
        // against a future relay site that uses a guild channel.
        await dmChannel
          .send({
            content: result.relayContent,
            embeds: result.relayEmbeds ?? [],
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
      }
    } else {
      botEventLog.record(
        "warn",
        "bot",
        `message-pattern-matcher: forward 失敗 behaviorId=${behavior.id}：${result.error ?? "unknown"}`,
        { userId, behaviorId: behavior.id },
      );
    }

    return { handled: true, behaviorId: behavior.id };
  }

  // ── 私有：matched system behavior dispatch（admin-login）────────────────

  private async handleMatchedSystemBehavior(
    behavior: BehaviorRow,
    djsMessage: DjsMessage,
    userId: string,
  ): Promise<MessageMatchOutcome> {
    if (behavior.systemKey === "admin-login") {
      await issueLoginLinkAndReply(djsMessage).catch(() => false);
      return { handled: true, behaviorId: behavior.id };
    }

    botEventLog.record(
      "warn",
      "bot",
      `message-pattern-matcher: 未知 systemKey='${behavior.systemKey ?? "(null)"}'，handled=true 阻止漏到下一條`,
      {
        userId,
        behaviorId: behavior.id,
        systemKey: behavior.systemKey ?? "(null)",
      },
    );
    return { handled: true, behaviorId: behavior.id };
  }

  // ── 私有：collectApplicableBehaviors（三層 audienceKind 查詢）──────────

  /**
   * 查詢對此 userId 適用的 message_pattern behaviors（含 system source：
   * 登入可被 admin 切到 message_pattern）。
   */
  private async collectApplicableBehaviors(
    userId: string,
  ): Promise<BehaviorRow[]> {
    return collectApplicableBehaviorsForUser(userId, {
      triggerType: "message_pattern",
      includeSystem: true,
    });
  }

  // ── 私有：buildPayload ───────────────────────────────────────────────────

  /**
   * 從觸發的 message 建構 webhook POST body。
   *
   * BH-2.1 — pattern payload 與 slash 路徑同樣帶 `_meta`。頂層
   * content/username/avatar_url 維持 Discord-webhook 形狀（既有消費端不受
   * 影響）；`_meta.user.id` 讓同一個 webhook 服務多使用者時能辨識誰在說話
   * （username 可改名、不穩定）。
   */
  private buildPayload(
    djsMessage: DjsMessage,
    behavior: BehaviorRow,
  ): Record<string, unknown> {
    const attachments = djsMessage.attachments
      ? [...djsMessage.attachments.values()].map((a) => ({
          url: a.url,
          filename: a.name ?? null,
          content_type: a.contentType ?? null,
          size: a.size ?? null,
        }))
      : [];
    return {
      content: djsMessage.content ?? "",
      username: djsMessage.author.username,
      avatar_url: djsMessage.author.displayAvatarURL(),
      _meta: {
        user: {
          id: djsMessage.author.id,
          username: djsMessage.author.username,
          global_name: djsMessage.author.globalName ?? null,
          discriminator: djsMessage.author.discriminator,
          avatar: djsMessage.author.avatar ?? null,
        },
        message_id: djsMessage.id,
        channel_id: djsMessage.channel.id,
        guild_id: djsMessage.guildId ?? null,
        behavior_id: behavior.id,
        attachments,
      },
    };
  }
}

// ── module-level helper ──────────────────────────────────────────────────────

/**
 * 查詢對此 userId 適用的 behaviors。
 *
 * 篩選條件：
 *   - enabled=true
 *   - source：預設排除 'system'；MessagePatternMatcher 透過 includeSystem=true
 *     把可被切到 message_pattern 的登入 system behavior 也算進去。
 *   - triggerType：若指定，只回該 triggerType；不指定則返回全部
 *   - audienceKind 符合（user / group / all 三層）
 *
 * 結果依 sortOrder 排序。
 *
 * @param userId  Discord user id
 * @param options.triggerType  若指定則只查該 triggerType；未指定則查全部
 * @param options.includeSystem  預設 false（不含 system source）
 */
export async function collectApplicableBehaviorsForUser(
  userId: string,
  options?: {
    triggerType?: "message_pattern" | "slash_command";
    includeSystem?: boolean;
  },
): Promise<BehaviorRow[]> {
  const where: Record<string, unknown> = {
    enabled: true,
  };
  if (options?.includeSystem !== true) {
    where["source"] = { [Op.ne]: "system" };
  }
  if (options?.triggerType !== undefined) {
    where["triggerType"] = options.triggerType;
  }
  const allRows = await Behavior.findAll({
    where,
    order: [["sortOrder", "ASC"]],
  });

  const behaviors = allRows.map(rowOfBehavior);
  // group 成員以 groupName 為鍵（BH-1）— 同名 group 的 behaviors 共享名單
  const groupNames = behaviors
    .filter((b) => b.audienceKind === "group" && b.audienceGroupName !== null)
    .map((b) => b.audienceGroupName as string);
  const memberMap = await findGroupMembersBulk(groupNames);

  const result: BehaviorRow[] = [];
  for (const behavior of behaviors) {
    if (behavior.audienceKind === "user") {
      if (behavior.audienceUserId === userId) result.push(behavior);
    } else if (behavior.audienceKind === "group") {
      if (
        behavior.audienceGroupName !== null &&
        memberMap.get(behavior.audienceGroupName)?.includes(userId)
      ) {
        result.push(behavior);
      }
    } else if (behavior.audienceKind === "all") {
      result.push(behavior);
    }
  }
  return result;
}
