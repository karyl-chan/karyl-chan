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
 *   5. 內建動作（系統登入）→ 內建 handler；服務（Service Behavior，#126）→
 *      service-login-action；webhook → WebhookForwarder
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
import { matchTrigger, type TriggerMatch } from "../behavior/behavior-trigger.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";
import type { MessageMatchOutcome } from "./types.js";
import type { WebhookForwarder } from "./webhook-forwarder.service.js";
import { runLoginAction } from "./builtin-login-action.js";
import { runServiceLoginAction } from "./service-login-action.js";
import { runWebhookAction } from "./webhook-action.js";
import { takeBehaviorRun } from "./behavior-rate-limits.js";
import { toWebhookAttachment } from "./webhook-attachment.js";

// BH-0.3 multi-match：一則訊息可以連發多條 behavior，
// outcome 取聯集；behaviorId 報第一條命中的（log 用途）。
// 速率限制（#119）：behavior-rate-limits.ts。伺服器頻道每頻道、私訊每使用者
// 5 次 / 10 秒；超量靜默丟棄、記一次、不計統計。系統登入不受限。

// #118：每個對話（使用者 × 頻道）最多一則執行中加這麼多則等待；再來的
// 訊息靜默丟棄，並記一筆 botEventLog（去重）。最壞等待約
// (1 + MAX_QUEUED_PER_KEY) × webhook 逾時 × 每則命中的觸發數。
const MAX_QUEUED_PER_KEY = 3;

interface ConversationQueue {
  /** settles when the conversation's last accepted message is done; never rejects */
  tail: Promise<void>;
  /** running + waiting messages */
  size: number;
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
   * Per-conversation in-process queue, keyed by (user, channel): one user's
   * messages in one channel (or in their DM with the bot, which is its own
   * channel) have their webhook triggers run in the order they arrived.
   * Other channels and other users never wait for it, and neither does a
   * message that fires no webhook trigger (#118). An entry lives only
   * while the conversation has a message running.
   */
  private readonly conversations = new Map<string, ConversationQueue>();

  constructor(private readonly forwarder: WebhookForwarder) {}

  /** 測試用：目前有訊息在跑的對話數。 */
  __conversationCountForTests(): number {
    return this.conversations.size;
  }

  /**
   * Runs fn after the conversation's earlier messages. Null when the
   * conversation already holds 1 + MAX_QUEUED_PER_KEY messages: fn is
   * dropped and never runs. Takes the slot synchronously, so callers
   * queue in call order.
   */
  private inConversation<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> | null {
    const queue = this.conversations.get(key) ?? {
      tail: Promise.resolve(),
      size: 0,
    };
    if (queue.size >= 1 + MAX_QUEUED_PER_KEY) return null;
    queue.size++;
    this.conversations.set(key, queue);
    const run = queue.tail.then(fn).finally(() => {
      if (--queue.size === 0) this.conversations.delete(key);
    });
    queue.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
    const { webhooks, closing } = triggersToRun(
      messageTriggers,
      djsMessage,
      userId,
      isDm,
      groupMembers,
    );

    const channelId = djsMessage.channel.id;
    let queued: Promise<MessageMatchOutcome> | null = null;
    if (webhooks.length > 0) {
      queued = this.inConversation(`${userId}:${channelId}`, () =>
        this.runWebhookTriggers(webhooks, djsMessage, userId),
      );
      // 排隊已滿：不回覆使用者、不計統計，只記一次（#118）
      if (!queued && shouldRecord(`behavior-queue-full:${userId}:${channelId}`)) {
        botEventLog.record(
          "warn",
          "bot",
          `message-trigger-matcher: user ${userId} 在 channel ${channelId} 已有 ${1 + MAX_QUEUED_PER_KEY} 則訊息排隊，丟棄新訊息`,
          { userId, channelId },
        );
      }
    }
    const [forwarded, closed] = await Promise.all([
      queued,
      closing ? this.handleClosingAction(closing, djsMessage, userId) : null,
    ]);
    // 依走訪順序合併：webhook 觸發都排在收尾的動作（系統登入、服務登入）之前
    if (forwarded && closed) return mergeOutcomes(forwarded, closed);
    return forwarded ?? closed ?? { handled: false };
  }

  /** 依序執行一則訊息命中的 webhook 觸發（在對話鎖內）。 */
  private async runWebhookTriggers(
    triggers: readonly MatchedTrigger[],
    djsMessage: DjsMessage,
    userId: string,
  ): Promise<MessageMatchOutcome> {
    let aggregate: MessageMatchOutcome | null = null;
    for (const { trigger, match } of triggers) {
      const outcome = await this.handleMatchedBehavior(
        trigger,
        match,
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
    match: TriggerMatch,
    djsMessage: DjsMessage,
    userId: string,
  ): Promise<MessageMatchOutcome> {
    const allowed = takeBehaviorRun(
      djsMessage.guildId
        ? { kind: "guild_channel", channelId: djsMessage.channel.id }
        : { kind: "dm_user", userId },
    );
    if (!allowed) return { handled: false };
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
      payload: this.buildPayload(djsMessage, behavior, match),
      target: { kind: "message", message: djsMessage },
      visibility: behavior.replyVisibility,
    });

    return { handled: true, behaviorId: behavior.id };
  }

  // ── 私有：收尾的動作（admin-login、Service Behavior）──────────────────

  private async handleClosingAction(
    behavior: CatalogBehavior,
    djsMessage: DjsMessage,
    userId: string,
  ): Promise<MessageMatchOutcome> {
    if (behavior.actionSource === "service") {
      // 服務登入照一般觸發限速（系統登入不受限）：每則都簽一張 token
      if (!takeBehaviorRun({ kind: "dm_user", userId })) return { handled: false };
      if (!behavior.service) {
        botEventLog.record(
          "warn",
          "bot",
          `message-trigger-matcher: service behavior ${behavior.id} 找不到它的服務，略過`,
          { behaviorId: behavior.id },
        );
        return { handled: true, behaviorId: behavior.id };
      }
      await runServiceLoginAction({ kind: "message", message: djsMessage }, behavior.service);
      return { handled: true, behaviorId: behavior.id };
    }
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
    match: TriggerMatch,
  ): Record<string, unknown> {
    const attachments = djsMessage.attachments
      ? [...djsMessage.attachments.values()].map(toWebhookAttachment)
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
        // 其他比對方式為 []（#140）；取自比對時的那一次 exec（#119）
        captures: match.captures,
      },
    };
  }
}

// ── 這則訊息要執行哪些觸發 ──────────────────────────────────────────────

/** 命中的觸發與它的比對結果（擷取群組）。 */
interface MatchedTrigger {
  trigger: CatalogBehavior;
  match: TriggerMatch;
}

interface TriggersToRun {
  /** 依 sortOrder 命中的 webhook 觸發 */
  webhooks: MatchedTrigger[];
  /** 命中的收尾動作（系統登入、Service Behavior）；它一定收尾 */
  closing: CatalogBehavior | null;
}

/**
 * 依 sortOrder 走訪（BH-0.3 multi-match），以訊息到達時的快照為準。停止規則：
 *   系統登入、Service Behavior → 必停（登入連結是收尾動作）
 *   其他                       → stopOnMatch=true 停；false 繼續比對下一條
 */
function triggersToRun(
  triggers: readonly CatalogBehavior[],
  djsMessage: DjsMessage,
  userId: string,
  isDm: boolean,
  groupMembers: ReadonlyMap<string, ReadonlySet<string>>,
): TriggersToRun {
  const content = djsMessage.content ?? "";
  const webhooks: MatchedTrigger[] = [];
  for (const trigger of triggers) {
    if (!trigger.enabled) continue;
    if (!trigger.patternKind || trigger.patternValue === null) continue;
    if (!appliesTo(trigger, djsMessage, userId, isDm, groupMembers)) continue;
    const match = matchTrigger(trigger.patternKind, trigger.patternValue, content);
    if (!match) continue;
    if (trigger.actionSource !== "webhook") return { webhooks, closing: trigger };
    webhooks.push({ trigger, match });
    if (trigger.stopOnMatch) break;
  }
  return { webhooks, closing: null };
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
