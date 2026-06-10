/**
 * command-system/interaction-dispatcher.service.ts
 *
 * InteractionDispatcher：統一的 Discord interactionCreate 入口。
 * main.ts 的 interactionCreate handler 一律呼叫 dispatcher.dispatch(interaction)，
 * 取代過去 main.ts 內多重 try 分叉（system / user-slash / in-process / plugin）。
 *
 * 對齊 C-runtime §4.1 派發路徑（first-claim-wins）：
 *   [1]   behaviors（slash_command trigger）── source ∈ {system, custom, plugin}
 *   [2]   plugin_commands（軌三）── 走 plugin-interaction-dispatch.service.ts
 *   [2.5] plugin components（按鈕 + select menu）── 走 plugin-component-dispatch.service.ts
 *         custom_id 必須是 `kc:<pluginKey>:<componentId>[:<tail>]`
 *   [2.6] plugin modals（MODAL_SUBMIT）── 走 plugin-modal-dispatch.service.ts
 *         custom_id 同 `kc:` prefix 規則
 *   [3]   in-process registry（builtin-features）── 保留
 *   fallback：claimed=false，由 main.ts log warn
 */

import {
  type Interaction,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  Behavior,
  type BehaviorRow,
} from "../behavior/models/behavior.model.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { dispatchInteractionToPlugin } from "../plugin-system/plugin-interaction-dispatch.service.js";
import { dispatchComponentToPlugin } from "../plugin-system/plugin-component-dispatch.service.js";
import { dispatchModalToPlugin } from "../plugin-system/plugin-modal-dispatch.service.js";
import { dispatchInProcessInteraction } from "../builtin-features/in-process-command-registry.service.js";
import { issueLoginLinkForInteraction } from "../admin/admin-login.service.js";
import {
  startSession,
  breakSessions,
} from "../behavior/models/behavior-session.model.js";
import { findGroupMembers } from "../behavior/models/behavior-group-member.model.js";
import { recordForwardOutcome } from "../behavior/models/behavior-stats.model.js";
import type { DispatchOutcome } from "./types.js";
import type { WebhookForwarder } from "./webhook-forwarder.service.js";
import { collectApplicableBehaviorsForUser } from "./message-pattern-matcher.service.js";
import { buildManualBehaviorsEmbed } from "./manual-list.js";
import { resolveLocale, tForInteraction } from "../../i18n/index.js";

// ── Discord webhook payload 建構（slash command → webhook body）─────────────

/**
 * 從 ChatInputCommandInteraction 建構 behavior webhook POST body。
 * 對齊 RESTPostAPIWebhookWithTokenJSONBody 形狀（C-runtime §7.1）。
 *
 * Discord webhook 原生欄位（content / username / avatar_url）帶 interaction 資訊，
 * plugin 可直接用標準 Discord webhook 消費邏輯處理。
 * _meta 欄位帶完整 interaction 元資訊供需要的 plugin 使用（behavior webhook 可忽略）。
 */
function buildWebhookPayload(
  interaction: ChatInputCommandInteraction,
): Record<string, unknown> {
  return {
    // Discord webhook 原生欄位：content 帶指令名稱（供 plugin 識別觸發入口）
    content: `/${interaction.commandName}`,
    // username / avatar_url 帶發送者資訊（相容 Discord 原生 webhook 形狀）
    username: interaction.user.globalName ?? interaction.user.username,
    avatar_url: interaction.user.displayAvatarURL(),
    // _meta：完整 interaction 元資訊，供 plugin 取用 interaction_id / token 等
    _meta: {
      interaction_id: interaction.id,
      interaction_token: interaction.token,
      application_id: interaction.applicationId,
      command_name: interaction.commandName,
      guild_id: interaction.guildId,
      channel_id: interaction.channelId,
      user: {
        id: interaction.user.id,
        username: interaction.user.username,
        global_name: interaction.user.globalName ?? null,
        discriminator: interaction.user.discriminator,
        avatar: interaction.user.avatar ?? null,
      },
      locale: interaction.locale ?? null,
      // slash command options（若有）供 plugin 讀取
      options: interaction.options.data.map((opt) => ({
        name: opt.name,
        type: opt.type,
        value: opt.value ?? null,
      })),
    },
  };
}

// ── InteractionDispatcher ────────────────────────────────────────────────────

export class InteractionDispatcher {
  constructor(private readonly forwarder: WebhookForwarder) {}

  /**
   * 統一 interactionCreate 入口。
   * 第一個 claim 即停。fallback：claimed=false 由 main.ts log warn。
   */
  async dispatch(interaction: Interaction): Promise<DispatchOutcome> {
    // ─ Layer 1：behaviors 表（slash_command trigger）
    if (interaction.isChatInputCommand()) {
      const outcome = await this.dispatchBehaviorLayer(interaction);
      if (outcome.claimed) return outcome;
    }

    // ─ Layer 2：plugin_commands（軌三）── 走既有 dispatchInteractionToPlugin
    try {
      const claimed = await dispatchInteractionToPlugin(interaction);
      if (claimed) {
        return { claimed: true, claimedBy: "plugin_command" };
      }
    } catch (err) {
      botEventLog.record(
        "error",
        "bot",
        `interaction-dispatcher: plugin_command layer 拋出例外：${err instanceof Error ? err.message : String(err)}`,
        {
          commandName: interaction.isChatInputCommand()
            ? interaction.commandName
            : undefined,
        },
      );
      // layer 2 失敗不短路，繼續嘗試 layer 2.5 / 3
    }

    // ─ Layer 2.5：plugin 元件（按鈕 + select menu）── custom_id 為 `kc:<pluginKey>:…`
    if (interaction.isButton() || interaction.isAnySelectMenu()) {
      try {
        const claimed = await dispatchComponentToPlugin(interaction);
        if (claimed) {
          return { claimed: true, claimedBy: "plugin_component" };
        }
      } catch (err) {
        botEventLog.record(
          "error",
          "bot",
          `interaction-dispatcher: plugin_component layer 拋出例外：${err instanceof Error ? err.message : String(err)}`,
          { customId: interaction.customId },
        );
        // 失敗不短路，繼續嘗試 layer 3（in-process 可能有同 prefix 的 handler）
      }
    }

    // ─ Layer 2.6：plugin modal submit ── custom_id 為 `kc:<pluginKey>:…`
    if (interaction.isModalSubmit()) {
      try {
        const claimed = await dispatchModalToPlugin(interaction);
        if (claimed) {
          return { claimed: true, claimedBy: "plugin_modal" };
        }
      } catch (err) {
        botEventLog.record(
          "error",
          "bot",
          `interaction-dispatcher: plugin_modal layer 拋出例外：${err instanceof Error ? err.message : String(err)}`,
          { customId: interaction.customId },
        );
        // 失敗不短路，繼續嘗試 layer 3
      }
    }

    // ─ Layer 3：in-process registry（builtin-features）
    try {
      const claimed = await dispatchInProcessInteraction(interaction);
      if (claimed) {
        return { claimed: true, claimedBy: "in_process" };
      }
    } catch (err) {
      botEventLog.record(
        "error",
        "bot",
        `interaction-dispatcher: in-process layer 拋出例外：${err instanceof Error ? err.message : String(err)}`,
        {
          commandName: interaction.isChatInputCommand()
            ? interaction.commandName
            : undefined,
        },
      );
    }

    // ─ Fallback：未被任何層 claim
    // Autocomplete has a hard ~3s deadline and ONLY respond() can close it
    // (you can't reply/defer it). If an autocomplete reached here unclaimed —
    // the plugin layer threw (caught above, fell through) or the command was
    // deregistered while Discord still offers it — ack with no suggestions so
    // the user doesn't stare at a frozen list until Discord times it out.
    // Safe even if a layer already responded: the .catch swallows the dup.
    if (interaction.isAutocomplete()) {
      await interaction.respond([]).catch(() => {});
    }
    return {
      claimed: false,
      reason: "unknown_command",
    };
  }

  // ── Layer 1：behaviors 表 slash dispatch ──────────────────────────────────

  private async dispatchBehaviorLayer(
    interaction: ChatInputCommandInteraction,
  ): Promise<DispatchOutcome> {
    let behaviorRow: BehaviorRow | null = null;
    try {
      // 查找 behaviors 表中 triggerType='slash_command' + slashCommandName 匹配的 row
      const row = await Behavior.findOne({
        where: {
          triggerType: "slash_command",
          slashCommandName: interaction.commandName,
          enabled: true,
        },
      });
      if (!row) return { claimed: false };

      behaviorRow = {
        id: row.getDataValue("id") as number,
        title: row.getDataValue("title") as string,
        description: (row.getDataValue("description") as string) ?? "",
        enabled: !!row.getDataValue("enabled"),
        sortOrder: row.getDataValue("sortOrder") as number,
        stopOnMatch: !!row.getDataValue("stopOnMatch"),
        ignoreBots: !!row.getDataValue("ignoreBots"),
        sessionExpireHours:
          (row.getDataValue("sessionExpireHours") as number | null) ?? null,
        forwardType: row.getDataValue(
          "forwardType",
        ) as BehaviorRow["forwardType"],
        source: row.getDataValue("source") as BehaviorRow["source"],
        triggerType: row.getDataValue(
          "triggerType",
        ) as BehaviorRow["triggerType"],
        messagePatternKind:
          (row.getDataValue(
            "messagePatternKind",
          ) as BehaviorRow["messagePatternKind"]) ?? null,
        messagePatternValue:
          (row.getDataValue("messagePatternValue") as string | null) ?? null,
        slashCommandName:
          (row.getDataValue("slashCommandName") as string | null) ?? null,
        slashCommandDescription:
          (row.getDataValue("slashCommandDescription") as string | null) ??
          null,
        slashCommandOptions:
          (row.getDataValue("slashCommandOptions") as string | null) ?? null,
        scope: row.getDataValue("scope") as BehaviorRow["scope"],
        integrationTypes: row.getDataValue("integrationTypes") as string,
        contexts: row.getDataValue("contexts") as string,
        placementGuildId:
          (row.getDataValue("placementGuildId") as string | null) ?? null,
        placementChannelId:
          (row.getDataValue("placementChannelId") as string | null) ?? null,
        audienceKind: row.getDataValue(
          "audienceKind",
        ) as BehaviorRow["audienceKind"],
        audienceUserId:
          (row.getDataValue("audienceUserId") as string | null) ?? null,
        audienceGroupName:
          (row.getDataValue("audienceGroupName") as string | null) ?? null,
        webhookUrl: (row.getDataValue("webhookUrl") as string | null) ?? null,
        webhookSecret:
          (row.getDataValue("webhookSecret") as string | null) ?? null,
        webhookAuthMode:
          (row.getDataValue(
            "webhookAuthMode",
          ) as BehaviorRow["webhookAuthMode"]) ?? null,
        systemKey:
          (row.getDataValue("systemKey") as BehaviorRow["systemKey"]) ?? null,
        scopeTabId: (row.getDataValue("scopeTabId") as number) ?? 1,
      };
    } catch (err) {
      botEventLog.record(
        "error",
        "bot",
        `interaction-dispatcher: behaviors 表查詢失敗：${err instanceof Error ? err.message : String(err)}`,
        { commandName: interaction.commandName },
      );
      // C-runtime §4.3：behaviors 查詢失敗不短路，繼續嘗試下一層
      return { claimed: false };
    }

    if (!behaviorRow) return { claimed: false };

    const source = behaviorRow.source;
    const claimedBy =
      source === "system"
        ? ("behavior_system" as const)
        : ("behavior_custom" as const);

    // Reach 執法：placement（在哪）與 audience（誰）必須在轉發前檢查。
    // pattern 路徑由 collectApplicableBehaviorsForUser 過濾；slash 註冊面
    // （Discord 指令可見性）只能控到 guild 粒度，specific user/group/channel
    // 的限制必須在 dispatch 端把關，否則看得到指令的人都能觸發。
    const reach = await this.checkBehaviorReach(interaction, behaviorRow);
    if (reach !== "ok") {
      const key =
        reach === "wrong_place"
          ? "system.behavior-wrong-place"
          : "system.behavior-not-allowed";
      await interaction
        .reply({ content: tForInteraction(interaction, key), ephemeral: true })
        .catch(() => {});
      return { claimed: true, claimedBy };
    }

    if (source === "system") {
      return this.dispatchSystemBehavior(interaction, behaviorRow);
    }

    if (source === "custom") {
      return this.dispatchWebhookBehavior(interaction, behaviorRow);
    }

    return { claimed: false };
  }

  // ── reach 執法（placement + audience）────────────────────────────────────

  /**
   * 檢查 invoker 是否在此 behavior 的 reach 內。
   *
   * placement：placementGuildId/ChannelId 非空時，interaction 必須發生在該處
   *            （specific_guild / specific_channel tab 的承諾）。
   * audience：user → 比對 invoker id；group → 查 behavior_audience_members；
   *           all → 放行。
   *
   * group 查詢失敗時 fail-closed（deny）——這是授權閘，寧可誤拒不可誤放。
   */
  private async checkBehaviorReach(
    interaction: ChatInputCommandInteraction,
    behaviorRow: BehaviorRow,
  ): Promise<"ok" | "wrong_place" | "not_in_audience"> {
    if (
      behaviorRow.placementGuildId !== null &&
      interaction.guildId !== behaviorRow.placementGuildId
    ) {
      return "wrong_place";
    }
    if (
      behaviorRow.placementChannelId !== null &&
      interaction.channelId !== behaviorRow.placementChannelId
    ) {
      return "wrong_place";
    }

    if (behaviorRow.audienceKind === "user") {
      return behaviorRow.audienceUserId === interaction.user.id
        ? "ok"
        : "not_in_audience";
    }
    if (behaviorRow.audienceKind === "group") {
      // groupName null = 設定不完整（audienceShape validator 應已擋）→ deny
      if (behaviorRow.audienceGroupName === null) return "not_in_audience";
      try {
        const members = await findGroupMembers(behaviorRow.audienceGroupName);
        return members.includes(interaction.user.id)
          ? "ok"
          : "not_in_audience";
      } catch (err) {
        botEventLog.record(
          "error",
          "bot",
          `interaction-dispatcher: audience 成員查詢失敗（fail-closed deny）：${err instanceof Error ? err.message : String(err)}`,
          { behaviorId: behaviorRow.id, userId: interaction.user.id },
        );
        return "not_in_audience";
      }
    }
    return "ok";
  }

  // ── source=system dispatch ────────────────────────────────────────────────

  /**
   * system behavior（admin-login/manual/break）dispatch。
   *
   * 對齊 C-runtime §4.1：source=system 分支由此處理，不流到 WebhookForwarder。
   *
   * systemKey 對應：
   *   admin-login → issueLoginLinkForInteraction（admin-login.service.ts）
   *   manual      → manual 語意為「開始 continuous forward session 到特定 behavior」，
   *                 但需要 behaviorRow 提供目標 behavior id（admin/behaviors UI 補），
   *                 此版本回 ephemeral 說明暫不支援。
   *   break       → breakSessions(userId, channelId)（清除當前 channel 的
   *                 session，無則清全部 — 逃生門語意，BH-4.3）
   */
  private async dispatchSystemBehavior(
    interaction: ChatInputCommandInteraction,
    behaviorRow: BehaviorRow,
  ): Promise<DispatchOutcome> {
    const systemKey = behaviorRow.systemKey;

    if (systemKey === "admin-login") {
      await issueLoginLinkForInteraction(interaction);
      return { claimed: true, claimedBy: "behavior_system" };
    }

    if (systemKey === "break") {
      const ended = await breakSessions(
        interaction.user.id,
        interaction.channelId,
      );
      const key = ended ? "system.session-ended" : "system.no-session";
      await interaction
        .reply({ content: tForInteraction(interaction, key), ephemeral: true })
        .catch(() => {});
      return { claimed: true, claimedBy: "behavior_system" };
    }

    if (systemKey === "manual") {
      return this.dispatchManualBehavior(interaction);
    }

    // 未知 systemKey（不應發生，behaviorsS 表 CHECK 約束攔截）
    const unknownKey = systemKey ?? "(null)";
    botEventLog.record(
      "warn",
      "bot",
      `interaction-dispatcher: 未知 systemKey='${unknownKey}'，claimed=true 阻止漏到下一層`,
      { commandName: interaction.commandName, systemKey: unknownKey },
    );
    await interaction
      .reply({
        content: tForInteraction(interaction, "system.unknown-system-command"),
        ephemeral: true,
      })
      .catch(() => {});
    return { claimed: true, claimedBy: "behavior_system" };
  }

  // ── /manual：列出此 user 在 DM 觸發可用的 behaviors ─────────────────────

  /**
   * /manual slash command 真實實作。
   *
   * 列出此 user 在 DM 觸發時 match 的所有 behaviors（依 audienceKind 過濾）。
   * 回 ephemeral embed，顯示 title / triggerType / trigger preview。
   * 若 0 條 → 「目前在私訊沒有可用行為」。
   */
  private async dispatchManualBehavior(
    interaction: ChatInputCommandInteraction,
  ): Promise<DispatchOutcome> {
    const userId = interaction.user.id;

    let behaviors: BehaviorRow[] = [];
    try {
      behaviors = await collectApplicableBehaviorsForUser(userId);
    } catch (err) {
      botEventLog.record(
        "error",
        "bot",
        `interaction-dispatcher: /manual 查詢 behaviors 失敗：${err instanceof Error ? err.message : String(err)}`,
        { userId },
      );
      await interaction
        .reply({
          content: tForInteraction(interaction, "system.cannot-load-manual"),
          ephemeral: true,
        })
        .catch(() => {});
      return { claimed: true, claimedBy: "behavior_system" };
    }

    const embed = buildManualBehaviorsEmbed(behaviors, resolveLocale(interaction));
    if (!embed) {
      await interaction
        .reply({
          content: tForInteraction(interaction, "system.no-manual"),
          ephemeral: true,
        })
        .catch(() => {});
      return { claimed: true, claimedBy: "behavior_system" };
    }

    await interaction
      .reply({ embeds: [embed], ephemeral: true })
      .catch(() => {});

    botEventLog.record(
      "info",
      "bot",
      `/manual: userId=${userId} 查詢到 ${behaviors.length} 條可用行為`,
      { userId, count: behaviors.length },
    );

    return { claimed: true, claimedBy: "behavior_system" };
  }

  // ── source=custom dispatch（webhook）────────────────────────────────────

  /**
   * custom behavior dispatch：建構 payload（不含 interaction_token，custom
   * webhook 是裸外部 URL）後呼叫 WebhookForwarder。
   */
  private async dispatchWebhookBehavior(
    interaction: ChatInputCommandInteraction,
    behaviorRow: BehaviorRow,
  ): Promise<DispatchOutcome> {
    const payload = buildWebhookPayload(interaction);
    delete (payload._meta as Record<string, unknown>).interaction_token;
    // BH-2.1：與 pattern 路徑對齊 — _meta 帶 behavior_id 供 webhook 端
    // 在多條 behavior 指向同一端點時辨識來源。
    (payload._meta as Record<string, unknown>).behavior_id = behaviorRow.id;

    // Defer reply（slash command 需要在 3s 內 ack）
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch {
      return { claimed: true, claimedBy: "behavior_custom" };
    }

    try {
      const result = await this.forwarder.forward(
        behaviorRow,
        payload as Record<string, unknown>,
      );
      await recordForwardOutcome(behaviorRow.id, result.ok, result.error);

      if (!result.ok) {
        await interaction
          .editReply({
            content: tForInteraction(interaction, "system.webhook-failed", {
              error:
                result.error ??
                tForInteraction(interaction, "common.unknown-error"),
            }),
            // webhook error text is operator-controlled but may contain
            // @everyone / role mentions; suppress like the success path
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
        return { claimed: true, claimedBy: "behavior_custom" };
      }

      // M-2 修：continuous + slash 觸發要 startSession，否則使用者後續 DM
      // 進不到 webhook（matcher 沒 session 可走、又因 triggerType !==
      // 'message_pattern' 跳過匹配）。channelId 用 DM channel 而不是
      // interaction.channelId — slash 可能在 guild 觸發，但 session 是
      // 「下一則 DM 走這條 webhook」的語意，必須是 DM channel。
      // result.ended=true 代表 webhook 第一發就回 sentinel，session 不開。
      // startSession 是 upsert：使用者既有 session 會被本次覆蓋（語意：
      // admin 明示要切到這條 continuous behavior）。
      let dmStartFailed = false;
      if (behaviorRow.forwardType === "continuous" && !result.ended) {
        try {
          const dm = await interaction.user.createDM();
          await startSession(
            interaction.user.id,
            behaviorRow.id,
            dm.id,
            behaviorRow.sessionExpireHours,
          );
        } catch (err) {
          dmStartFailed = true;
          botEventLog.record(
            "warn",
            "bot",
            `interaction-dispatcher: 無法為 continuous behavior ${behaviorRow.id} 啟動 session：${err instanceof Error ? err.message : String(err)}`,
            { behaviorId: behaviorRow.id, userId: interaction.user.id },
          );
        }
      }

      // 給使用者一個明確訊號：continuous 觸發成功但 session 沒建（最常見
      // 原因是隱私設定關閉了 DMs），不然 user 會以為 session 已建立卻無
      // 法後續傳訊息進來。
      const dmWarning = dmStartFailed
        ? tForInteraction(interaction, "system.continuous-dm-warning")
        : "";

      if (result.relayContent || result.relayEmbeds || dmStartFailed) {
        // relay 內容來自外部 webhook，不可信，strip mentions 防止
        // user/role ping 經 bot relay 放大（與 message-pattern-matcher
        // session 路徑同個威脅模型，這裡補上同等保護）。embeds 已在
        // forwarder 白名單清洗（BH-2.2A）。
        await interaction
          .editReply({
            content: (result.relayContent ?? "") + dmWarning,
            embeds: result.relayEmbeds ?? [],
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
      } else {
        // 無回覆內容則刪除 deferred reply
        await interaction.deleteReply().catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await interaction
        .editReply({
          content: tForInteraction(interaction, "common.internal-error", {
            msg,
          }),
          // exception messages can include user/role mention strings;
          // strip them like the success / webhook-failed paths
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
      botEventLog.record(
        "error",
        "bot",
        `interaction-dispatcher: webhook behavior ${behaviorRow.id} 拋出例外：${msg}`,
        { behaviorId: behaviorRow.id, commandName: interaction.commandName },
      );
    }

    return { claimed: true, claimedBy: "behavior_custom" };
  }
}
