/**
 * "Register first, store after" — for a write whose command must reach
 * Discord BEFORE the DB says so, because the trigger it replaces must keep
 * working until the new one does: the system login's trigger switch
 * (system-login-trigger-route.ts) and a message trigger converted to a
 * command leaf (behavior-trigger-convert.ts). Ordinary command writes go
 * the other way round, commit then register (command-registration-sync.ts).
 *
 *   1. register the command as it WILL be stored (a CatalogCommand built
 *      from the proposed rows; a new command has no id yet, 0 stands in)
 *   2. Discord refused, or the bot is not connected → registration_failed,
 *      nothing stored
 *   3. store it
 *   4. the store failed → put Discord back to what the DB still holds (the
 *      stored command registered again, or the new name released) and
 *      throw StoredAfterRegistrationFailed, saying whether that worked
 *
 * Callers run it inside withRegistrationLock (taken after the behavior
 * write lock), so no reconcileAll sweeps the registration before its row
 * exists. Also here: the row columns both writes store.
 */

import { sortJoin } from "../../utils/sort-join.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import type {
  LockedRegistration,
  RegisterOneResult,
} from "../command-system/reconcile.service.js";
import type { TargetOutcome } from "../command-system/types.js";
import { BehaviorApiError } from "./behavior-api-error.js";
import type { CatalogBehavior, CatalogCommand } from "./behavior-catalog.js";
import type { RegisteredName } from "./command-registration-sync.js";
import type { CommandSettings } from "./command-tree-rules.js";

// ── row columns ─────────────────────────────────────────────────────────────

/** A command row's settings, as a register-first write stores them. */
export interface CommandRowSettings extends CommandSettings {
  defaultMemberPermissions: string | null;
}

/** The behavior_commands columns of `settings`. */
export function commandColumnsOf(settings: CommandRowSettings, isSystem: boolean) {
  return {
    name: settings.name,
    description: settings.description,
    registration: settings.registration,
    guildId: settings.guildId,
    integrationTypes: sortJoin([...settings.integrationTypes]),
    contexts: sortJoin([...settings.contexts]),
    defaultMemberPermissions: settings.defaultMemberPermissions,
    isSystem,
  };
}

/**
 * A behavior row's trigger columns as a leaf of command `commandId` (the
 * root leaf unless `path` says otherwise); every message trigger field
 * goes.
 */
export function leafColumnsOf(
  commandId: number,
  path: { subcommand: string; leafDescription: string | null } = { subcommand: "", leafDescription: null },
) {
  return {
    triggerKind: "command" as const,
    commandId,
    subcommandGroup: "",
    subcommand: path.subcommand,
    leafDescription: path.leafDescription,
    options: null,
    surface: null,
    guildId: null,
    channelId: null,
    patternKind: null,
    patternValue: null,
    stopOnMatch: false,
    ignoreBots: true,
    audienceKind: "all" as const,
    audienceUserId: null,
    audienceGroupName: null,
  };
}

/** The command a write will store, for registering it first: `id` 0 for one that has no row yet. */
export function proposedCommand(
  id: number,
  settings: CommandRowSettings,
  isSystem: boolean,
  leaves: CatalogBehavior[],
): CatalogCommand {
  return { id, ...commandColumnsOf(settings, isSystem), updatedAt: new Date(), leaves };
}

// ── the flow ────────────────────────────────────────────────────────────────

/** The store failed after Discord accepted the command; `takenBack` says whether Discord was put back. */
export class StoredAfterRegistrationFailed extends Error {
  constructor(
    readonly cause: unknown,
    readonly takenBack: boolean,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "StoredAfterRegistrationFailed";
  }
}

/** Discord did not take the command: the 502 a register-first write answers. `keeps` says what stays. */
export function registrationRefused(
  name: string,
  result: Exclude<RegisterOneResult, { ok: true }>,
  keeps: string,
): BehaviorApiError {
  const why =
    result.reason === "bot_not_ready"
      ? "the bot is not connected to Discord"
      : `Discord did not accept /${name}: ${result.error}`;
  return new BehaviorApiError("registration_failed", `${why}; ${keeps}`, undefined, {
    targets: "outcomes" in result ? result.outcomes : [],
  });
}

export interface RegisterFirstWrite<T> {
  /** The command as the write will store it. */
  proposed: CatalogCommand;
  /** Where it registers (released again if the store fails and `restore` is null). */
  at: RegisteredName;
  /** What stays when Discord refuses, for the refusal's message ("the login keeps its current trigger"). */
  keeps: string;
  /** The command Discord should show again if the store fails; null: release `at`. */
  restore: CatalogCommand | null;
  /** The bot event log line when Discord could not be put back. */
  takeBackFailed: string;
  store: () => Promise<T>;
}

/** Put Discord back to what the DB holds after a failed store. Never throws; answers whether it worked. */
async function takeBack(locked: LockedRegistration, write: RegisterFirstWrite<unknown>): Promise<boolean> {
  try {
    const undone = write.restore
      ? (await locked.registerBehaviorCommand(write.restore)).ok
      : (await locked.releaseRegistration(write.at.name, write.at.target)) !== "unavailable";
    if (undone) return true;
  } catch {
    // reported below
  }
  botEventLog.record("error", "bot", write.takeBackFailed, { name: write.at.name });
  return false;
}

/** Register `proposed`, then store; see the header. Runs inside withRegistrationLock. */
export async function registerThenStore<T>(
  locked: LockedRegistration,
  write: RegisterFirstWrite<T>,
): Promise<{ value: T; outcomes: TargetOutcome[] }> {
  const result = await locked.registerBehaviorCommand(write.proposed);
  if (!result.ok) throw registrationRefused(write.at.name, result, write.keeps);
  try {
    return { value: await write.store(), outcomes: result.outcomes };
  } catch (err) {
    throw new StoredAfterRegistrationFailed(err, await takeBack(locked, write));
  }
}
