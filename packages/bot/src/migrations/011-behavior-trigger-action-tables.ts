/**
 * ADR 0003: move behaviors to the trigger/action tables.
 *
 *   behaviors + behavior_scope_tabs  →  behavior_commands
 *                                       behavior_definitions
 *                                       behavior_webhook_actions
 *
 * The new tables are created by `sync()` (it runs before migrations and
 * only creates missing tables); their indexes are created here, on fresh
 * and upgraded DBs alike, because `sync()` would add a model's missing
 * indexes to an already-existing table before any migration ran.
 *
 * Row mapping (runtime read the row's own reach columns, not its tab, so
 * the columns are what is copied):
 *
 *   admin-login (system)   copied as it is: a message pattern becomes a
 *                          bot DM message trigger; a slash command becomes
 *                          an isSystem command + root leaf. If it cannot be
 *                          expressed, the default DM `!login` trigger is
 *                          written instead — never dropped.
 *   message_pattern        one message trigger per surface the row fired
 *                          on: BotDM → `bot_dm` (keeps its audience),
 *                          Guild → `guild` (keeps placement). A row on
 *                          both (the global_all tab) becomes two triggers.
 *   slash_command          a command + root leaf. scope=global → global;
 *                          scope=guild + placement guild → that guild;
 *                          scope=guild without placement (all_guilds tab)
 *                          → a global command usable only in guilds.
 *   webhook                url / secret / auth mode copied as ciphertext.
 *
 * Dropped (each logged to botEventLog): slash commands limited to a user,
 * group or channel (Discord cannot express that), message patterns that
 * only matched in group DMs (the bot never receives those), the guild
 * half of a pattern with a user/group audience (its bot DM half is kept
 * with the audience; a guild-only one is dropped whole), custom rows
 * without a webhook URL, and slash commands whose name or shape Discord
 * would reject or whose name an enabled row already holds.
 *
 * Also removes the `behavior:<scopeKey>.manage` capability tokens still
 * stored on roles: they no longer parse, so the capability routes can
 * neither show nor revoke them.
 *
 * Then stats follow their rows (behavior_stats is rebuilt so its foreign
 * key points at behavior_definitions), and `behaviors` and
 * `behavior_scope_tabs` are dropped. `behavior_group_members` and
 * `reconciler_owned_commands` are untouched — a command no longer desired
 * is removed from Discord by the boot reconcile, which owns it.
 *
 * SQLite and Postgres: rows are read with plain SELECTs and filtered in
 * JS (old enum literals are never put into SQL); new ids are assigned
 * here and the Postgres sequences are moved past them. One transaction;
 * the bot event log is written only after it commits (a rolled-back run
 * logs nothing, and the log never writes inside the open transaction).
 * Once `behaviors` is gone, re-running only re-checks the indexes.
 */

import type { MigrationFn } from "umzug";
import { DataTypes, Op, type QueryInterface, type Transaction } from "sequelize";
import { botEventLog } from "../modules/bot-events/bot-event-log.js";

const OLD = "behaviors";
const TABS = "behavior_scope_tabs";
const STATS = "behavior_stats";
const COMMANDS = "behavior_commands";
const DEFINITIONS = "behavior_definitions";
const WEBHOOKS = "behavior_webhook_actions";
const ROLE_CAPABILITIES = "admin_role_capabilities";

const COMMAND_NAME_RE = /^[a-z0-9_-]{1,32}$/;

/** Old Postgres enum types left behind by dropping `behaviors`. */
const OLD_ENUM_COLUMNS = [
  "forwardType",
  "source",
  "triggerType",
  "messagePatternKind",
  "scope",
  "audienceKind",
  "webhookAuthMode",
  "systemKey",
];

interface IndexSpec {
  table: string;
  name: string;
  fields: string[];
  unique?: boolean;
  where?: Record<string, unknown>;
}

const INDEXES: IndexSpec[] = [
  {
    table: COMMANDS,
    name: "behavior_commands_global_name_uq",
    fields: ["name"],
    unique: true,
    where: { registration: "global" },
  },
  {
    table: COMMANDS,
    name: "behavior_commands_guild_name_uq",
    fields: ["name", "guildId"],
    unique: true,
    where: { registration: "guild" },
  },
  {
    table: DEFINITIONS,
    name: "behavior_definitions_leaf_uq",
    fields: ["commandId", "subcommandGroup", "subcommand"],
    unique: true,
  },
  {
    table: DEFINITIONS,
    name: "behavior_definitions_system_uq",
    fields: ["systemKey"],
    unique: true,
    where: { systemKey: { [Op.ne]: null } },
  },
];

// ── old rows ────────────────────────────────────────────────────────────────

interface OldRow {
  id: number;
  title: string;
  description: string | null;
  enabled: unknown;
  sortOrder: number;
  stopOnMatch: unknown;
  ignoreBots: unknown;
  source: string;
  triggerType: string;
  messagePatternKind: string | null;
  messagePatternValue: string | null;
  slashCommandName: string | null;
  slashCommandDescription: string | null;
  slashCommandOptions: string | null;
  scope: string;
  integrationTypes: string | null;
  contexts: string | null;
  placementGuildId: string | null;
  placementChannelId: string | null;
  audienceKind: string;
  audienceUserId: string | null;
  audienceGroupName: string | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
  webhookAuthMode: string | null;
  systemKey: string | null;
}

const bool = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "t";

/** Old CSV column (contexts / integrationTypes) → sorted, deduped values. */
function csvValues(raw: string | null): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

// ── planned rows ────────────────────────────────────────────────────────────

interface PlannedCommand {
  name: string;
  description: string;
  registration: "global" | "guild";
  guildId: string | null;
  integrationTypes: string;
  contexts: string;
  isSystem: boolean;
}

type PlannedTrigger =
  | { kind: "command"; command: PlannedCommand; leafDescription: string | null; options: string | null }
  | {
      kind: "message";
      surface: "bot_dm" | "guild";
      guildId: string | null;
      channelId: string | null;
    };

type Plan =
  | { ok: true; triggers: PlannedTrigger[]; partialDrop?: string }
  | { ok: false; reason: string };

function planSlash(row: OldRow, isSystem: boolean): Plan {
  const name = row.slashCommandName ?? "";
  if (!COMMAND_NAME_RE.test(name)) {
    return { ok: false, reason: `invalid command name '${name}'` };
  }
  if (row.audienceKind !== "all") {
    return {
      ok: false,
      reason: `slash command limited to a ${row.audienceKind} (Discord cannot limit a command to one user or group)`,
    };
  }
  if (row.placementChannelId !== null) {
    return {
      ok: false,
      reason: "slash command limited to one channel (Discord cannot express that)",
    };
  }
  const contexts = csvValues(row.contexts);
  const integrationTypes = csvValues(row.integrationTypes);
  if (contexts.length === 0 || integrationTypes.length === 0) {
    return { ok: false, reason: "slash command without contexts or install types" };
  }
  let registration: "global" | "guild" = "global";
  let guildId: string | null = null;
  if (row.scope === "guild") {
    if (contexts.join(",") !== "Guild" || integrationTypes.join(",") !== "guild_install") {
      return { ok: false, reason: "guild slash command outside Guild / guild_install" };
    }
    if (row.placementGuildId !== null) {
      registration = "guild";
      guildId = row.placementGuildId;
    }
    // no placement = the all_guilds tab → a global command usable in guilds
  }
  const description = (row.slashCommandDescription?.trim() || row.title.trim() || name).slice(0, 100);
  return {
    ok: true,
    triggers: [
      {
        kind: "command",
        command: {
          name,
          description,
          registration,
          guildId,
          integrationTypes: integrationTypes.join(","),
          contexts: contexts.join(","),
          isSystem,
        },
        leafDescription: row.slashCommandDescription,
        options: row.slashCommandOptions,
      },
    ],
  };
}

function planPattern(row: OldRow, isSystem: boolean): Plan {
  if (!row.messagePatternKind || !row.messagePatternValue) {
    return { ok: false, reason: "message pattern without a pattern" };
  }
  // The login's message trigger may only live in bot DMs — where it has
  // always been answered.
  if (isSystem) {
    return {
      ok: true,
      triggers: [{ kind: "message", surface: "bot_dm", guildId: null, channelId: null }],
    };
  }
  const contexts = csvValues(row.contexts);
  const triggers: PlannedTrigger[] = [];
  if (contexts.includes("BotDM")) {
    triggers.push({ kind: "message", surface: "bot_dm", guildId: null, channelId: null });
  }
  let partialDrop: string | undefined;
  if (contexts.includes("Guild") && row.audienceKind !== "all") {
    const reason = `guild message pattern limited to a ${row.audienceKind} (audience only applies in bot DMs)`;
    if (triggers.length === 0) return { ok: false, reason };
    // keep the bot DM half with its audience; only the guild half goes
    partialDrop = reason;
  } else if (contexts.includes("Guild")) {
    triggers.push({
      kind: "message",
      surface: "guild",
      guildId: row.placementGuildId,
      channelId: row.placementGuildId !== null ? row.placementChannelId : null,
    });
  }
  if (triggers.length === 0) {
    return {
      ok: false,
      reason: `message pattern only on contexts '${contexts.join(",")}' (the bot never receives those messages)`,
    };
  }
  return { ok: true, triggers, ...(partialDrop ? { partialDrop } : {}) };
}

function planRow(row: OldRow): Plan {
  const isSystem = row.source === "system";
  if (!isSystem && !row.webhookUrl) {
    return { ok: false, reason: "custom behavior without a webhook URL" };
  }
  return row.triggerType === "slash_command"
    ? planSlash(row, isSystem)
    : planPattern(row, isSystem);
}

function plannedCommand(plan: { triggers: PlannedTrigger[] }): PlannedCommand | null {
  const trigger = plan.triggers.find((t) => t.kind === "command");
  return trigger && trigger.kind === "command" ? trigger.command : null;
}

function commandKey(c: PlannedCommand): string {
  return c.registration === "global" ? `global ${c.name}` : `guild:${c.guildId} ${c.name}`;
}

// ── migration ───────────────────────────────────────────────────────────────

/** A bot event log entry, written once the migration's transaction commits. */
interface LogEntry {
  level: "info" | "warn";
  message: string;
  meta: Record<string, unknown>;
}

async function tableNames(qi: QueryInterface, transaction: Transaction): Promise<string[]> {
  const raw = (await qi.showAllTables({ transaction })) as unknown[];
  return raw.map((t) => (typeof t === "string" ? t : (t as { tableName: string }).tableName));
}

async function nextId(
  qi: QueryInterface,
  table: string,
  pk: string,
  transaction: Transaction,
): Promise<number> {
  const rows = (await qi.select(null, table, { transaction })) as Array<
    Record<string, number>
  >;
  return rows.reduce((max, r) => Math.max(max, Number(r[pk])), 0) + 1;
}

async function ensureIndexes(qi: QueryInterface, transaction: Transaction): Promise<void> {
  for (const spec of INDEXES) {
    const existing = (await qi.showIndex(spec.table, { transaction })) as Array<{ name: string }>;
    if (existing.some((i) => i.name === spec.name)) continue;
    await qi.addIndex(spec.table, {
      name: spec.name,
      fields: spec.fields,
      unique: spec.unique ?? false,
      ...(spec.where ? { where: spec.where } : {}),
      transaction,
    });
  }
}

async function moveBehaviors(
  qi: QueryInterface,
  transaction: Transaction,
  log: LogEntry[],
): Promise<void> {
  const now = new Date();
  const oldRows = (await qi.select(null, OLD, { transaction })) as OldRow[];
  oldRows.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  let commandId = await nextId(qi, COMMANDS, "id", transaction);
  let definitionId = await nextId(qi, DEFINITIONS, "id", transaction);
  const commands: Record<string, unknown>[] = [];
  const definitions: Record<string, unknown>[] = [];
  const webhooks: Record<string, unknown>[] = [];
  /** old behavior id → the first new definition id (where its stats go) */
  const statsTarget = new Map<number, number>();
  const dropped: Array<{ id: number; reason: string }> = [];

  // Two old slash rows can map to the same command name + registration
  // (the old unique index only covered enabled rows). Keep the enabled one
  // — it is the command people use — else the first by sortOrder.
  const plans = new Map(oldRows.map((row) => [row.id, planRow(row)] as const));
  const commandOwner = new Map<string, OldRow>();
  for (const row of oldRows) {
    const plan = plans.get(row.id)!;
    const cmd = plan.ok ? plannedCommand(plan) : null;
    if (!cmd) continue;
    const owner = commandOwner.get(commandKey(cmd));
    if (!owner || (!bool(owner.enabled) && bool(row.enabled))) {
      commandOwner.set(commandKey(cmd), row);
    }
  }

  for (const row of oldRows) {
    const isSystem = row.source === "system";
    if (isSystem && row.systemKey !== "admin-login") {
      dropped.push({ id: row.id, reason: `unknown system behavior '${row.systemKey}'` });
      continue;
    }
    let plan = plans.get(row.id)!;
    const cmd = plan.ok ? plannedCommand(plan) : null;
    if (cmd && commandOwner.get(commandKey(cmd)) !== row) {
      plan = {
        ok: false,
        reason: `command name '${cmd.name}' already taken by behavior #${commandOwner.get(commandKey(cmd))!.id}`,
      };
    }
    if (!plan.ok && isSystem) {
      // The owner's only way into the admin UI: fall back to the default
      // DM `!login` rather than lose it.
      log.push({
        level: "warn",
        message: `migration 011: login behavior #${row.id} could not be copied (${plan.reason}); using the default DM \`!login\` trigger`,
        meta: { behaviorId: row.id },
      });
      row.messagePatternKind = "startswith";
      row.messagePatternValue = "!login";
      plan = { ok: true, triggers: [{ kind: "message", surface: "bot_dm", guildId: null, channelId: null }] };
    }
    if (!plan.ok) {
      dropped.push({ id: row.id, reason: plan.reason });
      continue;
    }
    if (plan.partialDrop) {
      log.push({
        level: "warn",
        message: `migration 011: behavior #${row.id} kept in bot DMs; its guild trigger dropped — ${plan.partialDrop}`,
        meta: { behaviorId: row.id, reason: plan.partialDrop },
      });
    }

    for (const trigger of plan.triggers) {
      const id = definitionId++;
      if (!statsTarget.has(row.id)) statsTarget.set(row.id, id);
      const base = {
        id,
        title: row.title,
        description: row.description ?? "",
        enabled: bool(row.enabled),
        sortOrder: row.sortOrder,
        systemKey: isSystem ? row.systemKey : null,
        actionSource: isSystem ? "builtin" : "webhook",
        stopOnMatch: bool(row.stopOnMatch),
        ignoreBots: bool(row.ignoreBots),
        createdAt: now,
        updatedAt: now,
      };
      if (trigger.kind === "command") {
        const cid = commandId++;
        commands.push({ id: cid, ...trigger.command, defaultMemberPermissions: null, createdAt: now, updatedAt: now });
        definitions.push({
          ...base,
          triggerKind: "command",
          commandId: cid,
          subcommandGroup: "",
          subcommand: "",
          leafDescription: trigger.leafDescription,
          options: trigger.options,
          surface: null,
          guildId: null,
          channelId: null,
          patternKind: null,
          patternValue: null,
          stopOnMatch: false,
          audienceKind: "all",
          audienceUserId: null,
          audienceGroupName: null,
        });
      } else {
        const dm = trigger.surface === "bot_dm";
        definitions.push({
          ...base,
          triggerKind: "message",
          commandId: null,
          subcommandGroup: null,
          subcommand: null,
          leafDescription: null,
          options: null,
          surface: trigger.surface,
          guildId: trigger.guildId,
          channelId: trigger.channelId,
          patternKind: row.messagePatternKind,
          patternValue: row.messagePatternValue,
          audienceKind: dm ? row.audienceKind : "all",
          audienceUserId: dm && row.audienceKind === "user" ? row.audienceUserId : null,
          audienceGroupName: dm && row.audienceKind === "group" ? row.audienceGroupName : null,
        });
      }
      if (!isSystem) {
        webhooks.push({
          behaviorId: id,
          url: row.webhookUrl,
          secret: row.webhookSecret,
          authMode: row.webhookSecret ? (row.webhookAuthMode ?? "token") : null,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  if (commands.length > 0) await qi.bulkInsert(COMMANDS, commands, { transaction });
  if (definitions.length > 0) await qi.bulkInsert(DEFINITIONS, definitions, { transaction });
  if (webhooks.length > 0) await qi.bulkInsert(WEBHOOKS, webhooks, { transaction });

  // behavior_stats: rebuild with the foreign key on behavior_definitions,
  // carrying each kept row's counters to its (first) new definition.
  const tables = await tableNames(qi, transaction);
  const oldStats = tables.includes(STATS)
    ? ((await qi.select(null, STATS, { transaction })) as Array<Record<string, unknown>>)
    : [];
  if (tables.includes(STATS)) await qi.dropTable(STATS, { transaction });
  await qi.createTable(
    STATS,
    {
      behaviorId: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        references: { model: DEFINITIONS, key: "id" },
        onDelete: "CASCADE",
        onUpdate: "CASCADE",
      },
      lastFiredAt: { type: DataTypes.STRING, allowNull: true },
      successCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      failureCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      consecutiveFailures: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      lastError: { type: DataTypes.TEXT, allowNull: true },
      lastErrorAt: { type: DataTypes.STRING, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    },
    { transaction },
  );
  const movedStats = oldStats
    .filter((s) => statsTarget.has(Number(s["behaviorId"])))
    .map((s) => ({ ...s, behaviorId: statsTarget.get(Number(s["behaviorId"])) }));
  if (movedStats.length > 0) await qi.bulkInsert(STATS, movedStats, { transaction });

  await qi.dropTable(OLD, { transaction });
  if (tables.includes(TABS)) await qi.dropTable(TABS, { transaction });

  if (qi.sequelize.getDialect() === "postgres") {
    for (const col of OLD_ENUM_COLUMNS) {
      await qi.sequelize.query(`DROP TYPE IF EXISTS "enum_${OLD}_${col}"`, { transaction });
    }
    // ids were assigned here — move the serial sequences past them
    for (const [table, inserted] of [
      [COMMANDS, commands.length],
      [DEFINITIONS, definitions.length],
    ] as const) {
      if (inserted === 0) continue;
      await qi.sequelize.query(
        `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), (SELECT MAX("id") FROM "${table}"))`,
        { transaction },
      );
    }
  }

  for (const d of dropped) {
    log.push({
      level: "warn",
      message: `migration 011: behavior #${d.id} dropped — ${d.reason}`,
      meta: { behaviorId: d.id, reason: d.reason },
    });
  }
  log.push({
    level: "info",
    message: `migration 011: ${oldRows.length - dropped.length} behavior(s) moved to ${definitions.length} definition(s) and ${commands.length} command(s); ${dropped.length} dropped`,
    meta: { moved: oldRows.length - dropped.length, dropped: dropped.length },
  });
}

/**
 * Remove the stored `behavior:<scopeKey>.manage` tokens (ADR 0003 dropped
 * per-scope-tab delegation). They no longer parse as capabilities, so the
 * role routes can neither list nor revoke them; `behavior.manage` stays.
 */
async function dropScopedBehaviorTokens(
  qi: QueryInterface,
  transaction: Transaction,
  log: LogEntry[],
): Promise<void> {
  if (!(await tableNames(qi, transaction)).includes(ROLE_CAPABILITIES)) return;
  const where = { capability: { [Op.like]: "behavior:%" } };
  const rows = (await qi.select(null, ROLE_CAPABILITIES, {
    where,
    transaction,
  })) as unknown[];
  if (rows.length === 0) return;
  await qi.bulkDelete(ROLE_CAPABILITIES, where, { transaction });
  log.push({
    level: "info",
    message: `migration 011: removed ${rows.length} behavior:<scopeKey>.manage capability grant(s) from roles`,
    meta: { removed: rows.length },
  });
}

export const up: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const log: LogEntry[] = [];
  await qi.sequelize.transaction(async (transaction) => {
    if ((await tableNames(qi, transaction)).includes(OLD)) {
      await moveBehaviors(qi, transaction, log);
    }
    await dropScopedBehaviorTokens(qi, transaction, log);
    await ensureIndexes(qi, transaction);
  });
  for (const entry of log) {
    botEventLog.record(entry.level, "bot", entry.message, entry.meta);
  }
};

export const down: MigrationFn<QueryInterface> = async () => {
  // Not reversible: the old schema expressed reach the new model rejects
  // (and the dropped rows are gone). Roll forward instead.
};
