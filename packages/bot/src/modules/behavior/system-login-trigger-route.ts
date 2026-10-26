/**
 * PUT /api/behaviors/system/login/trigger (#139) — the one write the
 * System Behavior (login) takes: switching its trigger between a bot DM
 * Message Trigger and a Command (rules: system-login-trigger.ts). Its
 * title, action, enabled state and existence stay immutable; every other
 * write route still refuses it (behavior-write-guards.ts).
 *
 * The login is the owner's only way into the admin UI and the login
 * provider for other self-hosted services, so the switch never leaves it
 * without a working trigger: the NEW trigger takes effect first, the old
 * one goes after. Only a bot owner may switch it (requireOwner): an
 * admin who is not the owner must not be able to break the owner's way in.
 *
 *   to a command (from a message, or a changed command):
 *     1. the name must be free in the shared namespace (`/login` is the
 *        login's own)
 *     2. register the command on Discord as it will be stored — holding
 *        the reconcile lock for the rest (withRegistrationLock), so no
 *        reconcileAll sweeps it before its row exists
 *     3. Discord refused, or the bot is not connected → 502
 *        registration_failed, nothing changed (a refused edit of an
 *        existing command leaves Discord's previous version: create /
 *        edit calls are atomic)
 *     4. store it (one transaction): the system row becomes the root
 *        leaf of an `isSystem` command
 *     5. the store failed → take the registration back (release the new
 *        name, or re-register the stored command when only its settings
 *        changed) and fail; the old trigger still holds
 *     6. a renamed command: release the old name (failure: logged, the
 *        next reconcileAll removes it)
 *   to a message (from a command):
 *     1. store first: the system row becomes the bot DM trigger and the
 *        system command row goes — `!login` works from the commit on
 *     2. delete the command from Discord; failure is logged and left to
 *        the next reconcileAll (the command is no longer desired, and it
 *        is on the roster)
 *   message → message: a plain row update.
 *
 * Writes serialise like every behavior write (withBehaviorWriteLock, then
 * the reconcile lock — the same order as command writes, so no deadlock);
 * `ifUpdatedAt` refuses an edit based on an outdated view. The catalog
 * snapshot is invalidated by the model hooks on every write (and again
 * after commit).
 *
 * Audit: every attempt that reached the switch is recorded as
 * `behavior.system.trigger` with an `outcome` — `switched`, or the
 * failure: `name_conflict`, `registration_failed`, `store_failed` (with
 * whether the registration was taken back). One action with an outcome
 * keeps a login's whole history under one filter. Requests refused before
 * the switch (a malformed body, a stale version, not the owner) are not.
 */

import type { FastifyInstance } from "fastify";
import type { Transaction } from "sequelize";
import { sortJoin } from "../../utils/sort-join.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { requireOwner } from "../web-core/route-guards.js";
import { BehaviorApiError } from "./behavior-api-error.js";
import { auditBehaviorWrite } from "./behavior-audit.js";
import {
  loadBehaviorCatalog,
  systemLoginOf,
  type CatalogCommand,
  type SystemLoginEntry,
} from "./behavior-catalog.js";
import { buildBehaviorListView, type BehaviorListView } from "./behavior-list-view.js";
import { commandFields, ifUpdatedAtSchema, messageTriggerFields } from "./behavior-schemas.js";
import { checkNotStale } from "./behavior-write-guards.js";
import { behaviorTransaction, withBehaviorWriteLock } from "./behavior-write-lock.js";
import type {
  CommandNamespaceChecker,
  RegistrationReport,
} from "./command-registration-sync.js";
import { asNameConflict, checkNamespaceFree } from "./command-writes.js";
import { BehaviorCommand } from "./models/behavior-command.model.js";
import { BehaviorDefinition } from "./models/behavior-definition.model.js";
import { findStatsBulk } from "./models/behavior-stats.model.js";
import type {
  CommandReconciler,
  LockedRegistration,
  RegisterOneResult,
} from "../command-system/reconcile.service.js";
import {
  loginTriggerOf,
  type LoginCommandTrigger,
  type LoginMessageTrigger,
  type LoginTrigger,
  type LoginTriggerBody,
} from "./system-login-trigger.js";

/** What the switch needs of the CommandReconciler (injected, as for command writes). */
export type SystemLoginRegistrar = Pick<
  CommandReconciler,
  "withRegistrationLock" | "releaseRegistration"
>;

export interface SystemLoginTriggerDeps {
  reconciler?: SystemLoginRegistrar;
  namespace?: CommandNamespaceChecker;
  /** Bot owners (tests); production reads BOT_OWNER_IDS. */
  ownerIds?: readonly string[];
}

/** The body schema — also served by GET /api/behaviors/schema. */
export const loginTriggerSchema = {
  type: "object",
  properties: {
    kind: { enum: ["message", "command"] },
    patternKind: messageTriggerFields.patternKind,
    patternValue: messageTriggerFields.patternValue,
    sample: { type: "string", minLength: 1, maxLength: 2000 },
    name: commandFields.name,
    description: commandFields.description,
    integrationTypes: commandFields.integrationTypes,
    contexts: commandFields.contexts,
    ifUpdatedAt: ifUpdatedAtSchema,
  },
  required: ["kind"],
  additionalProperties: false,
} as const;

async function loadSystemLogin(): Promise<SystemLoginEntry> {
  const login = systemLoginOf(await loadBehaviorCatalog());
  if (!login) throw new BehaviorApiError("not_found", "the system login behavior does not exist");
  return login;
}

/** The version the admin's view showed: the command's, or the trigger row's. */
function versionOf(current: SystemLoginEntry): { updatedAt: Date } {
  return current.command ?? current.row;
}

/** The audit's view of the stored trigger (it holds no secret). */
function storedSummary({ row, command }: SystemLoginEntry): Record<string, unknown> {
  return command
    ? {
        kind: "command",
        name: command.name,
        description: command.description,
        integrationTypes: command.integrationTypes.split(","),
        contexts: command.contexts.split(","),
      }
    : { kind: "message", patternKind: row.patternKind, patternValue: row.patternValue };
}

// ── row columns ─────────────────────────────────────────────────────────────

/** The system row's columns as the root leaf of command `commandId`. */
function commandTriggerColumnsOf(commandId: number) {
  return {
    triggerKind: "command" as const,
    commandId,
    subcommandGroup: "",
    subcommand: "",
    leafDescription: null,
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

/** The system row's columns as a bot DM message trigger (everyone; it always stops). */
function messageTriggerColumnsOf(next: LoginMessageTrigger) {
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
    audienceKind: "all" as const,
    audienceUserId: null,
    audienceGroupName: null,
  };
}

/** The system command row's columns. */
function commandColumnsOf(next: LoginCommandTrigger) {
  return {
    name: next.name,
    description: next.description,
    registration: "global" as const,
    guildId: null,
    integrationTypes: sortJoin([...next.integrationTypes]),
    contexts: sortJoin([...next.contexts]),
    defaultMemberPermissions: null,
    isSystem: true,
  };
}

/**
 * The command the switch will store — registered before it is. A new one
 * has no row yet, so no id: 0 stands in (it only labels the reconciler's
 * result).
 */
function proposedCommand(current: SystemLoginEntry, next: LoginCommandTrigger): CatalogCommand {
  const id = current.command?.id ?? 0;
  return {
    id,
    ...commandColumnsOf(next),
    updatedAt: new Date(),
    leaves: [{ ...current.row, ...commandTriggerColumnsOf(id), webhook: null }],
  };
}

// ── the switch ──────────────────────────────────────────────────────────────

/** The store failed after Discord accepted the command; `takenBack` says whether Discord was put back. */
class LoginStoreFailed extends Error {
  constructor(
    readonly cause: unknown,
    readonly takenBack: boolean,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "LoginStoreFailed";
  }
}

function registrationRefused(name: string, result: Exclude<RegisterOneResult, { ok: true }>): BehaviorApiError {
  const why =
    result.reason === "bot_not_ready"
      ? "the bot is not connected to Discord"
      : `Discord did not accept /${name}: ${result.error}`;
  return new BehaviorApiError(
    "registration_failed",
    `${why}; the login keeps its current trigger`,
    undefined,
    { targets: "outcomes" in result ? result.outcomes : [] },
  );
}

async function storeCommandTrigger(
  current: SystemLoginEntry,
  next: LoginCommandTrigger,
  transaction: Transaction,
): Promise<void> {
  if (current.command) {
    // instance save: the model's cross-field validator needs every field
    const model = await BehaviorCommand.findByPk(current.command.id, { transaction });
    model!.set(commandColumnsOf(next));
    await model!.save({ transaction }).catch((err: unknown) => asNameConflict(err, next.name));
    return;
  }
  const command = await BehaviorCommand.create(commandColumnsOf(next), { transaction }).catch(
    (err: unknown) => asNameConflict(err, next.name),
  );
  const row = await BehaviorDefinition.findByPk(current.row.id, { transaction });
  row!.set(commandTriggerColumnsOf(command.getDataValue("id") as number));
  await row!.save({ transaction });
}

/**
 * Put Discord back to what the DB holds after the store failed: the old
 * command's own settings when the switch only changed them, else no
 * registration under the new name. Never throws; answers whether it worked.
 */
async function takeBack(
  locked: LockedRegistration,
  current: SystemLoginEntry,
  next: LoginCommandTrigger,
): Promise<boolean> {
  try {
    const undone =
      current.command && current.command.name === next.name
        ? (await locked.registerBehaviorCommand(current.command)).ok
        : (await locked.releaseRegistration(next.name, "global")) !== "unavailable";
    if (undone) return true;
  } catch {
    // reported below
  }
  botEventLog.record(
    "error",
    "bot",
    `system login: storing /${next.name} failed and its registration could not be taken back; the next full reconcile restores Discord to the stored trigger`,
    { name: next.name },
  );
  return false;
}

async function switchToCommand(
  namespace: CommandNamespaceChecker,
  locked: LockedRegistration | null,
  current: SystemLoginEntry,
  next: LoginCommandTrigger,
): Promise<RegistrationReport> {
  await checkNamespaceFree(namespace, { name: next.name, target: "global" }, current.command?.id ?? null);
  if (!locked) {
    throw new BehaviorApiError(
      "registration_failed",
      "no command reconciler in this process; the login keeps its current trigger",
      undefined,
      { targets: [] },
    );
  }
  const result = await locked.registerBehaviorCommand(proposedCommand(current, next));
  if (!result.ok) throw registrationRefused(next.name, result);
  try {
    await behaviorTransaction((transaction) => storeCommandTrigger(current, next, transaction));
  } catch (err) {
    throw new LoginStoreFailed(err, await takeBack(locked, current, next));
  }
  const previous = current.command?.name;
  if (previous !== undefined && previous !== next.name) {
    if ((await locked.releaseRegistration(previous, "global")) === "unavailable") {
      botEventLog.record(
        "warn",
        "bot",
        `system login: the old /${previous} could not be removed from Discord; the next full reconcile removes it`,
        { name: previous },
      );
    }
  }
  return { status: "registered", targets: result.outcomes };
}

async function switchToMessage(
  locked: LockedRegistration | null,
  current: SystemLoginEntry,
  next: LoginMessageTrigger,
): Promise<RegistrationReport | null> {
  await behaviorTransaction(async (transaction) => {
    const row = await BehaviorDefinition.findByPk(current.row.id, { transaction });
    row!.set(messageTriggerColumnsOf(next));
    await row!.save({ transaction });
    if (current.command) {
      await BehaviorCommand.destroy({ where: { id: current.command.id }, transaction });
    }
  });
  if (!current.command) return null;

  const name = current.command.name;
  const outcome = locked ? await locked.releaseRegistration(name, "global") : "unavailable";
  if (outcome === "unavailable") {
    botEventLog.record(
      "warn",
      "bot",
      `system login: switched to a message trigger, but /${name} could not be removed from Discord; the next full reconcile removes it`,
      { name },
    );
    return {
      status: "deferred",
      reason: `/${name} could not be removed from Discord yet; the next full reconcile removes it`,
    };
  }
  return { status: "removed" };
}

/**
 * The whole switch — reading the login, the stale check, the namespace
 * check, every Discord call and the store — inside the reconcile lock
 * (taken after the behavior write lock, like every command write), so
 * nothing registers, sweeps or reconciles in between. Without a
 * reconciler only a message → message change goes through. `loaded`
 * learns the login as it was before the switch, for the audit of a
 * switch that fails.
 */
async function switchLoginTrigger(
  deps: SystemLoginTriggerDeps,
  next: LoginTrigger,
  ifUpdatedAt: string | undefined,
  loaded: (current: SystemLoginEntry) => void,
): Promise<RegistrationReport | null> {
  const run = async (locked: LockedRegistration | null) => {
    const current = await loadSystemLogin();
    checkNotStale(versionOf(current), ifUpdatedAt, "the system login");
    loaded(current);
    if (next.kind === "command") {
      if (!deps.namespace) throw new Error("CommandNamespace not provided to behavior routes");
      return switchToCommand(deps.namespace, locked, current, next);
    }
    return switchToMessage(locked, current, next);
  };
  return deps.reconciler ? deps.reconciler.withRegistrationLock(run) : run(null);
}

/** A switch that failed after it started → what the audit records of it (null: not audited). */
function failureOutcome(err: unknown): Record<string, unknown> | null {
  if (err instanceof LoginStoreFailed) {
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

async function systemView(): Promise<BehaviorListView["system"]> {
  const catalog = await loadBehaviorCatalog();
  const ids = [
    ...catalog.messageTriggers.map((t) => t.id),
    ...catalog.commands.flatMap((c) => c.leaves.map((l) => l.id)),
  ];
  return buildBehaviorListView(catalog, await findStatsBulk(ids)).system;
}

export function registerSystemLoginTriggerRoute(
  server: FastifyInstance,
  deps: SystemLoginTriggerDeps,
): void {
  server.put(
    "/api/behaviors/system/login/trigger",
    {
      schema: { body: loginTriggerSchema },
      // before the body is validated: only an owner may touch the login,
      // and a caller who is not one learns nothing about its shape
      preValidation: async (request, reply) => {
        if (!requireOwner(request, reply, deps.ownerIds, "change the login trigger")) return reply;
      },
    },
    async (request, reply) => {
      const body = request.body as LoginTriggerBody;
      const next = loginTriggerOf(body);

      /** The login as it was before the switch, once the switch read it. */
      const seen: { login: SystemLoginEntry | null } = { login: null };
      const audit = (from: SystemLoginEntry, result: Record<string, unknown>) =>
        auditBehaviorWrite(request, "behavior.system.trigger", `behavior:${from.row.id}`, {
          from: storedSummary(from),
          to: { ...next },
          ...result,
        });

      let registration: RegistrationReport | null;
      try {
        registration = await withBehaviorWriteLock(() =>
          switchLoginTrigger(deps, next, body.ifUpdatedAt, (login) => (seen.login = login)),
        );
      } catch (err) {
        const failure = failureOutcome(err);
        if (seen.login && failure) await audit(seen.login, failure);
        throw err instanceof LoginStoreFailed ? err.cause : err;
      }

      await audit(seen.login!, { outcome: "switched", registration: registration?.status ?? null });
      return reply.send({ system: await systemView(), registration });
    },
  );
}
