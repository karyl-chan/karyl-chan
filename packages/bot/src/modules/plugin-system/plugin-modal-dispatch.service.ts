import type { ModalSubmitInteraction } from "discord.js";
import { findPluginByKey, type PluginRow } from "./models/plugin.model.js";
import { resolveUserCapabilities } from "../admin/authorized-user.service.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { recordPluginDeferReply } from "./plugin-defer-state.js";
import { pluginDispatcher } from "./plugin-dispatch.service.js";

/**
 * Inbound Discord *modal-submit* interaction → plugin dispatcher
 * (thin Dispatch Kind adapter over the Plugin Dispatch module).
 *
 * Symmetric to plugin-component-dispatch but for `MODAL_SUBMIT` events.
 * A plugin owns a modal by giving it a custom_id of the form
 *   `kc:<pluginKey>:<modalId>[:<tail>]`
 * On submit the bot:
 *   1. resolves the plugin
 *   2. `deferReply({ ephemeral: true })` — the modal-submit interaction
 *      MUST be acked within 3 s; we default to ephemeral so a crashing
 *      plugin doesn't leave a public "thinking…" message
 *   3. HMAC-signs and POSTs the submission to the plugin's modal endpoint
 *      (manifest `endpoints.plugin_modal`, default `/modals/{modal_id}`)
 *   4. plugin completes via `interactions.respond` (PATCHes the deferred
 *      reply), with the modal's submitted text-input values delivered
 *      in the request body as `components: [{ custom_id, value }]`.
 *
 * Returns: true when the custom_id was `kc:`-prefixed (claimed, even
 * on error — falling through after a deferReply would lead to a
 * duplicate ack); false when not a `kc:` token (so the dispatcher
 * falls through to in-process layers).
 */

interface ParsedModalId {
  pluginKey: string;
  modalId: string;
}

/**
 * Parse `kc:<pluginKey>:<modalId>[:<tail>]`. Returns null if not a
 * `kc:` token or the structure is malformed (so the dispatcher falls
 * through). The `tail` is forwarded to the plugin as part of the
 * `custom_id` field and is the plugin's responsibility to extract.
 */
function parsePluginModalId(customId: string): ParsedModalId | null {
  if (!customId.startsWith("kc:")) return null;
  const rest = customId.slice(3);
  const sep1 = rest.indexOf(":");
  if (sep1 === -1) return null;
  const pluginKey = rest.slice(0, sep1);
  if (!pluginKey || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(pluginKey)) return null;
  const after = rest.slice(sep1 + 1);
  const sep2 = after.indexOf(":");
  const modalId = sep2 === -1 ? after : after.slice(0, sep2);
  if (!modalId || !/^[a-z0-9][a-z0-9._-]*$/.test(modalId)) return null;
  return { pluginKey, modalId };
}

async function buildModalBody(
  interaction: ModalSubmitInteraction,
  plugin: PluginRow,
): Promise<string> {
  const allCaps = await resolveUserCapabilities(interaction.user.id);
  const pluginCaps = [...allCaps].filter(
    (c) => c === "admin" || c.startsWith(`plugin:${plugin.pluginKey}:`),
  );
  // Flatten the submitted text-input values from the modal's nested
  // structure (action rows → text inputs) into a flat list keyed by
  // each input's custom_id. discord.js's `fields.fields` collection
  // can contain Components V2 types (StringSelect, UserSelect,
  // CheckboxGroup, …) whose value shape differs (single .value vs
  // multi .values vs boolean[]). We only forward text inputs (type 4)
  // for now since the SDK contract is `Record<string, string>`.
  //
  // Future-bug guarded: if Discord ever delivers a Components V2
  // modal payload, the `if (f.type !== 4) continue` skip below means
  // the plugin silently sees the V2-component values missing from
  // its fields map. Before any Components V2 modal lands, extend
  // ModalPayload.components to {custom_id, value?, values?, checked?}
  // and update ModalContext.fields accordingly.
  const components: Array<{ custom_id: string; value: string }> = [];
  for (const f of interaction.fields.fields.values()) {
    if (f.type !== 4) continue; // ComponentType.TextInput
    const valueField = (f as unknown as { value: unknown }).value;
    components.push({
      custom_id: f.customId,
      value: typeof valueField === "string" ? valueField : "",
    });
  }

  return JSON.stringify({
    interaction_id: interaction.id,
    interaction_token: interaction.token,
    application_id: interaction.applicationId,
    custom_id: interaction.customId,
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
          capabilities: pluginCaps,
        }
      : null,
    components,
    locale: interaction.locale ?? null,
    guild_locale: interaction.guildLocale ?? null,
  });
}

export async function dispatchModalToPlugin(
  interaction: ModalSubmitInteraction,
): Promise<boolean> {
  const parsed = parsePluginModalId(interaction.customId);
  if (!parsed) return false;

  const plugin = await findPluginByKey(parsed.pluginKey);
  if (!plugin) {
    await interaction
      .reply({
        content: `⚠ 找不到 plugin \`${parsed.pluginKey}\`（modal 已失效）。`,
        ephemeral: true,
      })
      .catch(() => {});
    return true;
  }
  const gate = await pluginDispatcher.gate({
    kind: "modal",
    plugin,
    guildId: interaction.guildId,
  });
  if (!gate.ok) {
    const content = {
      plugin_offline: "⚠ 此 modal 所屬的 plugin 目前離線或已被停用。",
      manifest_invalid: "⚠ 此 plugin 的 manifest 損壞,無法派送。",
      // Feature Reach. Precedence Tiers resolution (row → operator default
      // → manifest enabled_by_default) so manifests defaulting features to
      // enabled aren't falsely blocked before any row is materialized.
      reach_denied: "⚠ 此功能在本伺服器已停用。",
      no_dispatch_key: "⚠ Plugin 尚未完成 re-register,dispatch key 不存在。",
    }[gate.reason];
    await interaction.reply({ content, ephemeral: true }).catch(() => {});
    return true;
  }

  // Modal submit requires an ack within 3s. deferReply ephemeral so a
  // crashing plugin doesn't leak a public "thinking…" message; the
  // plugin's interactions.respond will edit this reply (and can opt
  // back to non-ephemeral via flags if desired — though once we've
  // deferred ephemerally, Discord locks it ephemeral).
  try {
    await interaction.deferReply({ ephemeral: true });
    // Modals are always deferred ephemerally; the respond endpoint
    // uses this record to take the happy "PATCH @original" path when
    // the plugin handler's reply matches (default; modal replies are
    // typed ephemeral-only in the SDK).
    recordPluginDeferReply(interaction.token, true);
  } catch (err) {
    botEventLog.record(
      "warn",
      "bot",
      `plugin-modal: deferReply failed for ${plugin.pluginKey} (${interaction.customId}): ${err instanceof Error ? err.message : String(err)}`,
      { pluginId: plugin.id },
    );
    return true;
  }

  const outcome = await pluginDispatcher.deliver({
    kind: "modal",
    plugin,
    label: interaction.customId,
    endpointVars: { modal_id: parsed.modalId },
    payload: { body: () => buildModalBody(interaction, plugin) },
  });
  if (outcome.status !== "failed") return true;

  switch (outcome.reason) {
    case "unresolvable_endpoint":
      botEventLog.record(
        "warn",
        "bot",
        `plugin-modal: cannot resolve modal endpoint for ${plugin.pluginKey}`,
        { pluginId: plugin.id },
      );
      await interaction
        .editReply({ content: "⚠ 無法解析 plugin 的 modal 端點。" })
        .catch(() => {});
      break;
    case "preflight_denied":
      botEventLog.record(
        "warn",
        "bot",
        `plugin-modal: pre-flight host-policy rejected ${plugin.pluginKey}: ${outcome.detail}`,
        { pluginId: plugin.id },
      );
      await interaction
        .editReply({ content: `⚠ Plugin 端點不被允許: ${outcome.detail}` })
        .catch(() => {});
      break;
    case "http_error":
      botEventLog.record(
        "warn",
        "bot",
        `plugin-modal: ${plugin.pluginKey} (${interaction.customId}) POST returned ${outcome.httpStatus}: ${outcome.detail.slice(0, 200)}`,
        { pluginId: plugin.id },
      );
      await interaction
        .editReply({
          content: `⚠ Plugin 拒絕了此 modal (HTTP ${outcome.httpStatus})`,
        })
        .catch(() => {});
      break;
    default:
      botEventLog.record(
        "warn",
        "bot",
        `plugin-modal: ${plugin.pluginKey} (${interaction.customId}) POST failed: ${outcome.detail}`,
        { pluginId: plugin.id },
      );
      await interaction
        .editReply({ content: `⚠ 無法連接 plugin: ${outcome.detail}` })
        .catch(() => {});
  }
  return true;
}
