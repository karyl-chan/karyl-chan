/**
 * The Behavior Targets as the admin UI lists them (GET /api/behaviors →
 * `targets`): the three built-in ones, then every row of the directory.
 * Each carries what it is made of, so the UI never parses a key.
 *
 * Order — the sidebar's and the target select's:
 *   App 指令, 所有人與 bot 的私訊, 全部伺服器;
 *   each guild followed by its channels (a channel whose guild is not a
 *   target sorts where that guild would be);
 *   groups by name; users by id.
 */

import type { BehaviorCatalog } from "./behavior-catalog.js";
import { isServiceBehavior } from "./models/behavior-definition.model.js";
import type { BehaviorTargetRow } from "./models/behavior-target.model.js";
import { BUILTIN_TARGETS, type BuiltinTargetKey } from "./behavior-target.js";

export type BehaviorTargetViewKind =
  | "app"
  | "bot_dm"
  | "guild_all"
  | "guild"
  | "channel"
  | "user"
  | "group";

export interface BehaviorTargetView {
  key: string;
  /** The directory row's id (DELETE /api/behavior-targets/:id); null for a built-in target. */
  id: number | null;
  kind: BehaviorTargetViewKind;
  /** Always there, cannot be deleted. */
  builtin: boolean;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  groupName: string | null;
  /** A group's member count; null for the other kinds. */
  memberCount: number | null;
  /** A group a Service Behavior's trigger uses: only an owner sets its members (#126). */
  ownerOnly: boolean;
  /** A group: how many behaviors' DM allowlists name it (it cannot be deleted while any does). */
  allowlistRefs: number;
}

const BUILTIN_KIND: Record<BuiltinTargetKey, BehaviorTargetViewKind> = {
  app: "app",
  bot_dm: "bot_dm",
  "guild:all": "guild_all",
};

const NONE = {
  guildId: null,
  channelId: null,
  userId: null,
  groupName: null,
  memberCount: null,
  ownerOnly: false,
  allowlistRefs: 0,
} as const;

/** The groups a Service Behavior's message trigger uses. */
function serviceGroupsOf(catalog: BehaviorCatalog): Set<string> {
  const names = new Set<string>();
  for (const t of catalog.messageTriggers) {
    if (isServiceBehavior(t) && t.audienceGroupName !== null) names.add(t.audienceGroupName);
  }
  return names;
}

export function behaviorTargetView(
  row: BehaviorTargetRow,
  catalog: BehaviorCatalog,
  allowlistGroups: ReadonlyMap<string, number>,
  serviceGroups: ReadonlySet<string> = serviceGroupsOf(catalog),
): BehaviorTargetView {
  const group = row.kind === "group" ? row.groupName : null;
  return {
    key: row.key,
    id: row.id,
    kind: row.kind,
    builtin: false,
    guildId: row.guildId,
    channelId: row.channelId,
    userId: row.userId,
    groupName: row.groupName,
    memberCount: group !== null ? (catalog.groupMembers.get(group)?.size ?? 0) : null,
    ownerOnly: group !== null && serviceGroups.has(group),
    allowlistRefs: group !== null ? (allowlistGroups.get(group) ?? 0) : 0,
  };
}

const KIND_ORDER: Record<BehaviorTargetRow["kind"], number> = {
  guild: 0,
  channel: 0,
  group: 1,
  user: 2,
};

function compareRows(a: BehaviorTargetRow, b: BehaviorTargetRow): number {
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (byKind !== 0) return byKind;
  if (a.kind === "group") return (a.groupName ?? "").localeCompare(b.groupName ?? "");
  if (a.kind === "user") return (a.userId ?? "").localeCompare(b.userId ?? "");
  // guilds and channels: by guild, the guild itself before its channels
  return (
    (a.guildId ?? "").localeCompare(b.guildId ?? "") ||
    (a.channelId ?? "").localeCompare(b.channelId ?? "")
  );
}

export function behaviorTargetViews(
  rows: readonly BehaviorTargetRow[],
  catalog: BehaviorCatalog,
  allowlistGroups: ReadonlyMap<string, number>,
): BehaviorTargetView[] {
  const serviceGroups = serviceGroupsOf(catalog);
  return [
    ...BUILTIN_TARGETS.map((key) => ({
      ...NONE,
      key,
      id: null,
      kind: BUILTIN_KIND[key],
      builtin: true,
    })),
    ...[...rows]
      .sort(compareRows)
      .map((row) => behaviorTargetView(row, catalog, allowlistGroups, serviceGroups)),
  ];
}
