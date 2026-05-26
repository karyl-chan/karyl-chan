import { config } from "../../config.js";
import {
  type Interaction,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from "discord.js";
import {
  findPluginCommandByName,
  type PluginCommandRow,
} from "./models/plugin-command.model.js";
import { findPluginById, type PluginRow } from "./models/plugin.model.js";
import type { PluginManifest } from "./plugin-registry.service.js";
import { resolveUserCapabilities } from "../admin/authorized-user.service.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import {
  assertPluginTarget,
  HostPolicyError,
} from "../../utils/host-policy.js";
import { buildOutboundSignatureHeaders } from "../../utils/hmac.js";
import { recordPluginDeferReply } from "./plugin-defer-state.js";

/**
 * Inbound Discord interaction → plugin dispatcher.
 *
 * Returns true if the interaction was claimed by a plugin (caller
 * should NOT pass it to discordx); false if no plugin owns the
 * command and the caller should fall through to the in-process
 * dispatcher.
 *
 * Two interaction kinds are handled:
 *   - ChatInputCommand: defer reply (3s budget), POST interaction
 *     details to plugin's /commands/<name> endpoint. Plugin calls
 *     back via /api/plugin/interactions.respond to populate the
 *     deferred reply. We don't await the plugin — Discord's 15-min
 *     followup window is plenty even for slow plugins.
 *   - Autocomplete: must respond synchronously (no defer), so we
 *     await the plugin's POST with a 1.5s budget and forward the
 *     choices it returns. Failure / timeout → return empty choices
 *     so the user sees no suggestions but the input box still works.
 *
 * Component / modal interactions land here too via the prefix-routed
 * customId convention; handled in a follow-up.
 */

const DEFAULT_COMMAND_PATH = "/commands/{command_name}";
const DEFAULT_AUTOCOMPLETE_PATH = "/commands/{command_name}/autocomplete";
const COMMAND_DISPATCH_TIMEOUT_MS = config.plugin.commandDispatchTimeoutMs;
const AUTOCOMPLETE_TIMEOUT_MS = config.plugin.autocompleteTimeoutMs;

function parseManifest(plugin: PluginRow): PluginManifest | null {
  try {
    return JSON.parse(plugin.manifestJson) as PluginManifest;
  } catch {
    return null;
  }
}

function buildHeaders(
  secret: string,
  url: string,
  body: string,
): Record<string, string> {
  const urlPath = new URL(url).pathname;
  return {
    "Content-Type": "application/json",
    ...buildOutboundSignatureHeaders(secret, "POST", urlPath, body),
  };
}

function resolveUrl(
  plugin: PluginRow,
  manifest: PluginManifest,
  template: string,
  variables: Record<string, string>,
): string | null {
  let path = template;
  for (const [k, v] of Object.entries(variables)) {
    path = path.split(`{${k}}`).join(encodeURIComponent(v));
  }
  try {
    return new URL(path, plugin.url).toString();
  } catch {
    return null;
  }
}

interface OptionEntry {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: OptionEntry[];
}

/**
 * Walk the option tree from a ChatInputCommandInteraction. discord.js
 * stores options as a CommandInteractionOptionResolver under the hood;
 * the public API gives us the resolved values but not the raw shape
 * — we serialize down to a plugin-friendly tree.
 */
function serializeOptions(interaction: ChatInputCommandInteraction): {
  sub_command?: string;
  sub_command_group?: string;
  options: OptionEntry[];
} {
  const subGroup = interaction.options.getSubcommandGroup(false) ?? undefined;
  const sub = interaction.options.getSubcommand(false) ?? undefined;
  // discord.js' resolver doesn't directly expose a raw tree; rebuild
  // from the data on the interaction.
  const raw = (
    interaction.options as unknown as { _hoistedOptions?: OptionEntry[] }
  )._hoistedOptions;
  return {
    sub_command: sub,
    sub_command_group: subGroup,
    options: raw ?? [],
  };
}

async function dispatchChatInputCommand(
  interaction: ChatInputCommandInteraction,
  plugin: PluginRow,
  manifest: PluginManifest,
): Promise<void> {
  const dispatchKey = plugin.dispatchHmacKey;
  if (!dispatchKey) {
    await interaction.reply({
      content: "⚠ Plugin 尚未完成 re-register，dispatch key 不存在。",
      ephemeral: true,
    });
    return;
  }
  // Look up the command's manifest entry to decide:
  //  (a) `modal: true` → skip defer entirely (Discord rejects
  //      modal-after-defer); plugin will send_modal via RPC within 3 s.
  //  (b) all other commands defer with the manifest's declared
  //      `default_ephemeral` (default true when unspecified).
  //
  // Discord locks ephemerality at defer time, so the bot has to commit
  // before the plugin runs. Plugins that want the opposite of their
  // declared default for a specific case can still flip via the
  // `ephemeral` field on their CommandReply — the respond endpoint
  // posts a follow-up of the desired ephemerality and DELETEs @original
  // so the user only sees one message of the right kind.
  const cmdName = interaction.commandName;
  const allCmds = [
    ...(manifest.plugin_commands ?? []),
    ...(manifest.guild_features ?? []).flatMap((f) => f.commands ?? []),
  ];
  const cmdDef = allCmds.find((c) => c.name === cmdName);
  const isModal = cmdDef?.modal ?? false;
  const defaultEphemeral = cmdDef?.default_ephemeral ?? true;

  if (!isModal) {
    try {
      await interaction.deferReply({ ephemeral: defaultEphemeral });
      recordPluginDeferReply(interaction.token, defaultEphemeral);
    } catch (err) {
      // Already acknowledged or token expired — nothing else we can do.
      botEventLog.record(
        "warn",
        "bot",
        `plugin-interaction: defer failed for ${plugin.pluginKey}/${interaction.commandName}: ${err instanceof Error ? err.message : String(err)}`,
        { pluginId: plugin.id },
      );
      return;
    }
  }

  // Modal commands skipped defer, so error messaging here must use
  // `reply` (no deferred state to edit); all other commands use
  // `editReply`. Wrap once so the rest of the function stays linear.
  const replyError = (content: string): Promise<unknown> =>
    isModal
      ? interaction.reply({ content, ephemeral: true }).catch(() => {})
      : interaction.editReply({ content }).catch(() => {});

  const url = resolveUrl(
    plugin,
    manifest,
    manifest.endpoints?.plugin_command ?? DEFAULT_COMMAND_PATH,
    { command_name: interaction.commandName },
  );
  if (!url) {
    await replyError("⚠ 無法解析 plugin 的指令端點。");
    return;
  }

  const parsedCmdUrl = new URL(url);
  const cmdPort = parsedCmdUrl.port
    ? Number(parsedCmdUrl.port)
    : parsedCmdUrl.protocol === "https:"
      ? 443
      : 80;
  try {
    await assertPluginTarget(parsedCmdUrl.hostname, cmdPort);
  } catch (err) {
    if (!(err instanceof HostPolicyError)) throw err;
    botEventLog.record(
      "warn",
      "bot",
      `plugin-interaction: pre-flight host-policy 拒絕 ${plugin.pluginKey}/${interaction.commandName}: ${err.message}`,
      { pluginId: plugin.id },
    );
    await replyError(`⚠ Plugin 端點不被允許: ${err.message}`);
    return;
  }

  const opts = serializeOptions(interaction);
  // The invoker's plugin-relevant RBAC tokens, narrowed to what THIS
  // plugin may act on: the `admin` superuser token plus this plugin's
  // own `plugin:<pluginKey>:*` grants — never another plugin's, never
  // guild/behavior scopes. Lets a plugin gate a subcommand on a
  // capability it declared (e.g. radio's `download`).
  const allCaps = await resolveUserCapabilities(interaction.user.id);
  const pluginCaps = [...allCaps].filter(
    (c) => c === "admin" || c.startsWith(`plugin:${plugin.pluginKey}:`),
  );
  const payload = {
    interaction_id: interaction.id,
    interaction_token: interaction.token,
    application_id: interaction.applicationId,
    command_name: interaction.commandName,
    sub_command_name: opts.sub_command ?? null,
    sub_command_group: opts.sub_command_group ?? null,
    options: opts.options,
    guild_id: interaction.guildId,
    channel_id: interaction.channelId,
    user: {
      id: interaction.user.id,
      username: interaction.user.username,
      global_name: interaction.user.globalName,
    },
    member: interaction.member
      ? {
          permissions:
            interaction.memberPermissions?.bitfield.toString() ?? null,
          // Voice state — exposed to plugins that want to e.g.
          // auto-join the user's voice channel (radio plugin etc).
          // discord.js's GuildMember exposes .voice; other member
          // shapes (interaction member from API) don't, so guard.
          voice_channel_id:
            (
              interaction.member as unknown as {
                voice?: { channelId?: string | null };
              }
            ).voice?.channelId ?? null,
          capabilities: pluginCaps,
        }
      : null,
    locale: interaction.locale ?? null,
  };
  const body = JSON.stringify(payload);
  const headers = buildHeaders(dispatchKey, url, body);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), COMMAND_DISPATCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      botEventLog.record(
        "warn",
        "bot",
        `plugin-interaction: ${plugin.pluginKey}/${interaction.commandName} POST returned ${res.status}: ${text.slice(0, 200)}`,
        { pluginId: plugin.id },
      );
      // For modal commands, we deliberately do NOT call replyError
      // on POST failure — sending interaction.reply() here would
      // consume the only ack slot and race against the plugin's
      // (possibly still in-flight) interactions.send_modal call,
      // which would then 400 with "unknown interaction". Better to
      // let the interaction expire naturally so a slower-than-
      // expected plugin's sendModal can still hit Discord in time.
      // Operator log above is the canonical signal.
      if (!isModal) {
        await replyError(`⚠ Plugin 拒絕了此指令 (HTTP ${res.status})`);
      }
    }
    // We do NOT consume res body. Plugin completes the deferred
    // reply via RPC interactions.respond. Synchronous body action
    // would race the plugin's own RPC call.
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    botEventLog.record(
      "warn",
      "bot",
      `plugin-interaction: ${plugin.pluginKey}/${interaction.commandName} POST failed: ${msg}`,
      { pluginId: plugin.id },
    );
    // Same modal-race reasoning as the non-ok branch above.
    if (!isModal) {
      await replyError(`⚠ 無法連接 plugin: ${msg}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function dispatchAutocomplete(
  interaction: AutocompleteInteraction,
  plugin: PluginRow,
  manifest: PluginManifest,
): Promise<void> {
  const dispatchKey = plugin.dispatchHmacKey;
  if (!dispatchKey) {
    await interaction.respond([]).catch(() => {});
    return;
  }
  const url = resolveUrl(plugin, manifest, DEFAULT_AUTOCOMPLETE_PATH, {
    command_name: interaction.commandName,
  });
  if (!url) {
    await interaction.respond([]).catch(() => {});
    return;
  }

  const parsedAcUrl = new URL(url);
  const acPort = parsedAcUrl.port
    ? Number(parsedAcUrl.port)
    : parsedAcUrl.protocol === "https:"
      ? 443
      : 80;
  try {
    await assertPluginTarget(parsedAcUrl.hostname, acPort);
  } catch (err) {
    if (!(err instanceof HostPolicyError)) throw err;
    await interaction.respond([]).catch(() => {});
    return;
  }

  const focused = interaction.options.getFocused(true);
  // Subcommand + sibling-option context so the SDK's AutocompleteContext
  // matches what dispatchChatInputCommand sends. Without these, the SDK
  // sets subCommandName=undefined (not null per the type) and ctx.options
  // is empty — autocomplete handlers that filter by already-typed sibling
  // options can't access them.
  const subGroup = interaction.options.getSubcommandGroup(false) ?? null;
  const sub = interaction.options.getSubcommand(false) ?? null;
  const raw = (
    interaction.options as unknown as { _hoistedOptions?: OptionEntry[] }
  )._hoistedOptions;
  const payload = {
    interaction_id: interaction.id,
    command_name: interaction.commandName,
    sub_command_name: sub,
    sub_command_group: subGroup,
    options: raw ?? [],
    focused: { name: focused.name, value: focused.value, type: focused.type },
    guild_id: interaction.guildId,
    user: { id: interaction.user.id },
  };
  const body = JSON.stringify(payload);
  const headers = buildHeaders(dispatchKey, url, body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AUTOCOMPLETE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const data = (await res.json().catch(() => null)) as {
      choices?: Array<{ name: string; value: string | number }>;
    } | null;
    await interaction.respond(data?.choices ?? []).catch(() => {});
  } catch {
    await interaction.respond([]).catch(() => {});
  } finally {
    clearTimeout(timer);
  }
}

export async function dispatchInteractionToPlugin(
  interaction: Interaction,
): Promise<boolean> {
  // Only command + autocomplete for now; component/modal routing
  // (custom_id prefix) is a follow-up.
  if (interaction.isChatInputCommand() || interaction.isAutocomplete()) {
    const cmd: PluginCommandRow | null = await findPluginCommandByName(
      interaction.commandName,
      interaction.guildId,
    );
    if (!cmd) return false;
    const plugin = await findPluginById(cmd.pluginId);
    if (!plugin) return false;
    if (!plugin.enabled || plugin.status !== "active") {
      // Plugin's command still registered with Discord but the plugin
      // isn't accepting traffic right now. Reply ephemeral so the
      // user knows why nothing happened.
      if (interaction.isChatInputCommand()) {
        await interaction
          .reply({
            content: "⚠ 此指令所屬的 plugin 目前離線或已被停用。",
            ephemeral: true,
          })
          .catch(() => {});
      } else {
        await interaction.respond([]).catch(() => {});
      }
      return true;
    }
    const manifest = parseManifest(plugin);
    if (!manifest) {
      if (interaction.isChatInputCommand()) {
        await interaction
          .reply({
            content: "⚠ 此 plugin 的 manifest 損壞,無法派送指令。",
            ephemeral: true,
          })
          .catch(() => {});
      } else {
        await interaction.respond([]).catch(() => {});
      }
      return true;
    }
    if (interaction.isAutocomplete()) {
      await dispatchAutocomplete(interaction, plugin, manifest);
    } else {
      await dispatchChatInputCommand(interaction, plugin, manifest);
    }
    return true;
  }
  return false;
}
