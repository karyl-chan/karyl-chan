/**
 * The trigger switch of a fixed row (#139, #126): the System Behavior
 * (login, system-login-trigger-route.ts) and every Service Behavior
 * (service-routes.ts) take no write but this one. Their title, action,
 * enabled state and existence are not the admin's; their trigger is,
 * and it is either a bot DM Message Trigger or a Command — the root leaf
 * of an `isSystem` command, which the command routes refuse
 * (refuseSystemCommand), so the switch is its only writer.
 *
 * Both rows are someone's way in (the owner's to the admin UI, a user's
 * to a service), so the switch never leaves one without a working
 * trigger: the NEW trigger takes effect first, the old one goes after.
 *
 *   to a command (from a message, or a changed command):
 *     1. the name must be free in the shared namespace
 *     2. register the command on Discord as it will be stored — holding
 *        the reconcile lock for the rest (withRegistrationLock), so no
 *        reconcileAll sweeps it before its row exists. Steps 2–5 are the
 *        register-first flow command-register-first.ts holds, shared
 *        with converting a message trigger to a command
 *     3. Discord refused, or the bot is not connected → 502
 *        registration_failed, nothing changed (a refused edit of an
 *        existing command leaves Discord's previous version: create /
 *        edit calls are atomic)
 *     4. store it (one transaction): the row becomes the root leaf of an
 *        `isSystem` command
 *     5. the store failed → take the registration back (release the new
 *        name, or re-register the stored command when only its settings
 *        changed) and fail; the old trigger still holds
 *     6. a renamed command: release the old name (failure: logged, the
 *        next reconcileAll removes it)
 *   to a message (from a command):
 *     1. store first: the row becomes the bot DM trigger and its command
 *        row goes — the pattern works from the commit on
 *     2. delete the command from Discord; failure is logged and left to
 *        the next reconcileAll (the command is no longer desired, and it
 *        is on the roster)
 *   message → message: a plain row update.
 *
 * The whole switch — reading the row, the stale check, the caller's own
 * checks, every Discord call and the store — runs inside the reconcile
 * lock; callers take the behavior write lock around it first (the same
 * order as command writes, so no deadlock). Without a reconciler only a
 * message → message change goes through.
 */

import type { Transaction } from "sequelize";
import { botEventLog } from "../bot-events/bot-event-log.js";
import type {
  CommandReconciler,
  LockedRegistration,
} from "../command-system/reconcile.service.js";
import { BehaviorApiError } from "./behavior-api-error.js";
import {
  loadBehaviorCatalog,
  type BehaviorCatalog,
  type FixedRowEntry,
} from "./behavior-catalog.js";
import { checkNotStale } from "./behavior-write-guards.js";
import { behaviorTransaction } from "./behavior-write-lock.js";
import {
  StoredAfterRegistrationFailed,
  commandColumnsOf,
  leafColumnsOf,
  proposedCommand,
  registerThenStore,
  type CommandRowSettings,
} from "./command-register-first.js";
import type {
  CommandNamespaceChecker,
  RegistrationReport,
} from "./command-registration-sync.js";
import { asNameConflict, checkNameFree, checkNamespaceFree } from "./command-writes.js";
import { BehaviorCommand } from "./models/behavior-command.model.js";
import {
  BehaviorDefinition,
  type BehaviorAudienceKind,
  type BehaviorPatternKind,
} from "./models/behavior-definition.model.js";
import { pruneUnusedGroupMembers } from "./models/behavior-group-member.model.js";

/** What the switch needs of the CommandReconciler (injected, as for command writes). */
export type FixedTriggerRegistrar = Pick<
  CommandReconciler,
  "withRegistrationLock" | "releaseRegistration"
>;

export interface FixedTriggerDeps {
  reconciler?: FixedTriggerRegistrar;
  namespace?: CommandNamespaceChecker;
}

/** A bot DM pattern; who it answers; it always ends the walk. */
export interface FixedMessageTrigger {
  kind: "message";
  patternKind: BehaviorPatternKind;
  patternValue: string;
  audienceKind: BehaviorAudienceKind;
  audienceUserId: string | null;
  audienceGroupName: string | null;
}

/** A global command with no default member permissions. */
export interface FixedCommandTrigger {
  kind: "command";
  settings: CommandRowSettings;
}

export type FixedTrigger = FixedMessageTrigger | FixedCommandTrigger;

/** The version the admin's view showed: the command's, or the trigger row's. */
export function versionOf(current: FixedRowEntry): { updatedAt: Date } {
  return current.command ?? current.row;
}

/** The audit's view of the stored trigger (it holds no secret). */
export function storedSummary({ row, command }: FixedRowEntry): Record<string, unknown> {
  return command
    ? {
        kind: "command",
        name: command.name,
        description: command.description,
        integrationTypes: command.integrationTypes.split(","),
        contexts: command.contexts.split(","),
      }
    : {
        kind: "message",
        patternKind: row.patternKind,
        patternValue: row.patternValue,
        ...(row.audienceKind !== "all"
          ? { audienceKind: row.audienceKind, audienceUserId: row.audienceUserId, audienceGroupName: row.audienceGroupName }
          : {}),
      };
}

/** The audit's view of the requested trigger. */
export function triggerSummary(next: FixedTrigger): Record<string, unknown> {
  if (next.kind === "message") {
    const { kind, patternKind, patternValue, audienceKind, audienceUserId, audienceGroupName } = next;
    return {
      kind,
      patternKind,
      patternValue,
      ...(audienceKind !== "all" ? { audienceKind, audienceUserId, audienceGroupName } : {}),
    };
  }
  const { name, description, integrationTypes, contexts } = next.settings;
  return { kind: "command", name, description, integrationTypes, contexts };
}

/** The settings of a fixed row's command: always global, never default member permissions. */
export function globalCommandSettings(trigger: {
  name: string;
  description: string;
  integrationTypes: CommandRowSettings["integrationTypes"];
  contexts: CommandRowSettings["contexts"];
}): CommandRowSettings {
  return {
    name: trigger.name,
    description: trigger.description,
    registration: "global",
    guildId: null,
    integrationTypes: trigger.integrationTypes,
    contexts: trigger.contexts,
    defaultMemberPermissions: null,
  };
}

/** The row's columns as a bot DM message trigger (it always stops). */
function messageColumnsOf(next: FixedMessageTrigger) {
  return {
    triggerKind: "message" as const,
    commandId: null,
    subcommandGroup: null,
    subcommand: null,
    leafDescription: null,
    options: null,
    surface: "bot_dm" as const,
    guildId: null,
    channelId: null,
    patternKind: next.patternKind,
    patternValue: next.patternValue,
    stopOnMatch: true,
    ignoreBots: true,
    audienceKind: next.audienceKind,
    audienceUserId: next.audienceUserId,
    audienceGroupName: next.audienceGroupName,
  };
}

// ── the switch ──────────────────────────────────────────────────────────────

export interface FixedTriggerSwitch {
  /** The row as it is now, read inside the locks. */
  load: () => Promise<FixedRowEntry>;
  next: FixedTrigger;
  ifUpdatedAt: string | undefined;
  /** Names the row in refusals and log lines ("the system login"). */
  what: string;
  /** May the command take `/login`? Only the login's own may (#96). */
  ownsReservedNames: boolean;
  /** Checks against the other fixed rows, on the catalog the switch reads. */
  check?: (catalog: BehaviorCatalog, current: FixedRowEntry) => void;
  /** Learns the row as it was before the switch, for the audit of one that fails. */
  loaded: (current: FixedRowEntry) => void;
}

async function storeCommandTrigger(
  current: FixedRowEntry,
  settings: CommandRowSettings,
  transaction: Transaction,
): Promise<void> {
  if (current.command) {
    // instance save: the model's cross-field validator needs every field
    const model = await BehaviorCommand.findByPk(current.command.id, { transaction });
    model!.set(commandColumnsOf(settings, true));
    await model!.save({ transaction }).catch((err: unknown) => asNameConflict(err, settings.name));
    return;
  }
  const command = await BehaviorCommand.create(commandColumnsOf(settings, true), {
    transaction,
  }).catch((err: unknown) => asNameConflict(err, settings.name));
  const row = await BehaviorDefinition.findByPk(current.row.id, { transaction });
  row!.set(leafColumnsOf(command.getDataValue("id") as number));
  await row!.save({ transaction });
  // a message trigger's audience group may have lost its last user
  await pruneUnusedGroupMembers(transaction);
}

async function switchToCommand(
  deps: FixedTriggerDeps,
  locked: LockedRegistration | null,
  current: FixedRowEntry,
  sw: FixedTriggerSwitch,
  settings: CommandRowSettings,
): Promise<RegistrationReport> {
  if (!deps.namespace) throw new Error("CommandNamespace not provided to behavior routes");
  const at = { name: settings.name, target: "global" } as const;
  const ownId = current.command?.id ?? null;
  await (sw.ownsReservedNames ? checkNamespaceFree : checkNameFree)(deps.namespace, at, ownId);
  const keeps = `${sw.what} keeps its current trigger`;
  if (!locked) {
    throw new BehaviorApiError(
      "registration_failed",
      `no command reconciler in this process; ${keeps}`,
      undefined,
      { targets: [] },
    );
  }
  // a new command has no row yet, so no id: 0 stands in (it only labels the reconciler's result)
  const id = current.command?.id ?? 0;
  const { outcomes } = await registerThenStore(locked, {
    proposed: proposedCommand(id, settings, true, [
      { ...current.row, ...leafColumnsOf(id), webhook: null },
    ]),
    at,
    keeps,
    // the old command's own settings when the switch only changed them,
    // else no registration under the new name
    restore: current.command && current.command.name === settings.name ? current.command : null,
    takeBackFailed: `${sw.what}: storing /${settings.name} failed and its registration could not be taken back; the next full reconcile restores Discord to the stored trigger`,
    store: () => behaviorTransaction((transaction) => storeCommandTrigger(current, settings, transaction)),
  });
  const previous = current.command?.name;
  if (previous !== undefined && previous !== settings.name) {
    if ((await locked.releaseRegistration(previous, "global")) === "unavailable") {
      botEventLog.record(
        "warn",
        "bot",
        `${sw.what}: the old /${previous} could not be removed from Discord; the next full reconcile removes it`,
        { name: previous },
      );
    }
  }
  return { status: "registered", targets: outcomes };
}

async function switchToMessage(
  locked: LockedRegistration | null,
  current: FixedRowEntry,
  sw: FixedTriggerSwitch,
  next: FixedMessageTrigger,
): Promise<RegistrationReport | null> {
  await behaviorTransaction(async (transaction) => {
    const row = await BehaviorDefinition.findByPk(current.row.id, { transaction });
    row!.set(messageColumnsOf(next));
    await row!.save({ transaction });
    if (current.command) {
      await BehaviorCommand.destroy({ where: { id: current.command.id }, transaction });
    }
    // the last trigger leaving a group takes its member list along (#137)
    if (current.row.audienceGroupName !== next.audienceGroupName) {
      await pruneUnusedGroupMembers(transaction);
    }
  });
  if (!current.command) return null;

  const name = current.command.name;
  const outcome = locked ? await locked.releaseRegistration(name, "global") : "unavailable";
  if (outcome === "unavailable") {
    botEventLog.record(
      "warn",
      "bot",
      `${sw.what}: switched to a message trigger, but /${name} could not be removed from Discord; the next full reconcile removes it`,
      { name },
    );
    return {
      status: "deferred",
      reason: `/${name} could not be removed from Discord yet; the next full reconcile removes it`,
    };
  }
  return { status: "removed" };
}

/** The whole switch; see the header. Run inside withBehaviorWriteLock. */
export async function switchFixedTrigger(
  deps: FixedTriggerDeps,
  sw: FixedTriggerSwitch,
): Promise<RegistrationReport | null> {
  const run = async (locked: LockedRegistration | null) => {
    const current = await sw.load();
    checkNotStale(versionOf(current), sw.ifUpdatedAt, sw.what);
    sw.check?.(await loadBehaviorCatalog(), current);
    sw.loaded(current);
    const { next } = sw;
    if (next.kind === "command") return switchToCommand(deps, locked, current, sw, next.settings);
    return switchToMessage(locked, current, sw, next);
  };
  return deps.reconciler ? deps.reconciler.withRegistrationLock(run) : run(null);
}

/** A switch that failed after it started → what the audit records of it (null: not audited). */
export function failureOutcome(err: unknown): Record<string, unknown> | null {
  if (err instanceof StoredAfterRegistrationFailed) {
    return { outcome: "store_failed", registrationTakenBack: err.takenBack, error: err.message };
  }
  if (err instanceof BehaviorApiError && (err.code === "name_conflict" || err.code === "registration_failed")) {
    return {
      outcome: err.code,
      error: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
  }
  return null;
}
