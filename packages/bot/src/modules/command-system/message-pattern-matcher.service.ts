/**
 * command-system/message-pattern-matcher.service.ts
 *
 * MessagePatternMatcher：DM messageCreate handler。
 *
 * 對齊 C-runtime §5（DM-only，§5.1 決策）：
 *   1. DM-only gate（channel.type !== ChannelType.DM 直接 return）
 *   2. 查 active session（behavior_sessions PK=userId）── session active 直接走 forwarder
 *   3. 查 applicable behaviors（依 audienceKind 三層 user → group → all）
 *   4. matchTrigger（startswith/endswith/regex）
 *   5. 呼叫 WebhookForwarder.forward
 *   6. session 管理（startSession/endSession，[BEHAVIOR:END] sentinel）
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
import {
  findActiveSession,
  startSession,
  endSession,
  breakSessions,
} from "../behavior/models/behavior-session.model.js";
import { findGroupMembersBulk } from "../behavior/models/behavior-group-member.model.js";
import { matchesTrigger } from "../behavior/behavior-trigger.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import type { MessageMatchOutcome } from "./types.js";
import type { WebhookForwarder } from "./webhook-forwarder.service.js";
import { findBehaviorById } from "../behavior/models/behavior.model.js";
import { issueLoginLinkAndReply } from "../admin/admin-login.service.js";
import { buildManualBehaviorsEmbed } from "./manual-list.js";
import { t } from "../../i18n/index.js";

// DM Message events from Discord don't carry per-user locale, so DM
// replies fall back to the bot's default ("en"). A guild-locale lookup
// isn't possible either — these messages come from a DM channel.
const DM_LOCALE = "en" as const;

// BH-0.3 multi-match：一則訊息可以連發多條 one_time behavior，
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
    sessionStarted: (a.sessionStarted ?? false) || (b.sessionStarted ?? false),
    sessionEnded: (a.sessionEnded ?? false) || (b.sessionEnded ?? false),
    behaviorId: a.behaviorId ?? b.behaviorId,
    error: a.error ?? b.error,
  };
}

// ── MessagePatternMatcher ─────────────────────────────────────────────────────

export class MessagePatternMatcher {
  /**
   * Per-user in-process mutex. Two DM messages from the same user in the
   * same event-loop tick used to both observe findActiveSession()==null,
   * both match the same behavior, and both fire WebhookForwarder.forward
   * before either committed a session. The session upsert then masked the
   * race, but the webhook had already received the same first message
   * twice. Serialize per userId — sequential per user, parallel across
   * users — so the read-check-forward-write sequence becomes atomic from
   * the matcher's POV.
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
   * 注意（C-runtime §5.1）：DM-only gate。guild channel 訊息一律丟棄。
   *
   * system behavior 的 DM 觸發路徑（admin-login / manual / break text trigger）：
   *   若 admin 把 source='system' behavior 的 triggerType 切到 message_pattern，
   *   matcher 會在 matched 後走 handleMatchedSystemBehavior，dispatch 到對應的
   *   system handler（不送 WebhookForwarder — system 沒有 webhookUrl）。
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

    // ─ M-1 修：session 優先路徑下，DM 文字觸發的 `break` system behavior
    // 永遠進不來（會被 session shortcircuit 吃掉並 forward 到 webhook）。
    // 為了讓 admin 設的「!break」之類 DM 觸發確實能逃出 session，先比對
    // enabled 的 source='system' systemKey='break' message_pattern：命中
    // 就 endSession + 回 ack，再 return。沒命中才繼續走 session 路徑。
    const breakEscape = await this.tryBreakEscape(
      djsMessage,
      userId,
      content,
      isDm,
    );
    if (breakEscape) return breakEscape;

    // ─ 查 active session（C-runtime §5.2 session 優先）
    const activeSession = await findActiveSession(userId, channelId);
    if (activeSession) {
      return this.handleWithSession(
        activeSession,
        djsMessage,
        userId,
        channelId,
        content,
      );
    }

    // ─ 查 applicable behaviors（三層：user → group → all）
    const applicableBehaviors = await this.collectApplicableBehaviors(userId);
    if (applicableBehaviors.length === 0) {
      return { handled: false };
    }

    // ─ 匹配 trigger（BH-0.3 multi-match：依 sortOrder 走訪，stopOnMatch
    //   決定 one_time 行為命中後是否擋住後續比對）
    //
    // 停止規則：
    //   system     → 必停（terminal UX，admin-login/manual/break 都是收尾動作）
    //   continuous → 必停（session 接管對話，後續比對沒有意義）
    //   one_time   → stopOnMatch=true 停；false 繼續比對下一條
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

      // ─ 呼叫 WebhookForwarder + session 管理
      const outcome = await this.handleMatchedBehavior(
        behavior,
        djsMessage,
        userId,
        channelId,
        content,
      );
      aggregate = aggregate ? mergeOutcomes(aggregate, outcome) : outcome;

      if (behavior.forwardType === "continuous" || behavior.stopOnMatch) {
        return aggregate;
      }
    }

    return aggregate ?? { handled: false };
  }

  // ── 私有：active session 路徑 ────────────────────────────────────────────

  private async handleWithSession(
    session: {
      behaviorId: number;
      channelId: string;
      userId: string;
      startedAt: string;
    },
    djsMessage: DjsMessage,
    userId: string,
    channelId: string,
    content: string,
  ): Promise<MessageMatchOutcome> {
    const behavior = await findBehaviorById(session.behaviorId);

    // M-11 修：orphan session fatal assertion（C-runtime §3.2 M-11）
    if (!behavior) {
      // session 指向不存在的 behavior（孤兒 session），不靜默丟棄，log error + 清除
      botEventLog.record(
        "error",
        "bot",
        `message-pattern-matcher: orphan session userId=${userId} behaviorId=${session.behaviorId}，behavior 不存在，強制清除 session`,
        { userId, behaviorId: session.behaviorId },
      );
      await endSession(userId, session.channelId);
      return {
        handled: false,
        sessionEnded: true,
        error: "orphan session cleared",
      };
    }

    if (!behavior.enabled) {
      // behavior 被 disable，清除 session
      await endSession(userId, session.channelId);
      return { handled: false, sessionEnded: true };
    }

    // H-3 修：admin 把 forwardType 從 continuous 改成 one_time 後，殘留
    // session 不該繼續吞 DM。先收尾 session 再讓本則訊息以正常 trigger
    // 路徑重跑（next inbound message），這則訊息靜默丟掉，
    // 防止「forward 到舊行為的最後一發」。
    if (behavior.forwardType !== "continuous") {
      botEventLog.record(
        "info",
        "bot",
        `message-pattern-matcher: session behaviorId=${behavior.id} forwardType 已改為 ${behavior.forwardType}，清除 session`,
        { userId, behaviorId: behavior.id },
      );
      await endSession(userId, session.channelId);
      return { handled: false, sessionEnded: true };
    }

    // BH-3：guild 頻道 session 也受 per-channel rate limit
    if (
      djsMessage.guildId &&
      !guildForwardAllowed(session.channelId)
    ) {
      return { handled: false };
    }

    const payload = this.buildPayload(djsMessage, behavior, session);
    const result = await this.forwarder.forward(behavior, payload);

    const dmChannel = djsMessage.channel as DMChannel;

    if (result.ended) {
      await endSession(userId, session.channelId);
      if (result.relayContent) {
        // No allowed_mentions parsing — the response content comes from
        // an external webhook server, which we don't trust to set ping
        // policy. DMs don't honour @everyone but role/user pings can
        // still notify in group-DM contexts, and this also guards
        // against a future relay site that uses a guild channel.
        await dmChannel
          .send({ content: result.relayContent, allowedMentions: { parse: [] } })
          .catch(() => {});
      }
      return { handled: true, sessionEnded: true, behaviorId: behavior.id };
    }

    if (result.ok && result.relayContent) {
      // M-3 修：與 ended 分支一致 strip mentions，relay 內容來自外部 webhook
      // 不可信，避免 user/role ping 經 group-DM 等情境放大。
      await dmChannel
        .send({ content: result.relayContent, allowedMentions: { parse: [] } })
        .catch(() => {});
    }

    if (!result.ok) {
      botEventLog.record(
        "warn",
        "bot",
        `message-pattern-matcher: session forward 失敗 behaviorId=${behavior.id}：${result.error ?? "unknown"}`,
        { userId, behaviorId: behavior.id },
      );
    }

    return { handled: true, behaviorId: behavior.id };
  }

  // ── 私有：matched behavior 首次觸發 ─────────────────────────────────────

  private async handleMatchedBehavior(
    behavior: BehaviorRow,
    djsMessage: DjsMessage,
    userId: string,
    channelId: string,
    content: string,
  ): Promise<MessageMatchOutcome> {
    // BH-3：guild 頻道 forward 受 per-channel rate limit
    if (djsMessage.guildId && !guildForwardAllowed(channelId)) {
      return { handled: false };
    }

    const payload = this.buildPayload(djsMessage, behavior);
    const result = await this.forwarder.forward(behavior, payload);
    const dmChannel = djsMessage.channel as DMChannel;

    let sessionStarted = false;
    let sessionEnded = false;

    if (result.ok) {
      // continuous forward：建立 session
      if (behavior.forwardType === "continuous" && !result.ended) {
        await startSession(userId, behavior.id, channelId);
        sessionStarted = true;
      }

      if (result.ended) {
        sessionEnded = true;
      }

      if (result.relayContent) {
        // No allowed_mentions parsing — the response content comes from
        // an external webhook server, which we don't trust to set ping
        // policy. DMs don't honour @everyone but role/user pings can
        // still notify in group-DM contexts, and this also guards
        // against a future relay site that uses a guild channel.
        await dmChannel
          .send({ content: result.relayContent, allowedMentions: { parse: [] } })
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

    return {
      handled: true,
      sessionStarted,
      sessionEnded,
      behaviorId: behavior.id,
    };
  }

  // ── 私有：break escape（DM + guild，BH-3 擴）────────────────────────────

  /**
   * M-1 修：在 session shortcircuit 之前先檢查使用者是否輸入符合 `break`
   * system behavior 的 message_pattern 觸發。命中即 endSession + 回 ack，
   * 讓文字 break 不被 session 吞掉。
   *
   * 沒命中（最常見路徑：使用者不是想 break，只是正常回覆 session）回 null，
   * 呼叫端繼續走 session shortcircuit / matcher loop。
   *
   * 範圍：只看 enabled + source='system' + systemKey='break' +
   * triggerType='message_pattern'。audienceKind 不過濾（system break 預設
   * audienceKind='all'，且 admin 改不到該欄位）。
   *
   * BH-3：guild 頻道也吃 break escape（逃生門通用性優先於 contexts 過濾），
   * 但 guild 內**沒有 session 可結束時不回覆也不 claim**（避免一般訊息
   * 恰好匹配 break pattern 時對整個頻道刷「No active session」）。
   */
  private async tryBreakEscape(
    djsMessage: DjsMessage,
    userId: string,
    content: string,
    isDm: boolean,
  ): Promise<MessageMatchOutcome | null> {
    const row = await Behavior.findOne({
      where: {
        enabled: true,
        source: "system",
        systemKey: "break",
        triggerType: "message_pattern",
      },
    });
    if (!row) return null;
    const breakRow = rowOfBehavior(row);
    if (!breakRow.messagePatternKind || !breakRow.messagePatternValue) {
      return null;
    }
    if (
      !matchesTrigger(
        breakRow.messagePatternKind,
        breakRow.messagePatternValue,
        content,
      )
    ) {
      return null;
    }
    // guild：先看這個頻道有沒有 session，沒有就完全不出聲、不 claim
    if (!isDm) {
      const active = await findActiveSession(userId, djsMessage.channel.id);
      if (!active) return null;
    }
    const ended = await breakSessions(userId, djsMessage.channel.id);
    const channel = djsMessage.channel as DMChannel;
    if (isDm || ended) {
      await channel
        .send({
          content: t(
            DM_LOCALE,
            ended ? "system.session-ended" : "system.no-session",
          ),
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
    }
    return {
      handled: true,
      sessionEnded: ended,
      behaviorId: breakRow.id,
    };
  }

  // ── 私有：matched system behavior dispatch（admin-login / manual / break）──

  private async handleMatchedSystemBehavior(
    behavior: BehaviorRow,
    djsMessage: DjsMessage,
    userId: string,
  ): Promise<MessageMatchOutcome> {
    const dmChannel = djsMessage.channel as DMChannel;
    const systemKey = behavior.systemKey;

    if (systemKey === "admin-login") {
      await issueLoginLinkAndReply(djsMessage).catch(() => false);
      return { handled: true, behaviorId: behavior.id };
    }

    if (systemKey === "break") {
      const ended = await breakSessions(userId, djsMessage.channel.id);
      await dmChannel
        .send({
          content: t(
            DM_LOCALE,
            ended ? "system.session-ended" : "system.no-session",
          ),
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
      return {
        handled: true,
        sessionEnded: ended,
        behaviorId: behavior.id,
      };
    }

    if (systemKey === "manual") {
      const applicable = await collectApplicableBehaviorsForUser(userId);
      const embed = buildManualBehaviorsEmbed(applicable, DM_LOCALE);
      if (embed) {
        await dmChannel
          .send({ embeds: [embed], allowedMentions: { parse: [] } })
          .catch(() => {});
      } else {
        await dmChannel
          .send({
            content: t(DM_LOCALE, "system.no-manual"),
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
      }
      return { handled: true, behaviorId: behavior.id };
    }

    botEventLog.record(
      "warn",
      "bot",
      `message-pattern-matcher: 未知 systemKey='${systemKey ?? "(null)"}'，handled=true 阻止漏到下一條`,
      { userId, behaviorId: behavior.id, systemKey: systemKey ?? "(null)" },
    );
    return { handled: true, behaviorId: behavior.id };
  }

  // ── 私有：collectApplicableBehaviors（三層 audienceKind 查詢）──────────

  /**
   * 查詢對此 userId 適用的 message_pattern behaviors。
   * 代理 module-level helper，固定只查 message_pattern 觸發。
   * 包含 source='system'（admin-login / manual / break 可被切到 message_pattern）。
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
   * 從 DM message 建構 webhook POST body。
   * 對齊 RESTPostAPIWebhookWithTokenJSONBody 形狀（C-runtime §7.1）。
   */
  /**
   * BH-2.1 — pattern/session payload 與 slash 路徑同樣帶 `_meta`。
   * 頂層 content/username/avatar_url 維持 Discord-webhook 形狀（既有
   * 消費端不受影響）；`_meta.user.id` 讓同一個 webhook 服務多使用者時
   * 能辨識誰在說話（username 可改名、不穩定）。
   */
  private buildPayload(
    djsMessage: DjsMessage,
    behavior: BehaviorRow,
    session?: { startedAt: string } | null,
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
        session: session
          ? { active: true, started_at: session.startedAt }
          : { active: false },
        attachments,
      },
    };
  }

  // ── 私有：Sequelize model → BehaviorRow ──────────────────────────────────

  private rowOfBehavior(model: InstanceType<typeof Behavior>): BehaviorRow {
    return {
      id: model.getDataValue("id") as number,
      title: model.getDataValue("title") as string,
      description: (model.getDataValue("description") as string) ?? "",
      enabled: !!model.getDataValue("enabled"),
      sortOrder: model.getDataValue("sortOrder") as number,
      stopOnMatch: !!model.getDataValue("stopOnMatch"),
    ignoreBots: !!model.getDataValue("ignoreBots"),
      forwardType: model.getDataValue(
        "forwardType",
      ) as BehaviorRow["forwardType"],
      source: model.getDataValue("source") as BehaviorRow["source"],
      triggerType: model.getDataValue(
        "triggerType",
      ) as BehaviorRow["triggerType"],
      messagePatternKind:
        (model.getDataValue(
          "messagePatternKind",
        ) as BehaviorRow["messagePatternKind"]) ?? null,
      messagePatternValue:
        (model.getDataValue("messagePatternValue") as string | null) ?? null,
      slashCommandName:
        (model.getDataValue("slashCommandName") as string | null) ?? null,
      slashCommandDescription:
        (model.getDataValue("slashCommandDescription") as string | null) ??
        null,
      scope: model.getDataValue("scope") as BehaviorRow["scope"],
      integrationTypes: model.getDataValue("integrationTypes") as string,
      contexts: model.getDataValue("contexts") as string,
      placementGuildId:
        (model.getDataValue("placementGuildId") as string | null) ?? null,
      placementChannelId:
        (model.getDataValue("placementChannelId") as string | null) ?? null,
      audienceKind: model.getDataValue(
        "audienceKind",
      ) as BehaviorRow["audienceKind"],
      audienceUserId:
        (model.getDataValue("audienceUserId") as string | null) ?? null,
      audienceGroupName:
        (model.getDataValue("audienceGroupName") as string | null) ?? null,
      webhookUrl: (model.getDataValue("webhookUrl") as string | null) ?? null,
      webhookSecret:
        (model.getDataValue("webhookSecret") as string | null) ?? null,
      webhookAuthMode:
        (model.getDataValue(
          "webhookAuthMode",
        ) as BehaviorRow["webhookAuthMode"]) ?? null,
      systemKey:
        (model.getDataValue("systemKey") as BehaviorRow["systemKey"]) ?? null,
      scopeTabId: (model.getDataValue("scopeTabId") as number) ?? 1,
    };
  }
}

// ── module-level helper（共用）────────────────────────────────────────────────

/**
 * 查詢對此 userId 在 DM 觸發時適用的 behaviors。
 *
 * 篩選條件：
 *   - enabled=true
 *   - source：預設排除 'system'（/manual 列表給使用者看的「自訂」行為）；
 *     MessagePatternMatcher 需要把 system 也算進去（admin-login / manual / break
 *     可被 admin 切到 message_pattern），透過 includeSystem=true 開啟。
 *   - triggerType：若指定，只回該 triggerType；不指定則返回全部
 *   - audienceKind 符合（user / group / all 三層）
 *
 * 結果依 sortOrder 排序。
 * 可被 MessagePatternMatcher 與 InteractionDispatcher(/manual) 共用。
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
