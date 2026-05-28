import { randomUUID } from "node:crypto";
import {
  ApplicationCommandOptionType,
  BotRpcError,
  definePlugin,
  definePluginCommand,
  type CommandContext,
  type CommandReply,
  type PluginContext,
} from "@karyl-chan/plugin-sdk";
import { parseWhen } from "./parse-when.js";

const PLUGIN_KEY = "karyl-reminder";
const KEY_PREFIX = "r:";
const DUE_DIGITS = 13;
const TICK_MS = 30_000;

export interface ReminderRow {
  id: string;
  userId: string;
  channelId: string;
  text: string;
  dueAtMs: number;
}

function reminderKey(dueAtMs: number, id: string): string {
  return `${KEY_PREFIX}${String(dueAtMs).padStart(DUE_DIGITS, "0")}:${id}`;
}

let stopScheduler: (() => void) | null = null;

const addCommand = definePluginCommand({
  name: "remind-add",
  description: "Schedule a reminder.",
  scope: "guild",
  integrationTypes: ["guild_install"],
  contexts: ["Guild"],
  defaultEphemeral: true,
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: "when",
      description: "Duration like 10m, 2h, 1d.",
      required: true,
    },
    {
      type: ApplicationCommandOptionType.String,
      name: "what",
      description: "What should I remind you about?",
      required: true,
    },
  ],
  async handler(ctx: CommandContext): Promise<CommandReply> {
    if (!ctx.guildId || !ctx.channelId) {
      return { content: "Use this inside a server channel.", ephemeral: true };
    }
    const whenInput = String(ctx.options.when ?? "");
    const whatInput = String(ctx.options.what ?? "").trim();
    if (!whatInput) {
      return { content: "Need a non-empty reminder text.", ephemeral: true };
    }
    const dueAtMs = parseWhen(whenInput, Date.now());
    if (dueAtMs === null) {
      return {
        content: "Couldn't parse `when`. Try `10m`, `2h`, `1d`.",
        ephemeral: true,
      };
    }
    const row: ReminderRow = {
      id: randomUUID(),
      userId: ctx.userId,
      channelId: ctx.channelId,
      text: whatInput,
      dueAtMs,
    };
    const kv = ctx.kv.guild<ReminderRow>(ctx.guildId);
    try {
      await kv.set(reminderKey(dueAtMs, row.id), row);
    } catch (err) {
      if (err instanceof BotRpcError && err.reason === "quota_exceeded") {
        return {
          content:
            "This server's reminder storage is full. Cancel something with `/remind-cancel` first.",
          ephemeral: true,
        };
      }
      throw err;
    }
    const relSec = Math.round((dueAtMs - Date.now()) / 1000);
    return {
      content: `⏰ Got it — I'll ping you in ~${relSec}s about: ${whatInput}`,
      ephemeral: true,
    };
  },
});

const listCommand = definePluginCommand({
  name: "remind-list",
  description: "Show your pending reminders in this server.",
  scope: "guild",
  integrationTypes: ["guild_install"],
  contexts: ["Guild"],
  defaultEphemeral: true,
  async handler(ctx: CommandContext): Promise<CommandReply> {
    if (!ctx.guildId) {
      return { content: "Use this inside a server.", ephemeral: true };
    }
    const kv = ctx.kv.guild<ReminderRow>(ctx.guildId);
    const { entries } = await kv.listValues({ prefix: KEY_PREFIX, limit: 200 });
    const mine = entries
      .map((e) => e.value)
      .filter((r) => r.userId === ctx.userId);
    if (mine.length === 0) {
      return { content: "No reminders pending.", ephemeral: true };
    }
    const lines = mine.slice(0, 20).map((row) => {
      const relSec = Math.round((row.dueAtMs - Date.now()) / 1000);
      return `• \`${row.id.slice(0, 8)}\` in ${relSec}s — ${row.text}`;
    });
    return { content: lines.join("\n"), ephemeral: true };
  },
});

const cancelCommand = definePluginCommand({
  name: "remind-cancel",
  description: "Cancel one of your reminders.",
  scope: "guild",
  integrationTypes: ["guild_install"],
  contexts: ["Guild"],
  defaultEphemeral: true,
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: "id",
      description: "The 8-char id shown by /remind-list.",
      required: true,
    },
  ],
  async handler(ctx: CommandContext): Promise<CommandReply> {
    if (!ctx.guildId) {
      return { content: "Use this inside a server.", ephemeral: true };
    }
    const idFragment = String(ctx.options.id ?? "").toLowerCase();
    const kv = ctx.kv.guild<ReminderRow>(ctx.guildId);
    const { entries } = await kv.listValues({ prefix: KEY_PREFIX, limit: 200 });
    const hit = entries.find(
      ({ value }) =>
        value.userId === ctx.userId &&
        value.id.toLowerCase().startsWith(idFragment),
    );
    if (!hit) {
      return { content: "No matching reminder.", ephemeral: true };
    }
    await kv.delete(hit.key);
    return {
      content: `🗑️ Cancelled \`${hit.value.id.slice(0, 8)}\`.`,
      ephemeral: true,
    };
  },
});

async function tick(ctx: PluginContext): Promise<void> {
  const guildIds = await ctx.me.enabledGuilds();
  const nowMs = Date.now();
  for (const guildId of guildIds) {
    const kv = ctx.kv.guild<ReminderRow>(guildId);
    const { entries } = await kv.listValues({ prefix: KEY_PREFIX, limit: 50 });
    for (const { key, value: row } of entries) {
      if (row.dueAtMs > nowMs) continue;
      try {
        await ctx.discord.messages.send({
          channelId: row.channelId,
          content: `<@${row.userId}> ⏰ ${row.text}`,
        });
        await kv.delete(key);
      } catch (err) {
        ctx.log.error("reminder fire failed", {
          guildId,
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        // Leave the row in KV; next tick will retry. A production
        // plugin should track per-row retry count and dead-letter
        // after a threshold (channel deleted, perms revoked, …).
      }
    }
  }
}

export const plugin = definePlugin({
  key: PLUGIN_KEY,
  name: "Karyl Reminder",
  version: "0.1.0",
  description: "Schedule reminders with /remind-add.",

  // No guildFeatures — reminder runs unconditionally in every guild
  // the bot is in. `ctx.me.enabledGuilds()` returns that set
  // automatically (post-0.9 semantics; before that, plugins without
  // features got `[]` and were forced into a dummy-feature workaround).

  storage: { guildKv: true },

  // KV scopes + `interactions.respond` + `me.enabled_guilds` +
  // `me.log` + `me.metrics` are auto-derived by the manifest builder
  // from `storage.guildKv: true`, the command declarations, and the
  // presence of `onStart`. Only list scopes the auto-deriver can't see.
  rpcMethodsUsed: ["messages.send"],

  pluginCommands: [addCommand, listCommand, cancelCommand],

  async onStart(ctx: PluginContext): Promise<void> {
    let stopped = false;
    const loop = async (): Promise<void> => {
      if (stopped) return;
      try {
        await tick(ctx);
      } catch (err) {
        ctx.log.warn("scheduler tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (!stopped) setTimeout(loop, TICK_MS);
      }
    };
    setTimeout(loop, TICK_MS);
    stopScheduler = () => {
      stopped = true;
    };
    ctx.log.info("reminder scheduler started", { tickMs: TICK_MS });
  },

  async onStop(_ctx: PluginContext): Promise<void> {
    if (stopScheduler) stopScheduler();
    stopScheduler = null;
  },
});
