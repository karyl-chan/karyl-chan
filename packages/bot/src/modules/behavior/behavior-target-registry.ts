/**
 * Which Behavior Targets are in use, and keeping the directory
 * (behavior_targets) complete: every target a behavior or a DM allowlist
 * refers to has a row, so the admin UI lists one kind of target — it never
 * has to tell "created" targets from ones that only exist because
 * something points at them.
 *
 * registerTargetsInUse runs at the end of every behavior write transaction
 * (behaviorTransaction), so no write path has to remember it: creating a
 * trigger for a user, registering a command in a guild, naming a group in
 * a DM allowlist — each leaves its target registered. It only ever adds
 * rows; removing a target is the admin's call (behavior-target-routes.ts),
 * and is refused while the target is in use.
 */

import { Op, type Transaction } from "sequelize";
import { parseContexts, parseIntegrationTypes } from "../../utils/command-axes.js";
import { behaviorSection } from "./behavior-section.js";
import {
  behaviorTargetKey,
  isBuiltinTarget,
  messageTriggerTarget,
  targetFieldsOf,
} from "./behavior-target.js";
import {
  BehaviorCommand,
  type BehaviorCommandRegistration,
} from "./models/behavior-command.model.js";
import {
  BehaviorDefinition,
  type BehaviorAudienceKind,
  type BehaviorMessageSurface,
} from "./models/behavior-definition.model.js";
import { dmAllowlistGroupRefs } from "./models/behavior-dm-allowlist.model.js";
import { BehaviorTarget } from "./models/behavior-target.model.js";

export interface BehaviorTargetUsage {
  /** target key → how many message triggers and commands belong to it */
  behaviors: Map<string, number>;
  /** group name → how many behaviors' DM allowlists name it */
  allowlistGroups: Map<string, number>;
}

export const groupTargetKey = (groupName: string): string =>
  behaviorTargetKey({ kind: "group", guildId: null, channelId: null, userId: null, groupName });

export async function loadBehaviorTargetUsage(
  transaction?: Transaction,
): Promise<BehaviorTargetUsage> {
  const [triggers, commands, allowlistGroups] = await Promise.all([
    BehaviorDefinition.findAll({
      attributes: ["surface", "guildId", "channelId", "audienceKind", "audienceUserId", "audienceGroupName"],
      where: { triggerKind: "message" },
      transaction,
    }),
    BehaviorCommand.findAll({
      attributes: ["registration", "guildId", "integrationTypes", "contexts"],
      transaction,
    }),
    dmAllowlistGroupRefs(transaction),
  ]);

  const behaviors = new Map<string, number>();
  const count = (key: string) => behaviors.set(key, (behaviors.get(key) ?? 0) + 1);
  for (const t of triggers) {
    const value = <T>(k: string): T => (t.getDataValue(k) as T | undefined) ?? (null as T);
    count(
      messageTriggerTarget({
        surface: value<BehaviorMessageSurface | null>("surface"),
        guildId: value<string | null>("guildId"),
        channelId: value<string | null>("channelId"),
        audienceKind: (t.getDataValue("audienceKind") as BehaviorAudienceKind | undefined) ?? "all",
        audienceUserId: value<string | null>("audienceUserId"),
        audienceGroupName: value<string | null>("audienceGroupName"),
      }),
    );
  }
  for (const c of commands) {
    count(
      behaviorSection({
        kind: "command",
        registration: c.getDataValue("registration") as BehaviorCommandRegistration,
        guildId: (c.getDataValue("guildId") as string | null) ?? null,
        integrationTypes: parseIntegrationTypes(c.getDataValue("integrationTypes") as string),
        contexts: parseContexts(c.getDataValue("contexts") as string),
      }),
    );
  }
  return { behaviors, allowlistGroups };
}

/** The keys of every created (non-built-in) target something refers to. */
export function targetKeysInUse(usage: BehaviorTargetUsage): string[] {
  const keys = new Set<string>([
    ...usage.behaviors.keys(),
    ...[...usage.allowlistGroups.keys()].map(groupTargetKey),
  ]);
  return [...keys].filter((key) => !isBuiltinTarget(key)).sort();
}

/** Add a row for every target in use that has none. */
export async function registerTargetsInUse(transaction: Transaction): Promise<void> {
  const wanted = targetKeysInUse(await loadBehaviorTargetUsage(transaction));
  if (wanted.length === 0) return;
  const existing = await BehaviorTarget.findAll({
    attributes: ["key"],
    where: { key: { [Op.in]: wanted } },
    transaction,
  });
  const have = new Set(existing.map((r) => r.getDataValue("key") as string));
  const missing = wanted.filter((key) => !have.has(key));
  if (missing.length === 0) return;
  await BehaviorTarget.bulkCreate(
    missing.map((key) => ({ key, ...targetFieldsOf(key)! })),
    { transaction, validate: true },
  );
}
