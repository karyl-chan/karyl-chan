/**
 * GET /api/behaviors 的回應形狀：BehaviorCatalog → admin UI 的唯讀視圖。
 *
 *   { system, services, commands, messageTriggers }
 *
 * 每一項帶推導出的 Behavior Section（behaviorSection，唯一的推導規則）。
 * System Behavior 從所屬清單抽出放在 `system`，UI 把它釘在所屬分區最上方；
 * Service Behavior（#126）同樣抽出放在 `services`（一個訊息觸發或它的
 * 指令，帶它的服務），UI 在所屬分區的「服務」群組列出。
 * webhook 密鑰只回報是否已設定（secretSet），從不回傳明文；網址是 operator
 * 設定，解密後回傳。前端在 frontend/src/api/behavior.ts 鏡像這些型別。
 */

import { decryptSecret } from "../../utils/crypto.js";
import type {
  DiscordContext,
  DiscordIntegrationType,
} from "../command-system/types.js";
import { behaviorSection, type BehaviorSection } from "./behavior-section.js";
import type {
  BehaviorCatalog,
  CatalogBehavior,
  CatalogCommand,
  FixedRowEntry,
} from "./behavior-catalog.js";
import { parseContexts, parseIntegrationTypes } from "../../utils/command-axes.js";
import {
  leafPathOf,
  parseLeafOptions,
  type BehaviorCommandOption,
  type BehaviorActionSource,
  type BehaviorAudienceKind,
  type BehaviorMessageSurface,
  type BehaviorPatternKind,
  type BehaviorSystemKey,
  type ReplyVisibility,
  isServiceBehavior,
} from "./models/behavior-definition.model.js";
import type { BehaviorCommandRegistration } from "./models/behavior-command.model.js";
import type { BehaviorWebhookAuthMode } from "./models/behavior-webhook-action.model.js";
import type { BehaviorStatRow } from "./models/behavior-stats.model.js";

export interface WebhookActionView {
  /** 解密後的網址；解不開（金鑰已輪替掉等）時為 null */
  url: string | null;
  authMode: BehaviorWebhookAuthMode | null;
  secretSet: boolean;
  /** 輪換後舊密鑰仍有效到何時（ISO）；不在寬限期內為 null */
  previousSecretExpiresAt: string | null;
}

interface BehaviorViewBase {
  id: number;
  title: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
  systemKey: BehaviorSystemKey | null;
  actionSource: BehaviorActionSource;
  webhook: WebhookActionView | null;
  stats: BehaviorStatRow | null;
  /** who the reply is for when the response does not say; null = the trigger's default */
  replyVisibility: ReplyVisibility | null;
  /** ISO time of the last write; send it back as `ifUpdatedAt` to refuse a stale edit */
  updatedAt: string;
}

export interface CommandLeafView extends BehaviorViewBase {
  subcommandGroup: string;
  /** '' = 根葉節點 */
  subcommand: string;
  leafDescription: string | null;
  options: BehaviorCommandOption[];
}

export interface CommandView {
  kind: "command";
  id: number;
  name: string;
  description: string;
  registration: BehaviorCommandRegistration;
  guildId: string | null;
  integrationTypes: DiscordIntegrationType[];
  contexts: DiscordContext[];
  defaultMemberPermissions: string | null;
  isSystem: boolean;
  section: BehaviorSection;
  /** ISO time of the last write to the command row */
  updatedAt: string;
  leaves: CommandLeafView[];
}

export interface MessageTriggerView extends BehaviorViewBase {
  kind: "message";
  surface: BehaviorMessageSurface;
  guildId: string | null;
  channelId: string | null;
  patternKind: BehaviorPatternKind;
  patternValue: string;
  stopOnMatch: boolean;
  ignoreBots: boolean;
  audienceKind: BehaviorAudienceKind;
  audienceUserId: string | null;
  audienceGroupName: string | null;
  section: BehaviorSection;
}

/** What a Service Behavior shows of its service. */
export interface ServiceSummaryView {
  id: number;
  name: string;
  audience: string;
  redirectUrl: string;
}

/**
 * A Service Behavior: a bot DM message trigger, or the command whose root
 * leaf it is, with the service whose login it runs.
 */
export type ServiceBehaviorView = (CommandView | MessageTriggerView) & {
  service: ServiceSummaryView;
};

export interface BehaviorListView {
  system: CommandView | MessageTriggerView | null;
  services: ServiceBehaviorView[];
  commands: CommandView[];
  messageTriggers: MessageTriggerView[];
}

function webhookView(behavior: CatalogBehavior): WebhookActionView | null {
  const action = behavior.webhook;
  if (!action) return null;
  let url: string | null;
  try {
    url = decryptSecret(action.url);
  } catch {
    url = null;
  }
  const graceEnd = action.previousSecretExpiresAt;
  return {
    url,
    authMode: action.authMode,
    secretSet: action.secret !== null,
    previousSecretExpiresAt:
      action.previousSecret !== null && graceEnd !== null && graceEnd.getTime() > Date.now()
        ? graceEnd.toISOString()
        : null,
  };
}


function baseView(
  b: CatalogBehavior,
  stats: ReadonlyMap<number, BehaviorStatRow>,
): BehaviorViewBase {
  return {
    id: b.id,
    title: b.title,
    description: b.description,
    enabled: b.enabled,
    sortOrder: b.sortOrder,
    systemKey: b.systemKey,
    actionSource: b.actionSource,
    webhook: webhookView(b),
    stats: stats.get(b.id) ?? null,
    replyVisibility: b.replyVisibility,
    updatedAt: b.updatedAt.toISOString(),
  };
}

export function commandView(
  c: CatalogCommand,
  stats: ReadonlyMap<number, BehaviorStatRow>,
): CommandView {
  const integrationTypes = parseIntegrationTypes(c.integrationTypes);
  const contexts = parseContexts(c.contexts);
  return {
    kind: "command",
    id: c.id,
    name: c.name,
    description: c.description,
    registration: c.registration,
    guildId: c.guildId,
    integrationTypes,
    contexts,
    defaultMemberPermissions: c.defaultMemberPermissions,
    isSystem: c.isSystem,
    section: behaviorSection({
      kind: "command",
      registration: c.registration,
      guildId: c.guildId,
      integrationTypes,
      contexts,
    }),
    updatedAt: c.updatedAt.toISOString(),
    leaves: c.leaves.map((leaf) => ({
      ...baseView(leaf, stats),
      ...leafPathOf(leaf),
      leafDescription: leaf.leafDescription,
      options: parseLeafOptions(leaf.options) ?? [],
    })),
  };
}

export function messageTriggerView(
  b: CatalogBehavior,
  stats: ReadonlyMap<number, BehaviorStatRow>,
): MessageTriggerView {
  const surface = b.surface ?? "bot_dm";
  return {
    ...baseView(b, stats),
    kind: "message",
    surface,
    guildId: b.guildId,
    channelId: b.channelId,
    patternKind: b.patternKind ?? "startswith",
    patternValue: b.patternValue ?? "",
    stopOnMatch: b.stopOnMatch,
    ignoreBots: b.ignoreBots,
    audienceKind: b.audienceKind,
    audienceUserId: b.audienceUserId,
    audienceGroupName: b.audienceGroupName,
    section: behaviorSection({
      kind: "message",
      surface,
      guildId: b.guildId,
      channelId: b.channelId,
    }),
  };
}

/** A Service Behavior's view; null for a row without its service (cannot happen: they go together). */
export function serviceBehaviorView(
  { row, command }: FixedRowEntry,
  stats: ReadonlyMap<number, BehaviorStatRow>,
): ServiceBehaviorView | null {
  if (!row.service) return null;
  const { id, name, audience, redirectUrl } = row.service;
  const view = command ? commandView(command, stats) : messageTriggerView(row, stats);
  return { ...view, service: { id, name, audience, redirectUrl } };
}

export function buildBehaviorListView(
  catalog: BehaviorCatalog,
  stats: ReadonlyMap<number, BehaviorStatRow>,
): BehaviorListView {
  let system: CommandView | MessageTriggerView | null = null;
  const services: ServiceBehaviorView[] = [];
  const addService = (entry: FixedRowEntry) => {
    const view = serviceBehaviorView(entry, stats);
    if (view) services.push(view);
  };
  const commands: CommandView[] = [];
  for (const c of catalog.commands) {
    const serviceRow = c.leaves.find(isServiceBehavior);
    if (serviceRow) {
      addService({ row: serviceRow, command: c });
      continue;
    }
    const view = commandView(c, stats);
    if (c.leaves.some((l) => l.systemKey !== null)) system = view;
    else commands.push(view);
  }
  const messageTriggers: MessageTriggerView[] = [];
  for (const t of catalog.messageTriggers) {
    if (isServiceBehavior(t)) {
      addService({ row: t, command: null });
      continue;
    }
    const view = messageTriggerView(t, stats);
    if (t.systemKey !== null) system = view;
    else messageTriggers.push(view);
  }
  services.sort((a, b) => a.service.id - b.service.id);
  return { system, services, commands, messageTriggers };
}
