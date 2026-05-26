import { config } from "../../config.js";
import type { ModalSubmitInteraction } from "discord.js";
import { findPluginByKey, type PluginRow } from "./models/plugin.model.js";
import type { PluginManifest } from "./plugin-registry.service.js";
import { resolveUserCapabilities } from "../admin/authorized-user.service.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import {
  assertPluginTarget,
  HostPolicyError,
} from "../../utils/host-policy.js";
import { buildOutboundSignatureHeaders } from "../../utils/hmac.js";
import { findEnabledFeaturesByPluginGuild } from "../feature-toggle/models/plugin-guild-feature.model.js";

/**
 * Inbound Discord *modal-submit* interaction → plugin dispatcher.
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

const DEFAULT_MODAL_PATH = "/modals/{modal_id}";
const MODAL_DISPATCH_TIMEOUT_MS = config.plugin.commandDispatchTimeoutMs;

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

function resolveModalUrl(
  plugin: PluginRow,
  manifest: PluginManifest,
  modalId: string,
): string | null {
  const path = manifest.endpoints?.plugin_modal ?? DEFAULT_MODAL_PATH;
  // URL-encode the modal_id substitution — symmetric with the
  // command-name substitution in plugin-interaction-dispatch.
  const filled = path.split("{modal_id}").join(encodeURIComponent(modalId));
  try {
    return new URL(filled, plugin.url).toString();
  } catch {
    return null;
  }
}

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
  if (!plugin.enabled || plugin.status !== "active") {
    await interaction
      .reply({
        content: "⚠ 此 modal 所屬的 plugin 目前離線或已被停用。",
        ephemeral: true,
      })
      .catch(() => {});
    return true;
  }
  // Per-guild feature gate. After an admin disables every feature of
  // this plugin in guild G, modals from older messages must stop
  // dispatching — otherwise the plugin keeps receiving submissions
  // tagged with the very guild the operator just opted out of.
  if (interaction.guildId) {
    const enabled = await findEnabledFeaturesByPluginGuild(
      plugin.id,
      interaction.guildId,
    );
    if (enabled.length === 0) {
      await interaction
        .reply({
          content: "⚠ 此功能在本伺服器已停用。",
          ephemeral: true,
        })
        .catch(() => {});
      return true;
    }
  }
  const manifest = parseManifest(plugin);
  if (!manifest) {
    await interaction
      .reply({
        content: "⚠ 此 plugin 的 manifest 損壞,無法派送。",
        ephemeral: true,
      })
      .catch(() => {});
    return true;
  }
  const dispatchKey = plugin.dispatchHmacKey;
  if (!dispatchKey) {
    await interaction
      .reply({
        content: "⚠ Plugin 尚未完成 re-register,dispatch key 不存在。",
        ephemeral: true,
      })
      .catch(() => {});
    return true;
  }

  // Modal submit requires an ack within 3s. deferReply ephemeral so a
  // crashing plugin doesn't leak a public "thinking…" message; the
  // plugin's interactions.respond will edit this reply (and can opt
  // back to non-ephemeral via flags if desired — though once we've
  // deferred ephemerally, Discord locks it ephemeral).
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    botEventLog.record(
      "warn",
      "bot",
      `plugin-modal: deferReply failed for ${plugin.pluginKey} (${interaction.customId}): ${err instanceof Error ? err.message : String(err)}`,
      { pluginId: plugin.id },
    );
    return true;
  }

  const url = resolveModalUrl(plugin, manifest, parsed.modalId);
  if (!url) {
    botEventLog.record(
      "warn",
      "bot",
      `plugin-modal: cannot resolve modal endpoint for ${plugin.pluginKey}`,
      { pluginId: plugin.id },
    );
    await interaction
      .editReply({ content: "⚠ 無法解析 plugin 的 modal 端點。" })
      .catch(() => {});
    return true;
  }
  const parsedUrl = new URL(url);
  const port = parsedUrl.port
    ? Number(parsedUrl.port)
    : parsedUrl.protocol === "https:"
      ? 443
      : 80;
  try {
    await assertPluginTarget(parsedUrl.hostname, port);
  } catch (err) {
    if (!(err instanceof HostPolicyError)) throw err;
    botEventLog.record(
      "warn",
      "bot",
      `plugin-modal: pre-flight host-policy rejected ${plugin.pluginKey}: ${err.message}`,
      { pluginId: plugin.id },
    );
    await interaction
      .editReply({ content: `⚠ Plugin 端點不被允許: ${err.message}` })
      .catch(() => {});
    return true;
  }

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

  const payload = {
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
  };
  const body = JSON.stringify(payload);
  const headers = buildHeaders(dispatchKey, url, body);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODAL_DISPATCH_TIMEOUT_MS);
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
        `plugin-modal: ${plugin.pluginKey} (${interaction.customId}) POST returned ${res.status}: ${text.slice(0, 200)}`,
        { pluginId: plugin.id },
      );
      await interaction
        .editReply({ content: `⚠ Plugin 拒絕了此 modal (HTTP ${res.status})` })
        .catch(() => {});
    }
    // Body not consumed — plugin completes via interactions.respond.
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    botEventLog.record(
      "warn",
      "bot",
      `plugin-modal: ${plugin.pluginKey} (${interaction.customId}) POST failed: ${msg}`,
      { pluginId: plugin.id },
    );
    await interaction
      .editReply({ content: `⚠ 無法連接 plugin: ${msg}` })
      .catch(() => {});
  } finally {
    clearTimeout(timer);
  }
  return true;
}
