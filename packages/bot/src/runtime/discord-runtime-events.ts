import type {
  DMChannel,
  Interaction,
  Message,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User,
} from "discord.js";
import { ChannelType, Events } from "discord.js";
import { config } from "../config.js";
import { moduleLogger } from "../logger.js";
import { getDistributedLock } from "../adapters/registry.js";
import { botEventLog } from "../modules/bot-events/bot-event-log.js";
import { setReady } from "../modules/web-core/readiness.js";
import { dispatchEventToPlugins } from "../modules/plugin-system/plugin-event-bridge.service.js";
import { pluginCommandRegistry } from "../modules/plugin-system/plugin-command-registry.service.js";
import {
  syncInProcessCommandsForGuild,
  syncInProcessCommandsToDiscord,
} from "../modules/builtin-features/in-process-command-registry.service.js";
import type { RuntimeContext } from "./context.js";

const log = moduleLogger("main");

/**
 * Trim a Discord message down to the JSON shape plugins receive.
 * Don't send the entire djs Message object — it's huge and includes
 * circular references. Plugins that need more can RPC back for it.
 */
function serializeMessageForPlugin(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    channel_id: message.channelId,
    guild_id: message.guildId ?? null,
    content: message.content ?? "",
    author: {
      id: message.author.id,
      username: message.author.username,
      global_name: message.author.globalName,
      bot: message.author.bot,
    },
    attachments: [...message.attachments.values()].map((a) => ({
      id: a.id,
      url: a.url,
      filename: a.name,
      content_type: a.contentType,
      size: a.size,
    })),
    // Mentioned user ids + @everyone flag, and the replied-to message reference,
    // so plugins can detect being addressed / threading without a refetch.
    mentions: [...message.mentions.users.keys()],
    mention_everyone: message.mentions.everyone,
    message_reference: message.reference?.messageId
      ? {
          message_id: message.reference.messageId,
          channel_id: message.reference.channelId ?? null,
        }
      : null,
    timestamp: message.createdAt.toISOString(),
  };
}

/**
 * Attach every Discord gateway runtime event handler to the client.
 * Call before login so 'ready' and the message/interaction/reaction
 * handlers are in place when the gateway connects.
 */
export function registerRuntimeEvents(ctx: RuntimeContext): void {
  const { bot, commandReconciler, interactionDispatcher, messageMatcher } = ctx;

  // discord.js v14 emits 'ready' (with a one-time DeprecationWarning at
  // boot); 'clientReady' is the v15 rename and is NOT emitted in v14
  // yet. Stick with 'ready' until the v14→v15 migration; the warning is
  // noisy but harmless.
  bot.once("ready", async () => {
    const userTag = bot.user?.tag ?? "unknown";
    const userId = bot.user?.id ?? "unknown";
    await bot.guilds.fetch();
    const guildCount = bot.guilds.cache.size;
    botEventLog.record("info", "bot", `Bot ready: ${userTag}`, {
      userTag,
      userId,
      guildCount,
    });
    setReady("bot", true);
    // discordx's initApplicationCommands previously registered the four
    // in-process commands (picture-only / role-emoji / todo-channel /
    // rcon-forward). The discordx removal moved those onto our own
    // registry — discordx no longer owns any @Slash classes, so calling
    // initApplicationCommands now would just delete-then-recreate the
    // commands. Skip it; the registry handles sync.
    await syncInProcessCommandsToDiscord(bot);

    // Pre-cache each owner's DM channel. Originally a correctness fix
    // for the old DM-message-based /login handler; that path has been
    // refactored into a slash interaction (admin-login.service.ts) and
    // the raw MESSAGE_CREATE fallback below now generically rehydrates
    // un-cached DMs from any user. So this owner-specific warmup is now
    // an optimisation only — bot→owner DM sends and the first owner-side
    // message_pattern trigger skip the fallback's fetch+re-emit hop.
    for (const ownerId of config.bot.ownerIds) {
      try {
        const owner = await bot.users.fetch(ownerId);
        await owner.createDM();
      } catch (err) {
        log.error({ err }, "Failed to cache owner DM channel");
        const errorType =
          err instanceof Error ? err.constructor.name : "unknown";
        botEventLog.record("warn", "bot", "Failed to cache owner DM channel", {
          ownerId,
          errorType,
        });
      }
    }

    // Reconcile plugin slash commands with Discord. Runs after the
    // discordx initApplicationCommands above so we don't fight over
    // the global command registry. Failures are logged inside the
    // registry, so we just await and move on.
    // 注：pluginCommandRegistry.reconcileAll() 是 DB-only（不呼叫 Discord API）
    // 軌三 global 指令由下方 commandReconciler.reconcileAll() 接管。
    //
    // In a multi-shard deployment, only one process can call Discord's
    // global-application-commands set — otherwise N shards stomp each
    // other. We pick shard 0 *and* take a distributed lock so a
    // Redis-backed lock keeps the same invariant in flaky-restart
    // scenarios.
    if (config.bot.shardId === 0) {
      // Reconcile can legitimately exceed the lock timeout when Discord
      // rate-limits PUT /applications/.../commands hard — happens often
      // on a cold-start. Catch the outer rejection so the timeout
      // surfaces as a log + bot-event rather than an unhandledRejection
      // that crashes the bot 4 s later. The reconcile keeps running in
      // the background and usually completes the next cycle.
      await getDistributedLock()
        .run(
          "global-command-reconcile",
          async () => {
            await pluginCommandRegistry.reconcileAll();
            await commandReconciler.reconcileAll().catch((err: unknown) => {
              log.error({ err }, "commandReconciler.reconcileAll failed");
            });
          },
          { timeoutMs: 5 * 60_000 },
        )
        .catch((err: unknown) => {
          log.error({ err }, "global-command-reconcile timed out / errored");
        });
    } else {
      log.info(
        { shardId: config.bot.shardId },
        "skipping global command reconcile (shard != 0)",
      );
    }

    // MessagePatternMatcher 掛載 messageCreate listener（DM behaviors）。
    messageMatcher.register(bot);

    log.info({ stage: "boot" }, "bot started");
  });

  bot.on("guildCreate", async (guild) => {
    botEventLog.record("info", "bot", `Joined guild: ${guild.name}`, {
      guildId: guild.id,
      guildName: guild.name,
      memberCount: guild.memberCount,
    });
    // 軌一：in-process（built-in）guild feature 指令
    await syncInProcessCommandsForGuild(guild);
    // plugin guild-feature 指令：把每個 active plugin 在這個新 guild 解析為 on 的
    // feature 指令註冊起來（新 guild 還沒有 per-guild row → 跟 operator / manifest 預設）。
    pluginCommandRegistry
      .syncFeatureCommandsForNewGuild(guild)
      .catch((err: unknown) => {
        log.error(
          { err, guildId: guild.id },
          "pluginCommandRegistry.syncFeatureCommandsForNewGuild failed",
        );
      });
    // 軌二 + 軌三 scope=guild：增量 reconcile（OQ-8 補強）
    // 確保 bot 加入新 guild 時，scope='guild' 的 behaviors / plugin_commands 自動 register，
    // 不需重啟。catch 避免單 guild 失敗阻擋其他邏輯。
    commandReconciler.reconcileForGuild(guild).catch((err: unknown) => {
      log.error(
        { err, guildId: guild.id },
        "commandReconciler.reconcileForGuild failed",
      );
    });
  });

  bot.on("guildDelete", (guild) => {
    botEventLog.record("info", "bot", `Left guild: ${guild.name}`, {
      guildId: guild.id,
      guildName: guild.name,
    });
  });

  bot.on("interactionCreate", async (interaction: Interaction) => {
    // 統一的 InteractionDispatcher 接管所有 interaction dispatch。
    // 派發順序（C-runtime §4.1）：
    //   [1] behaviors 表 slash_command trigger（source: system / custom / plugin）
    //   [2] plugin_commands（軌三）── plugin-interaction-dispatch.service.ts
    //   [3] in-process registry（builtin-features）
    //   fallback：claimed=false，log warn
    try {
      const outcome = await interactionDispatcher.dispatch(interaction);
      if (!outcome.claimed && interaction.isChatInputCommand()) {
        log.warn(
          { commandName: interaction.commandName, reason: outcome.reason },
          "interactionCreate: unhandled slash command",
        );
      }
    } catch (error) {
      log.error({ err: error }, "interactionDispatcher.dispatch failed");
      // 硬 error 時嘗試回覆讓 Discord 不顯示「指令失敗」轉圈
      if (
        interaction.isChatInputCommand() &&
        !interaction.replied &&
        !interaction.deferred
      ) {
        await interaction
          .reply({ content: "⚠ 內部錯誤，請稍後再試。", ephemeral: true })
          .catch(() => {});
      }
    }
  });

  bot.on("messageCreate", async (message: Message) => {
    // discordx's executeCommand routed legacy `@SimpleCommand` text
    // commands. We've never used those — every command surface lives
    // on slash / behavior triggers — so nothing to dispatch here.
    // (Left as a hook: future "react to a message text" path could
    // plug in.)
    // Plugin event fan-out. We classify the message into one of two
    // event types (dm.message_create / guild.message_create) and let
    // the bridge fan it out to every plugin that subscribed in its
    // manifest. Bot's own messages are excluded so a plugin that
    // sends via RPC doesn't get its own send echoed back.
    if (message.author.bot) return;
    if (message.channel.type === ChannelType.DM) {
      dispatchEventToPlugins(
        "dm.message_create",
        serializeMessageForPlugin(message),
      );
    } else if (message.guildId) {
      dispatchEventToPlugins(
        "guild.message_create",
        serializeMessageForPlugin(message),
      );
    }
  });

  bot.on(
    "messageReactionAdd",
    async (
      reaction: MessageReaction | PartialMessageReaction,
      user: User | PartialUser,
    ) => {
      if (user.bot) return;
      // Only guild reactions for now — DM reactions don't carry a
      // guildId and most plugins that care (role-emoji etc.) want guild.
      if (!reaction.message.guildId) return;
      dispatchEventToPlugins("guild.message_reaction_add", {
        message_id: reaction.message.id,
        channel_id: reaction.message.channelId,
        guild_id: reaction.message.guildId,
        user_id: user.id,
        emoji: {
          id: reaction.emoji.id ?? null,
          name: reaction.emoji.name ?? null,
          animated: reaction.emoji.animated ?? false,
        },
      });
    },
  );

  bot.on(
    "messageReactionRemove",
    async (
      reaction: MessageReaction | PartialMessageReaction,
      user: User | PartialUser,
    ) => {
      if (user.bot) return;
      if (!reaction.message.guildId) return;
      dispatchEventToPlugins("guild.message_reaction_remove", {
        message_id: reaction.message.id,
        channel_id: reaction.message.channelId,
        guild_id: reaction.message.guildId,
        user_id: user.id,
        emoji: {
          id: reaction.emoji.id ?? null,
          name: reaction.emoji.name ?? null,
          animated: reaction.emoji.animated ?? false,
        },
      });
    },
  );

  // Re-emit messageCreate for DMs from users whose DM channel wasn't already
  // cached. discord.js's MessageCreateAction silently drops these because
  // createChannel can't infer the DM type from a message-shaped payload, so
  // the @On() handlers never see the first message from a new DM partner.
  // We fetch the channel (which populates cache) and dispatch the event.
  bot.on(
    "raw",
    async (packet: {
      t?: string;
      d?: { id?: string; channel_id?: string; guild_id?: string | null };
    }) => {
      if (packet.t !== "MESSAGE_CREATE") return;
      if (packet.d?.guild_id) return;
      const channelId = packet.d?.channel_id;
      if (!channelId) return;
      if (bot.channels.cache.has(channelId)) return;
      try {
        const channel = await bot.channels.fetch(channelId);
        if (!channel || !channel.isDMBased() || !channel.isTextBased()) return;
        // _add is private in the published typings but is discord.js's only
        // supported path for hydrating a raw MESSAGE_CREATE payload into a
        // Message instance; the event-bus expects a fully constructed Message.
        const messagesMgr = (channel as DMChannel).messages as unknown as {
          _add(data: unknown): Message;
        };
        const message = messagesMgr._add(packet.d);
        (bot.emit as (event: string, ...args: unknown[]) => boolean)(
          Events.MessageCreate,
          message,
        );
      } catch (err) {
        log.error({ err }, "failed to dispatch DM messageCreate fallback");
      }
    },
  );
}
