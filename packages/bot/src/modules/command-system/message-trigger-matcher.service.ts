/**
 * command-system/message-trigger-matcher.service.ts
 *
 * MessageTriggerMatcher：Message Trigger 的 messageCreate handler（ADR 0003）。
 *
 *   1. 觸發來自 BehaviorCatalog 的記憶體快照（寫入即失效）
 *   2. 在哪：與 bot 的私訊 → surface='bot_dm'；伺服器頻道 → surface='guild'
 *      （全部 / 指定伺服器 / 指定頻道），再依 ignoreBots 過濾 bot 作者
 *   3. 對誰：audience（所有人 / 使用者 / 群組）只在與 bot 的私訊
 *   4. matchTrigger（startswith/endswith/regex），依 sortOrder 走訪
 *   5. 內建動作（系統登入）→ 內建 handler；webhook → WebhookForwarder
 *
 * onMessage(djsMessage) 暴露給 testing。
 */

import {
  type Client,
  type Message as DjsMessage,
  ChannelType,
} from "discord.js";
import {
  getBehaviorCatalog,
  type CatalogBehavior,
} from "../behavior/behavior-catalog.js";
import { matchesTrigger, triggerCaptures } from "../behavior/behavior-trigger.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import type { MessageMatchOutcome } from "./types.js";
import type { WebhookForwarder } from "./webhook-forwarder.service.js";
import { runLoginAction } from "./builtin-login-action.js";
import { runWebhookAction } from "./webhook-action.js";

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
        `message-trigger-matcher: guild channel ${channelId} 觸發超過 ${GUILD_FORWARD_LIMIT}/${GUILD_FORWARD_WINDOW_MS / 1000}s，rate limit 丟棄`,
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

// ── MessageTriggerMatcher ─────────────────────────────────────────────────────

export class MessageTriggerMatcher {
  /**
   * Per-conversation in-process mutex, keyed by (user, channel): one user's
   * messages in one channel (or in their DM with the bot, which is its own
   * channel) have their webhook triggers run in the order they arrived.
   * Other channels and other users never wait for it, and neither does a
   * message that fires no webhook trigger (#118).
   */
  private readonly conversationLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly forwarder: WebhookForwarder) {}

  private async withConversationLock<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.conversationLocks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Store as `unknown` so generic T doesn't widen the map's value type.
    this.conversationLocks.set(key, next);
    try {
      return await next;
    } finally {
      // Only clear when we're still the tail — concurrent callers chain on
      // top of `next` and will install their own promise.
      if (this.conversationLocks.get(key) === next) {
        this.conversationLocks.delete(key);
      }
    }
  }

  /**
   * 掛載到 bot client：真實掛載 messageCreate listener。
   *
   * 系統登入在訊息觸發上時，命中後走 handleMatchedSystemBehavior 的內建
   * 動作（不送 WebhookForwarder）。
   */
  register(client: Client): void {
    client.on("messageCreate", (msg) => {
      void this.onMessage(msg).catch((err: unknown) => {
        botEventLog.record(
          "error",
          "bot",
          `message-trigger-matcher: messageCreate handler 拋出例外：${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    botEventLog.record(
      "info",
      "bot",
      "message-trigger-matcher: messageCreate listener 已掛載",
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
    // 比對在鎖外：沒命中的訊息不排隊，系統登入也不等 webhook（#118）。
    // 拿到快照之後到排進佇列之間不能有 await：等同一份快照的訊息依到達
    // 順序恢復執行，也就依到達順序入列。例外只有快照重載途中剛好被寫入
    // 弄失效——後到的訊息自己重載，先載完的話會排到前面。
    const { messageTriggers, groupMembers } = await getBehaviorCatalog();
    const { webhooks, builtin } = triggersToRun(
      messageTriggers,
      djsMessage,
      userId,
      isDm,
      groupMembers,
    );

    const key = `${userId}:${djsMessage.channel.id}`;
    const [forwarded, login] = await Promise.all([
      webhooks.length > 0
        ? this.withConversationLock(key, () =>
            this.runWebhookTriggers(webhooks, djsMessage, userId),
          )
        : null,
      builtin
        ? this.handleMatchedSystemBehavior(builtin, djsMessage, userId)
        : null,
    ]);
    // 依走訪順序合併：webhook 觸發都排在收尾的系統登入之前
    if (forwarded && login) return mergeOutcomes(forwarded, login);
    return forwarded ?? login ?? { handled: false };
  }

  /** 依序執行一則訊息命中的 webhook 觸發（在對話鎖內）。 */
  private async runWebhookTriggers(
    triggers: readonly CatalogBehavior[],
    djsMessage: DjsMessage,
    userId: string,
  ): Promise<MessageMatchOutcome> {
    let aggregate: MessageMatchOutcome | null = null;
    for (const trigger of triggers) {
      const outcome = await this.handleMatchedBehavior(
        trigger,
        djsMessage,
        userId,
      );
      aggregate = aggregate ? mergeOutcomes(aggregate, outcome) : outcome;
    }
    return aggregate ?? { handled: false };
  }

  // ── 私有：matched behavior 觸發 ─────────────────────────────────────────

  private async handleMatchedBehavior(
    behavior: CatalogBehavior,
    djsMessage: DjsMessage,
    userId: string,
  ): Promise<MessageMatchOutcome> {
    const channelId = djsMessage.channel.id;
    // BH-3：guild 頻道 forward 受 per-channel rate limit
    if (djsMessage.guildId && !guildForwardAllowed(channelId)) {
      return { handled: false };
    }
    if (!behavior.webhook) {
      botEventLog.record(
        "warn",
        "bot",
        `message-trigger-matcher: behavior ${behavior.id} 沒有 webhook 動作，略過`,
        { behaviorId: behavior.id },
      );
      return { handled: false };
    }

    // 回覆模型（#140）與失敗處理（#114）：webhook-action.ts。私訊照常回；
    // 伺服器預設貼頻道，ephemeral=true 改私訊作者；失敗從不貼頻道。
    await runWebhookAction({
      forwarder: this.forwarder,
      behaviorId: behavior.id,
      webhook: behavior.webhook,
      payload: this.buildPayload(djsMessage, behavior),
      target: { kind: "message", message: djsMessage },
      visibility: behavior.replyVisibility,
    });

    return { handled: true, behaviorId: behavior.id };
  }

  // ── 私有：matched system behavior dispatch（admin-login）────────────────

  private async handleMatchedSystemBehavior(
    behavior: CatalogBehavior,
    djsMessage: DjsMessage,
    userId: string,
  ): Promise<MessageMatchOutcome> {
    if (behavior.systemKey === "admin-login") {
      await runLoginAction({ kind: "message", message: djsMessage });
      return { handled: true, behaviorId: behavior.id };
    }

    botEventLog.record(
      "warn",
      "bot",
      `message-trigger-matcher: 未知 systemKey='${behavior.systemKey ?? "(null)"}'，handled=true 阻止漏到下一條`,
      {
        userId,
        behaviorId: behavior.id,
        systemKey: behavior.systemKey ?? "(null)",
      },
    );
    return { handled: true, behaviorId: behavior.id };
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
    behavior: CatalogBehavior,
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
        // regex 觸發的擷取群組（第 1 組起；沒參與的選用群組為 null），
        // 其他比對方式為 []（#140）
        captures:
          behavior.patternKind && behavior.patternValue !== null
            ? triggerCaptures(behavior.patternKind, behavior.patternValue, djsMessage.content ?? "")
            : [],
      },
    };
  }
}

// ── 這則訊息要執行哪些觸發 ──────────────────────────────────────────────

interface TriggersToRun {
  /** 依 sortOrder 命中的 webhook 觸發 */
  webhooks: CatalogBehavior[];
  /** 命中的內建動作（系統登入）；它一定收尾 */
  builtin: CatalogBehavior | null;
}

/**
 * 依 sortOrder 走訪（BH-0.3 multi-match），以訊息到達時的快照為準。停止規則：
 *   系統登入 → 必停（登入連結是收尾動作）
 *   其他     → stopOnMatch=true 停；false 繼續比對下一條
 */
function triggersToRun(
  triggers: readonly CatalogBehavior[],
  djsMessage: DjsMessage,
  userId: string,
  isDm: boolean,
  groupMembers: ReadonlyMap<string, ReadonlySet<string>>,
): TriggersToRun {
  const content = djsMessage.content ?? "";
  const webhooks: CatalogBehavior[] = [];
  for (const trigger of triggers) {
    if (!trigger.enabled) continue;
    if (!trigger.patternKind || trigger.patternValue === null) continue;
    if (!appliesTo(trigger, djsMessage, userId, isDm, groupMembers)) continue;
    if (!matchesTrigger(trigger.patternKind, trigger.patternValue, content)) {
      continue;
    }
    if (trigger.actionSource === "builtin") return { webhooks, builtin: trigger };
    webhooks.push(trigger);
    if (trigger.stopOnMatch) break;
  }
  return { webhooks, builtin: null };
}

// ── 觸發是否適用於這則訊息（在哪 + 對誰）────────────────────────────────

function appliesTo(
  trigger: CatalogBehavior,
  djsMessage: DjsMessage,
  userId: string,
  isDm: boolean,
  groupMembers: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (isDm) {
    if (trigger.surface !== "bot_dm") return false;
    switch (trigger.audienceKind) {
      case "all":
        return true;
      case "user":
        return trigger.audienceUserId === userId;
      case "group":
        return (
          trigger.audienceGroupName !== null &&
          (groupMembers.get(trigger.audienceGroupName)?.has(userId) ?? false)
        );
    }
  }
  if (trigger.surface !== "guild") return false;
  if (trigger.guildId !== null && trigger.guildId !== djsMessage.guildId) {
    return false;
  }
  if (
    trigger.channelId !== null &&
    trigger.channelId !== djsMessage.channel.id
  ) {
    return false;
  }
  return !(djsMessage.author.bot && trigger.ignoreBots);
}
