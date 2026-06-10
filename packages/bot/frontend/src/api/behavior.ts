import { authedFetch, jsonOrThrow } from "./client";

// ── 列舉型別 ────────────────────────────────────────────────────────────────

export type BehaviorSource = "custom" | "system";
export type BehaviorTriggerType = "slash_command" | "message_pattern";
export type BehaviorMessagePatternKind = "startswith" | "endswith" | "regex";
export type BehaviorForwardType = "one_time" | "continuous";
export type BehaviorScope = "global" | "guild";
export type BehaviorAudienceKind = "all" | "user" | "group";
export type BehaviorWebhookAuthMode = "token" | "hmac";

export type ScopeTabType =
  | "global_all"
  | "all_dms"
  | "all_bot_dms"
  | "all_guilds"
  | "specific_guild"
  | "specific_channel"
  | "specific_user"
  | "specific_group";

// ── BehaviorRow ─────────────────────────────────────────────────────────────

export interface BehaviorRow {
  id: number;
  title: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
  stopOnMatch: boolean;
  ignoreBots: boolean;
  sessionExpireHours: number | null;
  forwardType: BehaviorForwardType;
  source: BehaviorSource;
  triggerType: BehaviorTriggerType;
  messagePatternKind: BehaviorMessagePatternKind | null;
  messagePatternValue: string | null;
  slashCommandName: string | null;
  slashCommandDescription: string | null;
  /** JSON 字串（BehaviorCommandOption[]）；null = 無參數 */
  slashCommandOptions: string | null;
  scope: BehaviorScope;
  integrationTypes: string;
  contexts: string;
  placementGuildId: string | null;
  placementChannelId: string | null;
  audienceKind: BehaviorAudienceKind;
  audienceUserId: string | null;
  audienceGroupName: string | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
  webhookAuthMode: BehaviorWebhookAuthMode | null;
  systemKey: string | null;
  scopeTabId: number;
  /** BH-6.1 forward 統計（list 回應附帶；無紀錄為 null） */
  stats?: BehaviorStats | null;
}

export interface BehaviorStats {
  behaviorId: number;
  lastFiredAt: string | null;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

// ── Scope Tab（sidebar 用）─────────────────────────────────────────────────

export interface ScopeTabRow {
  id: number;
  tabType: ScopeTabType;
  label: string;
  isFixed: boolean;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  groupName: string | null;
  sortOrder: number;
  scopeKey: string;
  behaviorCount: number;
}

// ── Create / Patch payload ──────────────────────────────────────────────────

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

export interface BehaviorCreatePayload {
  title: string;
  description?: string;
  triggerType: BehaviorTriggerType;
  messagePatternKind?: BehaviorMessagePatternKind;
  messagePatternValue?: string;
  slashCommandName?: string;
  slashCommandDescription?: string;
  slashCommandOptions?: BehaviorCommandOption[];
  scope?: BehaviorScope;
  integrationTypes?: string;
  contexts?: string;
  audienceKind?: BehaviorAudienceKind;
  audienceUserId?: string;
  audienceGroupName?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookAuthMode?: BehaviorWebhookAuthMode;
  forwardType?: BehaviorForwardType;
  stopOnMatch?: boolean;
  ignoreBots?: boolean;
  enabled?: boolean;
  scopeTabId?: number;
}

export interface BehaviorPatchPayload {
  title?: string;
  description?: string;
  triggerType?: BehaviorTriggerType;
  messagePatternKind?: BehaviorMessagePatternKind | null;
  messagePatternValue?: string | null;
  slashCommandName?: string | null;
  slashCommandDescription?: string | null;
  slashCommandOptions?: BehaviorCommandOption[] | null;
  scope?: BehaviorScope;
  integrationTypes?: string;
  contexts?: string;
  audienceKind?: BehaviorAudienceKind;
  audienceUserId?: string | null;
  audienceGroupName?: string | null;
  enabled?: boolean;
  forwardType?: BehaviorForwardType;
  stopOnMatch?: boolean;
  ignoreBots?: boolean;
  sessionExpireHours?: number | null;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  webhookAuthMode?: BehaviorWebhookAuthMode | null;
}

// ── Behaviors API ───────────────────────────────────────────────────────────

export async function listBehaviors(params?: {
  scopeTabId?: number;
  audienceKind?: BehaviorAudienceKind;
  audienceUserId?: string;
  audienceGroupName?: string;
  source?: BehaviorSource;
  triggerType?: BehaviorTriggerType;
}): Promise<BehaviorRow[]> {
  const qs = new URLSearchParams();
  if (params?.scopeTabId != null)
    qs.set("scopeTabId", String(params.scopeTabId));
  if (params?.audienceKind) qs.set("audienceKind", params.audienceKind);
  if (params?.audienceUserId) qs.set("audienceUserId", params.audienceUserId);
  if (params?.audienceGroupName)
    qs.set("audienceGroupName", params.audienceGroupName);
  if (params?.source) qs.set("source", params.source);
  if (params?.triggerType) qs.set("triggerType", params.triggerType);
  const url = `/api/behaviors${qs.toString() ? "?" + qs.toString() : ""}`;
  const r = await authedFetch(url);
  const body = await jsonOrThrow<{ behaviors: BehaviorRow[] }>(r);
  return body.behaviors;
}

export async function getBehavior(id: number): Promise<BehaviorRow> {
  const r = await authedFetch(`/api/behaviors/${id}`);
  const body = await jsonOrThrow<{ behavior: BehaviorRow }>(r);
  return body.behavior;
}

export async function createBehavior(
  payload: BehaviorCreatePayload,
): Promise<BehaviorRow> {
  const r = await authedFetch("/api/behaviors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await jsonOrThrow<{ behavior: BehaviorRow }>(r);
  return body.behavior;
}

export async function updateBehavior(
  id: number,
  patch: BehaviorPatchPayload,
): Promise<BehaviorRow> {
  const r = await authedFetch(`/api/behaviors/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = await jsonOrThrow<{ behavior: BehaviorRow }>(r);
  return body.behavior;
}

export async function deleteBehavior(id: number): Promise<void> {
  const r = await authedFetch(`/api/behaviors/${id}`, { method: "DELETE" });
  if (r.status === 204) return;
  await jsonOrThrow<unknown>(r);
}

export async function resyncBehavior(id: number): Promise<{ result: unknown }> {
  const r = await authedFetch(`/api/behaviors/${id}/resync`, {
    method: "POST",
  });
  return jsonOrThrow<{ result: unknown }>(r);
}

export async function reorderBehaviors(orderedIds: number[]): Promise<void> {
  const r = await authedFetch("/api/behaviors/reorder", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderedIds }),
  });
  await jsonOrThrow<unknown>(r);
}

// ── Test-fire / sessions（BH-6.2 / BH-4.1）──────────────────────────────────

export interface BehaviorTestResult {
  ok: boolean;
  relayContent: string;
  relayEmbeds: unknown[];
  ended: boolean;
  error: string | null;
}

export async function testBehavior(id: number): Promise<BehaviorTestResult> {
  const r = await authedFetch(`/api/behaviors/${id}/test`, { method: "POST" });
  return jsonOrThrow<BehaviorTestResult>(r);
}

export interface BehaviorSessionView {
  userId: string;
  channelId: string;
  behaviorId: number;
  behaviorTitle: string;
  startedAt: string;
  expiresAt: string | null;
}

export async function listBehaviorSessions(): Promise<BehaviorSessionView[]> {
  const r = await authedFetch("/api/behavior-sessions");
  const body = await jsonOrThrow<{ sessions: BehaviorSessionView[] }>(r);
  return body.sessions;
}

export async function endBehaviorSession(
  userId: string,
  channelId: string,
): Promise<void> {
  const r = await authedFetch(
    `/api/behavior-sessions/${encodeURIComponent(userId)}/${encodeURIComponent(channelId)}`,
    { method: "DELETE" },
  );
  await jsonOrThrow<unknown>(r);
}

// ── Audience group members API（BH-1）───────────────────────────────────────
// group 以名字為單位，同名 group 的 behaviors 共享名單。

export async function getGroupMembers(groupName: string): Promise<string[]> {
  const r = await authedFetch(
    `/api/behavior-groups/${encodeURIComponent(groupName)}/members`,
  );
  const body = await jsonOrThrow<{ members: string[] }>(r);
  return body.members;
}

export async function setGroupMembers(
  groupName: string,
  userIds: string[],
): Promise<string[]> {
  const r = await authedFetch(
    `/api/behavior-groups/${encodeURIComponent(groupName)}/members`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds }),
    },
  );
  const body = await jsonOrThrow<{ members: string[] }>(r);
  return body.members;
}

// ── Scope Tab API ───────────────────────────────────────────────────────────

export async function listScopeTabs(): Promise<ScopeTabRow[]> {
  const r = await authedFetch("/api/behavior-tabs");
  const body = await jsonOrThrow<{ tabs: ScopeTabRow[] }>(r);
  return body.tabs;
}

export async function createScopeTab(payload: {
  tabType: ScopeTabType;
  label?: string;
  guildId?: string;
  channelId?: string;
  userId?: string;
  groupName?: string;
}): Promise<ScopeTabRow> {
  const r = await authedFetch("/api/behavior-tabs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await jsonOrThrow<{ tab: ScopeTabRow }>(r);
  return body.tab;
}

export async function updateScopeTab(
  id: number,
  patch: { label?: string; sortOrder?: number },
): Promise<ScopeTabRow> {
  const r = await authedFetch(`/api/behavior-tabs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = await jsonOrThrow<{ tab: ScopeTabRow }>(r);
  return body.tab;
}

export async function deleteScopeTab(id: number): Promise<{ deleted: number }> {
  const r = await authedFetch(`/api/behavior-tabs/${id}`, {
    method: "DELETE",
  });
  return jsonOrThrow<{ deleted: number }>(r);
}
