/**
 * Behavior Targets (ADR 0004): the directory behavior_targets is a new
 * table made by sync(); this fills it from what already exists, so every
 * target in use has a row before the admin UI lists them.
 *
 *   - every group a message trigger's audience or a DM allowlist names, and
 *     every group that still has a member list   → `group:<name>`
 *   - every user a bot DM trigger is for          → `user:<id>`
 *   - every guild / channel a message trigger is placed in, and every guild
 *     a command is registered to                  → `guild:<id>` / `channel:<g>:<c>`
 *
 * A group name on a trigger with whitespace at its ends is trimmed first:
 * the member routes always trimmed, so such a trigger could never have had
 * members, and a target's name is stored trimmed.
 *
 * The number of message triggers with "stop after a match" goes to
 * bot_events: the stop now ends only its own target's triggers (ADR 0004),
 * so those are the rows whose effect may have changed.
 *
 * Reads with SQL and builds the keys with the pure rules in
 * behavior-target.ts, so it is the same on SQLite and Postgres; it only
 * adds rows that are missing, so re-running adds nothing.
 *
 * Down drops the table. The build before this one deletes the member list
 * of a group no trigger uses on its next behavior write (#137) — lists
 * this build kept would go then; restoring them needs the DB snapshot.
 */

import type { MigrationFn } from "umzug";
import { QueryTypes, type QueryInterface } from "sequelize";
import { botEventLog } from "../modules/bot-events/bot-event-log.js";
import { behaviorSection } from "../modules/behavior/behavior-section.js";
import {
  isBuiltinTarget,
  messageTriggerTarget,
  targetFieldsOf,
  type MessageTriggerTargetSource,
} from "../modules/behavior/behavior-target.js";
import { parseContexts, parseIntegrationTypes } from "../utils/command-axes.js";

const TABLE = "behavior_targets";

async function hasTable(qi: QueryInterface, table: string): Promise<boolean> {
  try {
    await qi.describeTable(table);
    return true;
  } catch {
    return false;
  }
}

function select<T extends object>(qi: QueryInterface, sql: string): Promise<T[]> {
  return qi.sequelize.query<T>(sql, { type: QueryTypes.SELECT });
}

function parseNames(raw: unknown): string[] {
  try {
    const value = JSON.parse(String(raw)) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export const up: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  if (!(await hasTable(qi, TABLE))) return;
  if (!(await hasTable(qi, "behavior_definitions"))) return;

  // ── trim group names on triggers ──────────────────────────────────────────
  const named = await select<{ audienceGroupName: string }>(
    qi,
    `SELECT DISTINCT "audienceGroupName" FROM "behavior_definitions" WHERE "audienceGroupName" IS NOT NULL`,
  );
  const untrimmed = named.map((r) => r.audienceGroupName).filter((n) => n !== n.trim());
  for (const name of untrimmed) {
    await qi.sequelize.query(
      `UPDATE "behavior_definitions" SET "audienceGroupName" = :to WHERE "audienceGroupName" = :from`,
      { replacements: { from: name, to: name.trim() } },
    );
  }

  // ── the targets in use ────────────────────────────────────────────────────
  const keys = new Set<string>();

  const triggers = await select<MessageTriggerTargetSource>(
    qi,
    `SELECT "surface", "guildId", "channelId", "audienceKind", "audienceUserId", "audienceGroupName"
     FROM "behavior_definitions" WHERE "triggerKind" = 'message'`,
  );
  for (const t of triggers) {
    keys.add(
      messageTriggerTarget({
        surface: t.surface ?? null,
        guildId: t.guildId ?? null,
        channelId: t.channelId ?? null,
        audienceKind: t.audienceKind ?? "all",
        audienceUserId: t.audienceUserId ?? null,
        audienceGroupName: t.audienceGroupName ?? null,
      }),
    );
  }

  if (await hasTable(qi, "behavior_commands")) {
    const commands = await select<{
      registration: "global" | "guild";
      guildId: string | null;
      integrationTypes: string;
      contexts: string;
    }>(qi, `SELECT "registration", "guildId", "integrationTypes", "contexts" FROM "behavior_commands"`);
    for (const c of commands) {
      keys.add(
        behaviorSection({
          kind: "command",
          registration: c.registration,
          guildId: c.guildId ?? null,
          integrationTypes: parseIntegrationTypes(c.integrationTypes ?? ""),
          contexts: parseContexts(c.contexts ?? ""),
        }),
      );
    }
  }

  if (await hasTable(qi, "behavior_dm_allowlists")) {
    const lists = await select<{ groupNames: string }>(
      qi,
      `SELECT "groupNames" FROM "behavior_dm_allowlists"`,
    );
    for (const list of lists) {
      for (const name of parseNames(list.groupNames)) keys.add(`group:${name}`);
    }
  }

  if (await hasTable(qi, "behavior_group_members")) {
    const groups = await select<{ groupName: string }>(
      qi,
      `SELECT DISTINCT "groupName" FROM "behavior_group_members"`,
    );
    for (const g of groups) keys.add(`group:${g.groupName}`);
  }

  // ── add the missing rows ──────────────────────────────────────────────────
  const existing = new Set(
    (await select<{ key: string }>(qi, `SELECT "key" FROM "${TABLE}"`)).map((r) => r.key),
  );
  const missing = [...keys].filter((key) => !isBuiltinTarget(key) && !existing.has(key)).sort();
  if (missing.length > 0) {
    const now = new Date();
    await qi.bulkInsert(
      TABLE,
      missing.map((key) => ({ key, ...targetFieldsOf(key)!, createdAt: now, updatedAt: now })),
    );
  }

  const [{ count }] = await select<{ count: number | string }>(
    qi,
    `SELECT COUNT(*) AS "count" FROM "behavior_definitions"
     WHERE "triggerKind" = 'message' AND "stopOnMatch" = ${qi.sequelize.getDialect() === "postgres" ? "TRUE" : "1"}`,
  );

  botEventLog.record(
    "info",
    "bot",
    `migration 017: registered ${missing.length} behavior target(s); ${Number(count)} message trigger(s) stop after a match (now only within their own target)`,
    { registered: missing, trimmedGroupNames: untrimmed, stopOnMatch: Number(count) },
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  if (await hasTable(qi, TABLE)) await qi.dropTable(TABLE);
};
