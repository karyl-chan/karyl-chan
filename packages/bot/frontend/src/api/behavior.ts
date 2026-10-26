import { authedFetch, jsonOrThrow } from "./client";

// Mirrors packages/bot/src/modules/behavior/behavior-list-view.ts — the
// shape of GET /api/behaviors (ADR 0003 trigger/action model) — and the
// write API (#136): behavior-write-routes.ts, behavior-command-routes.ts,
// message-trigger-reorder.ts, webhook-secret-rotate.ts. The server derives
// every item's `section`; the UI only groups by it.
//
// Refusals arrive as ApiError with `code` (validation_failed,
// name_conflict, system_immutable, registration_failed, not_found,
// invalid_tree) and, when the server names one, the offending `field`.

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
  /** After a rotation: until when the replaced secret still verifies (ISO). */
  previousSecretExpiresAt: string | null;
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
  /** ISO time of the last write; send back as `ifUpdatedAt` to refuse a stale edit. */
  updatedAt: string;
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
  /** ISO time of the last write to the command row. */
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

// ── write API (#136) ────────────────────────────────────────────────────────

/** How a command write reached Discord. */
export type RegistrationReport =
  | { status: "registered"; targets: unknown[] }
  | { status: "removed" }
  | { status: "deferred"; reason: string };

export interface WebhookInput {
  url: string;
  /** Turning auth on makes the server generate a secret, returned once. */
  authMode?: BehaviorWebhookAuthMode | null;
}

export interface MessageTriggerInput {
  title: string;
  description?: string;
  enabled?: boolean;
  surface: BehaviorMessageSurface;
  guildId?: string | null;
  channelId?: string | null;
  patternKind: BehaviorPatternKind;
  patternValue: string;
  stopOnMatch?: boolean;
  ignoreBots?: boolean;
  audienceKind?: BehaviorAudienceKind;
  audienceUserId?: string | null;
  audienceGroupName?: string | null;
  webhook: WebhookInput;
}

export interface CommandOptionInput {
  type: BehaviorCommandOption["type"];
  name: string;
  description: string;
  required?: boolean;
}

export interface CommandLeafInput {
  /** '' (default) = the root leaf */
  subcommand?: string;
  title: string;
  description?: string;
  enabled?: boolean;
  leafDescription?: string | null;
  options?: CommandOptionInput[];
  webhook: WebhookInput;
}

export interface CommandInput {
  name: string;
  description: string;
  registration: "global" | "guild";
  guildId?: string | null;
  integrationTypes?: DiscordIntegrationType[];
  contexts?: DiscordContext[];
  defaultMemberPermissions?: string | null;
}

/** PATCH /api/behaviors/:id — a message trigger's or a leaf's own fields. */
export type BehaviorPatch = Partial<Omit<MessageTriggerInput, "webhook">> &
  Partial<Omit<CommandLeafInput, "webhook">> & {
    webhook?: WebhookInput;
    ifUpdatedAt?: string;
  };

export type CommandPatch = Partial<CommandInput> & { ifUpdatedAt?: string };

/**
 * A Message Trigger Location — where a message trigger is set: `bot_dm`,
 * `guild:all`, `guild:<id>`, `channel:<guildId>:<channelId>`. The unit
 * triggers are ordered in (same keys as a trigger's section).
 */
export type MessageTriggerLocation = Exclude<BehaviorSection, "app">;

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return authedFetch(path, {
    method,
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}

export async function createMessageTrigger(
  input: MessageTriggerInput,
): Promise<{ behavior: MessageTriggerView; secret?: string }> {
  return jsonOrThrow(await send("POST", "/api/behaviors", input));
}

export async function updateBehavior(
  id: number,
  patch: BehaviorPatch,
): Promise<{
  behavior: MessageTriggerView | CommandLeafView;
  command?: CommandView;
  registration?: RegistrationReport;
  secret?: string;
}> {
  return jsonOrThrow(await send("PATCH", `/api/behaviors/${id}`, patch));
}

/** Deleting a leaf re-registers its command (`registration`); a message trigger answers 204. */
export async function deleteBehavior(
  id: number,
): Promise<{ registration?: RegistrationReport }> {
  const response = await send("DELETE", `/api/behaviors/${id}`);
  if (response.status === 204) return {};
  return jsonOrThrow(response);
}

/** `ids` must be exactly the location's current (non-system) triggers. */
export async function reorderMessageTriggers(
  location: MessageTriggerLocation,
  ids: number[],
): Promise<{ location: string; ids: number[] }> {
  return jsonOrThrow(await send("PUT", "/api/behaviors/reorder", { location, ids }));
}

export async function rotateWebhookSecret(
  id: number,
): Promise<{ secret: string; previousSecretExpiresAt: string }> {
  return jsonOrThrow(await send("POST", `/api/behaviors/${id}/webhook-secret/rotate`));
}

export interface TestFireResult {
  ok: boolean;
  relayContent: string;
  relayEmbeds: unknown[];
  error: string | null;
  errorCode: string | null;
}

export async function testBehavior(id: number): Promise<TestFireResult> {
  return jsonOrThrow(await send("POST", `/api/behaviors/${id}/test`));
}

export async function createBehaviorCommand(
  input: CommandInput & { leaves: CommandLeafInput[] },
): Promise<{
  command: CommandView;
  registration: RegistrationReport;
  secrets?: Array<{ behaviorId: number; subcommand: string; secret: string }>;
}> {
  return jsonOrThrow(await send("POST", "/api/behavior-commands", input));
}

export async function updateBehaviorCommand(
  id: number,
  patch: CommandPatch,
): Promise<{ command: CommandView; registration: RegistrationReport }> {
  return jsonOrThrow(await send("PATCH", `/api/behavior-commands/${id}`, patch));
}

export async function deleteBehaviorCommand(
  id: number,
): Promise<{ registration: RegistrationReport }> {
  return jsonOrThrow(await send("DELETE", `/api/behavior-commands/${id}`));
}

export async function resyncBehaviorCommand(
  id: number,
): Promise<{ command: CommandView; registration: RegistrationReport }> {
  return jsonOrThrow(await send("POST", `/api/behavior-commands/${id}/resync`));
}

export async function addCommandLeaf(
  commandId: number,
  leaf: CommandLeafInput & { subcommand: string },
): Promise<{
  behavior: CommandLeafView;
  command: CommandView;
  registration: RegistrationReport;
  secret?: string;
}> {
  return jsonOrThrow(await send("POST", `/api/behavior-commands/${commandId}/leaves`, leaf));
}

export async function convertToSubcommands(
  commandId: number,
  input: { subcommand: string; leafDescription?: string | null },
): Promise<{ command: CommandView; registration: RegistrationReport }> {
  return jsonOrThrow(
    await send("POST", `/api/behavior-commands/${commandId}/convert-to-subcommands`, input),
  );
}

export async function getGroupMembers(
  groupName: string,
): Promise<{ groupName: string; members: string[] }> {
  return jsonOrThrow(
    await send("GET", `/api/behavior-groups/${encodeURIComponent(groupName)}/members`),
  );
}

export async function replaceGroupMembers(
  groupName: string,
  userIds: string[],
): Promise<{ groupName: string; members: string[] }> {
  return jsonOrThrow(
    await send("PUT", `/api/behavior-groups/${encodeURIComponent(groupName)}/members`, {
      userIds,
    }),
  );
}
