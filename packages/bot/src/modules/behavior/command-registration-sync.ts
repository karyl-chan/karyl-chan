/**
 * Getting a command write onto Discord — and taking it back when Discord
 * refuses it.
 *
 * A command write goes: (inside the behavior write lock) commit the rows →
 * `registerOne` the command as the DB now has it → on success release the
 * old name / target if the write moved it. The reconciler registers from
 * the DB, which is why the rows are committed first.
 *
 * Consistency story:
 *   - Discord refuses (any target fails or is unreachable, or the tree is
 *     invalid): the rows are restored from the snapshot taken before the
 *     write and the request fails with `registration_failed`. A behavior
 *     command has exactly one concrete target (global or one guild), and a
 *     create / edit call is atomic, so Discord still holds the previous
 *     version: DB and Discord agree again. A rename's old name is only
 *     released after the new one registered, so it is still there too.
 *   - The bot is not connected (boot, BOT_SKIP_DISCORD): the write stands
 *     and registration is `deferred` — the ready-time reconcileAll
 *     registers the DB state and sweeps the old name from the roster.
 *   - No enabled leaf left: the command is removed from Discord (`removed`);
 *     its name stays reserved by the row. A removal Discord refuses is
 *     handled like a refused registration (restore, registration_failed);
 *     a guild the bot cannot reach makes it `deferred`, as for a delete.
 *   - Releasing the old name fails: the write stands; the roster keeps the
 *     old entry and the next reconcileAll removes it.
 *   - Restoring the rows itself fails (DB error): still registration_failed,
 *     saying the change is still stored, and logged; the write that stayed
 *     in the DB is audited (registration: failed, restore: failed). DB and
 *     Discord differ until a resync, an edit or the ready-time reconcile
 *     registers the DB state.
 *   - Between the commit and a restore the runtime catalog can briefly see
 *     the refused version (dispatch reads the DB, not Discord).
 *
 * behavior only holds command-system TYPES (the reconciler and namespace
 * are injected by the route wiring), so there is no runtime edge back into
 * command-system.
 */

import type { CommandReconciler } from "../command-system/reconcile.service.js";
import type { CommandNamespace } from "../command-system/command-namespace.js";
import type { GuildTarget } from "../command-system/command-target.js";
import type { TargetOutcome } from "../command-system/types.js";
import type { FastifyRequest } from "fastify";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { BehaviorApiError } from "./behavior-api-error.js";
import { auditBehaviorWrite, type BehaviorAuditAction } from "./behavior-audit.js";
import { restoreCommand, type CommandSnapshot } from "./command-snapshot.js";
import type { BehaviorCommandRegistration } from "./models/behavior-command.model.js";

export type BehaviorCommandRegistrar = Pick<
  CommandReconciler,
  "registerOne" | "reconcileForBehaviorCommand" | "releaseRegistration"
>;
export type CommandNamespaceChecker = Pick<CommandNamespace, "check">;

/** Where a behavior command is registered: global or one guild. */
export interface RegisteredName {
  name: string;
  target: "global" | GuildTarget;
}

export function registeredNameOf(command: {
  name: string;
  registration: BehaviorCommandRegistration;
  guildId: string | null;
}): RegisteredName {
  return {
    name: command.name,
    target:
      command.registration === "guild" && command.guildId !== null
        ? `guild:${command.guildId}`
        : "global",
  };
}

/**
 * The audit entry a write would get. registerCommandWrite records it when a
 * refused registration could not be undone — the write then stands, so it
 * must be on the trail; on success the route records it itself.
 */
export interface PendingCommandAudit {
  request: FastifyRequest;
  action: BehaviorAuditAction;
  target: string;
  context: Record<string, unknown>;
}

export type RegistrationReport =
  | { status: "registered"; targets: TargetOutcome[] }
  | { status: "removed" }
  | { status: "deferred"; reason: string };

function moved(previous: RegisteredName | null, current: RegisteredName): boolean {
  return (
    previous !== null &&
    (previous.name !== current.name || previous.target !== current.target)
  );
}

async function release(
  registrar: BehaviorCommandRegistrar,
  previous: RegisteredName | null,
  current: RegisteredName | null,
): Promise<void> {
  if (previous === null) return;
  if (current !== null && !moved(previous, current)) return;
  // "unavailable" leaves the roster entry for the next reconcileAll
  await registrar.releaseRegistration(previous.name, previous.target);
}

/**
 * Register command `commandId` as the DB now has it. `previous` is where it
 * was registered before this write (null for a create or a resync);
 * `snapshot` restores the rows when Discord refuses (null: nothing to
 * restore, e.g. a resync).
 */
export async function registerCommandWrite(
  registrar: BehaviorCommandRegistrar | undefined,
  commandId: number,
  current: RegisteredName,
  previous: RegisteredName | null,
  snapshot: CommandSnapshot | null,
  audit?: PendingCommandAudit,
): Promise<RegistrationReport> {
  if (!registrar) {
    return { status: "deferred", reason: "no command reconciler in this process" };
  }
  const result = await registrar.registerOne({ source: "behavior", id: commandId });
  if (result.ok) {
    await release(registrar, previous, current);
    return { status: "registered", targets: result.outcomes };
  }
  switch (result.reason) {
    case "bot_not_ready":
      return { status: "deferred", reason: "the bot is not connected to Discord" };
    case "not_desired": {
      // no enabled leaf: take the command (and any old name) off Discord
      const removal = await registrar.reconcileForBehaviorCommand(commandId);
      if (!removal.ok) {
        return refused(
          commandId,
          `Discord did not remove /${current.name}: ${removal.error ?? "unknown error"}`,
          removal.targets ?? [],
          snapshot,
          audit,
        );
      }
      await release(registrar, previous, current);
      // the bot cannot reach the guild: nothing was removed yet — the same
      // answer releaseDeletedCommand gives; the roster keeps the entry
      if (removal.targets?.some((t) => t.status === "skipped")) {
        return {
          status: "deferred",
          reason: "the bot cannot reach the command's guild; the next full reconcile removes it",
        };
      }
      return { status: "removed" };
    }
    default:
      return refused(
        commandId,
        `Discord did not accept /${current.name}: ${result.error}`,
        "outcomes" in result ? result.outcomes : [],
        snapshot,
        audit,
      );
  }
}

/** Undo the write (when there is a snapshot) and fail with registration_failed. */
async function refused(
  commandId: number,
  message: string,
  targets: TargetOutcome[],
  snapshot: CommandSnapshot | null,
  audit: PendingCommandAudit | undefined,
): Promise<never> {
  let outcome = "";
  if (snapshot) {
    try {
      await restoreCommand(snapshot);
      outcome = "; the change was not saved";
    } catch (err) {
      // DB keeps the refused version, Discord the previous one; the
      // next resync / edit / ready-time reconcile registers the DB state.
      const reason = err instanceof Error ? err.message : String(err);
      botEventLog.record(
        "error",
        "bot",
        `behavior-command: restoring command ${commandId} after a refused registration failed: ${reason}`,
        { commandId },
      );
      outcome = "; restoring the previous version failed, so the change is still stored — resync or edit the command";
      if (audit) {
        await auditBehaviorWrite(audit.request, audit.action, audit.target, {
          ...audit.context,
          registration: "failed",
          restore: "failed",
        });
      }
    }
  }
  throw new BehaviorApiError("registration_failed", `${message}${outcome}`, undefined, {
    targets,
  });
}

/** A deleted command: remove its registration. */
export async function releaseDeletedCommand(
  registrar: BehaviorCommandRegistrar | undefined,
  previous: RegisteredName,
): Promise<RegistrationReport> {
  if (!registrar) {
    return { status: "deferred", reason: "no command reconciler in this process" };
  }
  const outcome = await registrar.releaseRegistration(previous.name, previous.target);
  return outcome === "unavailable"
    ? { status: "deferred", reason: "Discord could not be reached; the next full reconcile removes it" }
    : { status: "removed" };
}
