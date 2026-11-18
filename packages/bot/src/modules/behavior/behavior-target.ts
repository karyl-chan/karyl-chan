/**
 * Behavior Target（作用對象，ADR 0004）：admin UI 的分組單位，也是「比對到
 * 就停」的範圍 —— 一個 behavior 屬於剛好一個對象。
 *
 * Target key：
 *   - `app`                         App 指令                  （內建）
 *   - `bot_dm`                      所有人與 bot 的私訊       （內建）
 *   - `guild:all`                   全部伺服器                （內建）
 *   - `guild:<guildId>`             指定伺服器
 *   - `channel:<guildId>:<chId>`    指定頻道
 *   - `user:<userId>`               特定使用者與 bot 的私訊
 *   - `group:<name>`                一個群組的成員與 bot 的私訊
 *
 * 前五個與 Behavior Section 的 key 相同：指令的對象就是它的分區
 * （behaviorSection），訊息觸發的對象是它的位置，只有與 bot 私訊、對象不是
 * 所有人的觸發改歸到 `user:` / `group:`。群組名稱是自由文字（可含 `:`），
 * 永遠在 key 的尾端，解析時先看 `group:` 前綴。
 *
 * 這是唯一的推導規則；前端拿 API 回傳的 `target` 直接分組。純函式。
 */

import type { BehaviorSection } from "./behavior-section.js";
import { messageTriggerLocation } from "./message-trigger-rules.js";
import type {
  BehaviorAudienceKind,
  BehaviorMessageSurface,
} from "./models/behavior-definition.model.js";

export type BehaviorTargetKey = BehaviorSection | `user:${string}` | `group:${string}`;

/** The targets the admin creates — the ones with a behavior_targets row. */
export type BehaviorTargetKind = "guild" | "channel" | "user" | "group";

/** What a created target is made of; the fields its kind does not use are null. */
export interface BehaviorTargetFields {
  kind: BehaviorTargetKind;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  groupName: string | null;
}

/** The three targets that always exist and have no row. */
export const BUILTIN_TARGETS = ["app", "bot_dm", "guild:all"] as const;
export type BuiltinTargetKey = (typeof BUILTIN_TARGETS)[number];

export function isBuiltinTarget(key: string): key is BuiltinTargetKey {
  return (BUILTIN_TARGETS as readonly string[]).includes(key);
}

export function behaviorTargetKey(target: BehaviorTargetFields): BehaviorTargetKey {
  switch (target.kind) {
    case "guild":
      return `guild:${target.guildId}`;
    case "channel":
      return `channel:${target.guildId}:${target.channelId}`;
    case "user":
      return `user:${target.userId}`;
    case "group":
      return `group:${target.groupName}`;
  }
}

/** A created target's fields from its key; null for a built-in one. */
export function targetFieldsOf(key: string): BehaviorTargetFields | null {
  if (isBuiltinTarget(key)) return null;
  const none = { guildId: null, channelId: null, userId: null, groupName: null };
  if (key.startsWith("group:")) {
    return { ...none, kind: "group", groupName: key.slice("group:".length) };
  }
  if (key.startsWith("user:")) {
    return { ...none, kind: "user", userId: key.slice("user:".length) };
  }
  if (key.startsWith("channel:")) {
    const [, guildId, channelId] = key.split(":");
    return { ...none, kind: "channel", guildId: guildId!, channelId: channelId! };
  }
  return { ...none, kind: "guild", guildId: key.slice("guild:".length) };
}

/** The fields of a message trigger its target is derived from. */
export interface MessageTriggerTargetSource {
  surface: BehaviorMessageSurface | null;
  guildId: string | null;
  channelId: string | null;
  audienceKind: BehaviorAudienceKind;
  audienceUserId: string | null;
  audienceGroupName: string | null;
}

export function messageTriggerTarget(row: MessageTriggerTargetSource): BehaviorTargetKey {
  const surface = row.surface ?? "bot_dm";
  if (surface === "bot_dm") {
    if (row.audienceKind === "user" && row.audienceUserId !== null) {
      return `user:${row.audienceUserId}`;
    }
    if (row.audienceKind === "group" && row.audienceGroupName !== null) {
      return `group:${row.audienceGroupName}`;
    }
    return "bot_dm";
  }
  return messageTriggerLocation({ surface, guildId: row.guildId, channelId: row.channelId });
}
