import { authedFetch, jsonOrThrow } from "./client";

// Mirrors packages/bot/src/modules/behavior/behavior-list-view.ts — the
// read-only shape of GET /api/behaviors (ADR 0003 trigger/action model).
// The server derives every item's `section`; the UI only groups by it.

/**
 * Where a behavior can be used (Behavior Section):
 *   `app` App 指令 · `bot_dm` 與 bot 的私訊 · `guild:all` 全部伺服器 ·
 *   `guild:<id>` 指定伺服器 · `channel:<guildId>:<channelId>` 指定頻道
 */
export type BehaviorSection =
  | "app"
  | "bot_dm"
  | "guild:all"
  | `guild:${string}`
  | `channel:${string}:${string}`;

export type BehaviorActionSource = "builtin" | "webhook";
export type BehaviorMessageSurface = "bot_dm" | "guild";
export type BehaviorPatternKind = "startswith" | "endswith" | "regex";
export type BehaviorAudienceKind = "all" | "user" | "group";
export type BehaviorWebhookAuthMode = "token" | "hmac";
export type DiscordContext = "Guild" | "BotDM" | "PrivateChannel";
export type DiscordIntegrationType = "guild_install" | "user_install";

export interface BehaviorStats {
  behaviorId: number;
  lastFiredAt: string | null;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface WebhookActionView {
  /** Decrypted URL; null when it can no longer be decrypted. */
  url: string | null;
  authMode: BehaviorWebhookAuthMode | null;
  /** The secret itself is never sent to the UI. */
  secretSet: boolean;
}

export interface BehaviorCommandOption {
  type:
    | "string"
    | "integer"
    | "number"
    | "boolean"
    | "user"
    | "channel"
    | "role"
    | "mentionable"
    | "attachment";
  name: string;
  description: string;
  required: boolean;
}

interface BehaviorViewBase {
  id: number;
  title: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
  systemKey: string | null;
  actionSource: BehaviorActionSource;
  webhook: WebhookActionView | null;
  stats: BehaviorStats | null;
}

export interface CommandLeafView extends BehaviorViewBase {
  subcommandGroup: string;
  /** '' = the root leaf (the command itself) */
  subcommand: string;
  leafDescription: string | null;
  options: BehaviorCommandOption[];
}

export interface CommandView {
  kind: "command";
  id: number;
  name: string;
  description: string;
  registration: "global" | "guild";
  guildId: string | null;
  integrationTypes: DiscordIntegrationType[];
  contexts: DiscordContext[];
  defaultMemberPermissions: string | null;
  isSystem: boolean;
  section: BehaviorSection;
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

export type BehaviorItemView = CommandView | MessageTriggerView;

export interface BehaviorListView {
  /** The System Behavior (login), pinned at the top of its section. */
  system: BehaviorItemView | null;
  commands: CommandView[];
  messageTriggers: MessageTriggerView[];
}

export async function listBehaviors(): Promise<BehaviorListView> {
  const r = await authedFetch("/api/behaviors");
  return jsonOrThrow<BehaviorListView>(r);
}
