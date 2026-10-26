/**
 * command-system/interaction-dispatcher.service.ts
 *
 * InteractionDispatcher：統一的 Discord interactionCreate 入口。
 * main.ts 的 interactionCreate handler 一律呼叫 dispatcher.dispatch(interaction)，
 * 取代過去 main.ts 內多重 try 分叉（system / user-slash / in-process / plugin）。
 *
 * 對齊 C-runtime §4.1 派發路徑（first-claim-wins）：
 *   [1]   behaviors（Command Trigger）── 指令（名稱 + 註冊目標）→ 葉節點（子指令）
 *         → 動作（builtin：系統登入；webhook）
 *   [2]   plugin_commands（軌三）── 走 plugin-interaction-dispatch.service.ts
 *   [2.5] plugin components（按鈕 + select menu）── 走 plugin-component-dispatch.service.ts
 *         custom_id 必須是 `kc:<pluginKey>:<componentId>[:<tail>]`
 *   [2.6] plugin modals（MODAL_SUBMIT）── 走 plugin-modal-dispatch.service.ts
 *         custom_id 同 `kc:` prefix 規則
 *   [3]   in-process registry（builtin-features）── 保留
 *   fallback：claimed=false，由 main.ts log warn
 */

import {
  ApplicationCommandOptionType,
  type Interaction,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  getBehaviorCatalog,
  type CatalogBehavior,
} from "../behavior/behavior-catalog.js";
import { leafPathOf } from "../behavior/models/behavior-definition.model.js";
import {
  behaviorCommandTarget,
  targetMatchesInvocation,
} from "./command-target.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { dispatchInteractionToPlugin } from "../plugin-system/plugin-interaction-dispatch.service.js";
import { dispatchComponentToPlugin } from "../plugin-system/plugin-component-dispatch.service.js";
import { dispatchModalToPlugin } from "../plugin-system/plugin-modal-dispatch.service.js";
import { dispatchInProcessInteraction } from "../builtin-features/in-process-command-registry.service.js";
import { issueLoginLinkForInteraction } from "../admin/admin-login.service.js";
import { recordForwardOutcome } from "../behavior/models/behavior-stats.model.js";
import type { DispatchOutcome } from "./types.js";
import type { WebhookForwarder } from "./webhook-forwarder.service.js";
import { tForInteraction } from "../../i18n/index.js";

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
  subcommand: string,
): Record<string, unknown> {
  // 子指令的參數在它的 option 底下
  const data = interaction.options.data;
  const invoked =
    subcommand !== "" &&
    data[0]?.type === ApplicationCommandOptionType.Subcommand
      ? (data[0].options ?? [])
      : data;
  return {
    // Discord webhook 原生欄位：content 帶指令路徑（供 webhook 識別觸發入口，
    // 子指令也在這裡；_meta 的鍵集合是 plugin-wire 的契約，不另加欄位）
    content: `/${interaction.commandName}${subcommand ? ` ${subcommand}` : ""}`,
    // username / avatar_url 帶發送者資訊（相容 Discord 原生 webhook 形狀）
    username: interaction.user.globalName ?? interaction.user.username,
    avatar_url: interaction.user.displayAvatarURL(),
    // _meta：完整 interaction 元資訊
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
      // 被呼叫的葉節點的參數
      options: invoked.map((opt) => ({
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
    // ─ Layer 1：behavior 指令（Command Trigger）
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

  // ── Layer 1：behavior 指令 ──────────────────────────────────────────────

  private async dispatchBehaviorLayer(
    interaction: ChatInputCommandInteraction,
  ): Promise<DispatchOutcome> {
    let subcommand = "";
    let leaf: CatalogBehavior | null = null;
    try {
      const subcommandGroup =
        interaction.options.getSubcommandGroup(false) ?? "";
      subcommand = interaction.options.getSubcommand(false) ?? "";
      // 以 (commandName, commandGuildId) 找指令：commandGuildId 是這個指令
      // 註冊在哪個伺服器（全域指令為 null），與 interaction 發生在哪裡無關。
      // 同名指令可能分屬不同目標（全域 behavior vs plugin 的伺服器指令、
      // 不同伺服器的指定伺服器指令），只認目標相符的那一個。
      const commandGuildId = interaction.commandGuildId ?? null;
      const { commands } = await getBehaviorCatalog();
      const command = commands.find(
        (c) =>
          c.name === interaction.commandName &&
          targetMatchesInvocation(behaviorCommandTarget(c), commandGuildId),
      );
      leaf =
        command?.leaves.find((l) => {
          const path = leafPathOf(l);
          return (
            l.enabled &&
            path.subcommandGroup === subcommandGroup &&
            path.subcommand === subcommand
          );
        }) ?? null;
    } catch (err) {
      botEventLog.record(
        "error",
        "bot",
        `interaction-dispatcher: behaviors 查詢失敗：${err instanceof Error ? err.message : String(err)}`,
        { commandName: interaction.commandName },
      );
      // C-runtime §4.3：behaviors 查詢失敗不短路，繼續嘗試下一層
      return { claimed: false };
    }

    if (!leaf) return { claimed: false };

    // 不做執行時的對象 / 位置檢查（ADR 0003）：誰看得到、在哪能用由
    // Discord 與伺服器管理員決定，看得到就能執行；要不要服務這個使用者
    // 由動作自己決定（例如登入動作檢查授權）。
    if (leaf.actionSource === "builtin") {
      return this.dispatchSystemBehavior(interaction, leaf);
    }
    return this.dispatchWebhookBehavior(interaction, leaf, subcommand);
  }

  // ── source=system dispatch ────────────────────────────────────────────────

  /**
   * 內建動作（actionSource='builtin'）：只給 System Behavior，目前只有登入
   * （admin-login → issueLoginLinkForInteraction）。
   */
  private async dispatchSystemBehavior(
    interaction: ChatInputCommandInteraction,
    leaf: CatalogBehavior,
  ): Promise<DispatchOutcome> {
    const systemKey = leaf.systemKey;

    if (systemKey === "admin-login") {
      await issueLoginLinkForInteraction(interaction);
      return { claimed: true, claimedBy: "behavior_system" };
    }

    // 未知 systemKey（不應發生，model validate 擋住）
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

  // ── webhook 動作 ────────────────────────────────────────────────────────

  /**
   * webhook 動作：建構 payload（不含 interaction_token，webhook 是裸外部
   * URL）後呼叫 WebhookForwarder。
   */
  private async dispatchWebhookBehavior(
    interaction: ChatInputCommandInteraction,
    leaf: CatalogBehavior,
    subcommand: string,
  ): Promise<DispatchOutcome> {
    const webhook = leaf.webhook;
    if (!webhook) {
      botEventLog.record(
        "warn",
        "bot",
        `interaction-dispatcher: behavior ${leaf.id} 沒有 webhook 動作`,
        { behaviorId: leaf.id },
      );
      await interaction
        .reply({
          content: tForInteraction(interaction, "common.internal-error", {
            msg: "webhook action missing",
          }),
          ephemeral: true,
        })
        .catch(() => {});
      return { claimed: true, claimedBy: "behavior_custom" };
    }
    const payload = buildWebhookPayload(interaction, subcommand);
    delete (payload._meta as Record<string, unknown>).interaction_token;
    // BH-2.1：與 pattern 路徑對齊 — _meta 帶 behavior_id 供 webhook 端
    // 在多條 behavior 指向同一端點時辨識來源。
    (payload._meta as Record<string, unknown>).behavior_id = leaf.id;

    // Defer reply（slash command 需要在 3s 內 ack）
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch {
      return { claimed: true, claimedBy: "behavior_custom" };
    }

    try {
      const result = await this.forwarder.forward(
        webhook,
        payload as Record<string, unknown>,
      );
      await recordForwardOutcome(leaf.id, result.ok, result.error);

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

      if (result.relayContent || result.relayEmbeds) {
        // relay 內容來自外部 webhook，不可信，strip mentions 防止
        // user/role ping 經 bot relay 放大（與 message-trigger-matcher
        // 同個威脅模型）。embeds 已在 forwarder 白名單清洗（BH-2.2A）。
        await interaction
          .editReply({
            content: result.relayContent ?? "",
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
        `interaction-dispatcher: webhook behavior ${leaf.id} 拋出例外：${msg}`,
        { behaviorId: leaf.id, commandName: interaction.commandName },
      );
    }

    return { claimed: true, claimedBy: "behavior_custom" };
  }
}
