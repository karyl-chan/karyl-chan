/**
 * POST /api/behaviors/:id/convert-trigger (#172) — a custom behavior
 * changes its kind of trigger: a Message Trigger becomes a Command Leaf,
 * or a leaf becomes a Message Trigger. The behavior keeps its row, so its
 * id, title, note, enabled flag, action — a webhook (URL, secret, a
 * previous secret still in its rotation grace) or a plugin action binding
 * (#203) — statistics and delivery log stay as they are; the receiver
 * keeps verifying with the same secret. What only the
 * old trigger had goes: a pattern, its location, position and stop flag;
 * a leaf's path and options.
 *
 *   to a command (`to: "command"`) — the new trigger first, as for the
 *   system login's switch (system-login-trigger-route.ts):
 *     1. the target is a new command (the behavior becomes its root leaf)
 *        or an existing command that already has subcommands (one more
 *        subcommand). A command whose one leaf is its root takes
 *        convert-to-subcommands first: Discord does not let a root leaf
 *        and subcommands coexist.
 *     2. Discord's rules (command-tree-rules.ts) and the shared namespace —
 *        builtin, plugin and behavior commands — are checked
 *     3. holding the reconcile lock (withRegistrationLock), the command is
 *        registered on Discord as it will be stored; refused, or the bot
 *        not connected → 502 registration_failed, the message trigger
 *        untouched
 *     4. only then is the row changed (one transaction; a new command row
 *        with it). The store failing takes the registration back; when
 *        that fails too, the attempt is audited (`outcome: store_failed`).
 *     Steps 3–4 are the register-first flow of command-register-first.ts,
 *     shared with the system login's switch.
 *     A disabled behavior changes nothing Discord shows: with no enabled
 *     leaf on the command it is stored without a registration (`removed`).
 *   to a message (`to: "message"`) — stored first:
 *     1. the row becomes the Message Trigger at `location`, last in the
 *        matching order; its command loses the leaf, and is deleted in the
 *        same transaction when that was its last one
 *     2. the command is reconciled: registered again without the leaf, or
 *        removed from Discord. A refusal does not undo the conversion (the
 *        message trigger already works): it is reported as
 *        `registration.status: "failed"`, and Discord keeps showing the
 *        old leaf until the command is resynced.
 *
 * The system login is refused (409 system_immutable): its trigger switch
 * is PUT /api/behaviors/system/login/trigger. Audited as
 * `behavior.trigger.convert` with `from`, `to` and the target command —
 * never the webhook's URL or secret.
 */

import type { FastifyInstance } from "fastify";
import type { Transaction } from "sequelize";
import type { LockedRegistration } from "../command-system/reconcile.service.js";
import type { TargetOutcome } from "../command-system/types.js";
import { BehaviorApiError } from "./behavior-api-error.js";
import { auditBehaviorWrite } from "./behavior-audit.js";
import {
  loadBehaviorCatalog,
  type CatalogBehavior,
  type CatalogCommand,
} from "./behavior-catalog.js";
import {
  behaviorCommonFields,
  commandFields,
  commandLeafFields,
  commandNameSchema,
  idParams,
  ifUpdatedAtSchema,
  messageTriggerFields,
  parseRowId,
} from "./behavior-schemas.js";
import {
  checkNotStale,
  loadBehaviorRow,
  refuseFixedRow,
  refuseSystemCommand,
} from "./behavior-write-guards.js";
import { behaviorTransaction, withBehaviorWriteLock } from "./behavior-write-lock.js";
import {
  StoredAfterRegistrationFailed,
  commandColumnsOf,
  leafColumnsOf,
  proposedCommand,
  registerThenStore,
  type CommandRowSettings,
} from "./command-register-first.js";
import {
  registerCommandWrite,
  registeredNameOf,
  releaseDeletedCommand,
  type BehaviorCommandRegistrar,
  type CommandNamespaceChecker,
  type RegisteredName,
  type RegistrationReport,
} from "./command-registration-sync.js";
import { checkCommandSettings, checkCommandTree, type LeafShape } from "./command-tree-rules.js";
import {
  asNameConflict,
  checkNameFree,
  commandViewOf,
  loadCommandRow,
  settingsOf,
  storedLeafShapes,
} from "./command-writes.js";
import {
  MESSAGE_TRIGGER_LOCATION_PATTERN,
  checkMessageTrigger,
  messageTriggerLocation,
  parseMessageTriggerLocation,
  type MessageTriggerState,
} from "./message-trigger-rules.js";
import { messageTriggerViewOf, nextMessageSortOrder } from "./message-trigger-writes.js";
import { BehaviorCommand } from "./models/behavior-command.model.js";
import {
  BehaviorDefinition,
  type BehaviorDefinitionRow,
  type BehaviorPatternKind,
  type BehaviorAudienceKind,
  type ReplyVisibility,
} from "./models/behavior-definition.model.js";
import { pruneUnusedGroupMembers } from "./models/behavior-group-member.model.js";
import type { SystemLoginRegistrar } from "./system-login-trigger-route.js";

export interface TriggerConvertDeps {
  /** Registers before the store (to a command) and reconciles after it (to a message). */
  reconciler?: BehaviorCommandRegistrar & SystemLoginRegistrar;
  /** The shared Discord command namespace; required to convert to a new command. */
  namespace?: CommandNamespaceChecker;
}

/**
 * What a conversion did on Discord: a command write's report, or — to a
 * message only, where the conversion stands — Discord's refusal of the
 * command left behind.
 */
export type ConvertRegistration =
  | RegistrationReport
  | { status: "failed"; reason: string; targets: TargetOutcome[] };

// ── shapes ──────────────────────────────────────────────────────────────────

interface NewCommandInput {
  name: string;
  /** Defaults to the behavior's title. */
  description?: string;
  registration: "global" | "guild";
  guildId?: string | null;
  integrationTypes: string[];
  contexts: string[];
  defaultMemberPermissions?: string | null;
}

type CommandTargetInput = { new: NewCommandInput } | { existingId: number; subcommandName: string };

interface ConvertBody {
  to: "command" | "message";
  ifUpdatedAt: string;
  // to a command
  command?: CommandTargetInput;
  leafDescription?: string | null;
  // both: defaults to the stored one
  replyVisibility?: ReplyVisibility | null;
  // to a message
  location?: string;
  patternKind?: BehaviorPatternKind;
  patternValue?: string;
  stopOnMatch?: boolean;
  ignoreBots?: boolean;
  audienceKind?: BehaviorAudienceKind;
  audienceUserId?: string | null;
  audienceGroupName?: string | null;
}

const COMMAND_FIELDS = ["command", "leafDescription"] as const;
const MESSAGE_FIELDS = [
  "location",
  "patternKind",
  "patternValue",
  "stopOnMatch",
  "ignoreBots",
  "audienceKind",
  "audienceUserId",
  "audienceGroupName",
] as const;

/**
 * The body — also served by GET /api/behaviors/schema, so the conversion
 * dialogs check a draft against the rules this route enforces. One flat
 * object for both directions; the handler refuses the other direction's
 * fields.
 */
export const convertTriggerSchema = {
  type: "object",
  properties: {
    to: { enum: ["command", "message"] },
    ifUpdatedAt: ifUpdatedAtSchema,
    command: {
      anyOf: [
        {
          type: "object",
          properties: {
            new: {
              type: "object",
              properties: { ...commandFields },
              required: ["name", "registration", "integrationTypes", "contexts"],
              additionalProperties: false,
            },
          },
          required: ["new"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            existingId: { type: "integer", minimum: 1 },
            subcommandName: commandNameSchema,
          },
          required: ["existingId", "subcommandName"],
          additionalProperties: false,
        },
      ],
    },
    leafDescription: commandLeafFields.leafDescription,
    replyVisibility: behaviorCommonFields.replyVisibility,
    location: { type: "string", pattern: MESSAGE_TRIGGER_LOCATION_PATTERN },
    patternKind: messageTriggerFields.patternKind,
    patternValue: messageTriggerFields.patternValue,
    stopOnMatch: messageTriggerFields.stopOnMatch,
    ignoreBots: messageTriggerFields.ignoreBots,
    audienceKind: messageTriggerFields.audienceKind,
    audienceUserId: messageTriggerFields.audienceUserId,
    audienceGroupName: messageTriggerFields.audienceGroupName,
  },
  required: ["to", "ifUpdatedAt"],
  additionalProperties: false,
} as const;

// ── helpers ─────────────────────────────────────────────────────────────────

function refuse(field: string, message: string): never {
  throw new BehaviorApiError("validation_failed", message, field);
}

/** A field of the other direction in the body → validation_failed. */
function refuseOtherDirectionFields(body: ConvertBody, fields: readonly string[]): void {
  const foreign = fields.find((k) => body[k as keyof ConvertBody] !== undefined);
  if (foreign !== undefined) refuse(foreign, `${foreign} does not apply when converting to a ${body.to} trigger`);
}

/** The reply visibility the converted behavior keeps: the body's, else the stored one. */
function replyVisibilityOf(body: ConvertBody, row: BehaviorDefinitionRow): ReplyVisibility | null {
  return body.replyVisibility !== undefined ? body.replyVisibility : row.replyVisibility;
}

/** Run a check whose refusals name the target's own fields, naming them under `command.` (+ `prefix`). */
async function underCommandField<T>(prefix: string, check: () => T | Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (err) {
    if (err instanceof BehaviorApiError && err.field !== undefined) {
      const field = ["command", prefix, err.field].filter(Boolean).join(".");
      throw new BehaviorApiError(err.code, err.message, field, err.details);
    }
    throw err;
  }
}

function locationOf(row: BehaviorDefinitionRow): string {
  return messageTriggerLocation({
    surface: row.surface ?? "bot_dm",
    guildId: row.guildId,
    channelId: row.channelId,
  });
}

/** The behavior's columns as a message trigger; the leaf fields go. */
function messageColumnsOf(
  state: MessageTriggerState,
  stopOnMatch: boolean,
  sortOrder: number,
  replyVisibility: ReplyVisibility | null,
) {
  return {
    triggerKind: "message" as const,
    commandId: null,
    subcommandGroup: null,
    subcommand: null,
    leafDescription: null,
    options: null,
    sortOrder,
    stopOnMatch,
    replyVisibility,
    ...state,
  };
}

// ── to a command ────────────────────────────────────────────────────────────

/** Where the behavior goes: a new command (no row yet), or an existing one. */
interface CommandTarget {
  existing: CatalogCommand | null;
  settings: CommandRowSettings;
  leaf: LeafShape;
  sortOrder: number;
  at: RegisteredName;
}

async function planCommandTarget(
  namespace: () => CommandNamespaceChecker,
  row: BehaviorDefinitionRow,
  input: CommandTargetInput,
  leafDescription: string | null,
): Promise<CommandTarget> {
  if ("new" in input) {
    const n = input.new;
    const settings: CommandRowSettings = {
      name: n.name,
      description: (n.description ?? row.title).trim(),
      registration: n.registration,
      guildId: n.guildId ?? null,
      integrationTypes: n.integrationTypes,
      contexts: n.contexts,
      defaultMemberPermissions: n.defaultMemberPermissions ?? null,
    };
    const leaf: LeafShape = { subcommand: "", title: row.title, leafDescription, options: [] };
    const at = registeredNameOf(settings);
    await underCommandField("new", async () => {
      checkCommandSettings(settings);
      checkCommandTree(settings, [leaf], () => "");
      await checkNameFree(namespace(), at, null);
    });
    return { existing: null, settings, leaf, sortOrder: 0, at };
  }

  const command = (await loadBehaviorCatalog()).commands.find((c) => c.id === input.existingId);
  if (!command) {
    throw new BehaviorApiError("not_found", `command ${input.existingId} does not exist`, "command.existingId");
  }
  refuseSystemCommand(command);
  const stored = await storedLeafShapes(command.id);
  const leaf: LeafShape = { subcommand: input.subcommandName, title: row.title, leafDescription, options: [] };
  await underCommandField("", () => {
    if (stored.some((l) => l.subcommand === "")) {
      throw new BehaviorApiError(
        "invalid_tree",
        `/${command.name} has no subcommands yet, and its root leaf cannot coexist with one: convert it to subcommands first (POST /api/behavior-commands/${command.id}/convert-to-subcommands)`,
        "existingId",
      );
    }
    if (stored.some((l) => l.subcommand === input.subcommandName)) {
      throw new BehaviorApiError(
        "invalid_tree",
        `subcommand '${input.subcommandName}' already exists`,
        "subcommandName",
      );
    }
    checkCommandTree(command, [...stored, leaf], (i) => (i === stored.length ? "" : "leaves"));
  });
  return {
    existing: command,
    settings: { ...settingsOf(command), defaultMemberPermissions: command.defaultMemberPermissions },
    leaf,
    sortOrder: Math.max(-1, ...command.leaves.map((l) => l.sortOrder)) + 1,
    at: registeredNameOf(command),
  };
}

/** The behavior's columns as the target's leaf. */
function targetLeafColumnsOf(
  commandId: number,
  target: CommandTarget,
  replyVisibility: ReplyVisibility | null,
) {
  return { ...leafColumnsOf(commandId, target.leaf), sortOrder: target.sortOrder, replyVisibility };
}

/** The command as the conversion will store it — registered before it is. */
function proposedTargetCommand(
  behavior: CatalogBehavior,
  target: CommandTarget,
  replyVisibility: ReplyVisibility | null,
): CatalogCommand {
  const id = target.existing?.id ?? 0;
  const leaf: CatalogBehavior = { ...behavior, ...targetLeafColumnsOf(id, target, replyVisibility) };
  return target.existing
    ? { ...target.existing, leaves: [...target.existing.leaves, leaf] }
    : proposedCommand(id, target.settings, false, [leaf]);
}

async function storeAsLeaf(
  row: BehaviorDefinitionRow,
  target: CommandTarget,
  replyVisibility: ReplyVisibility | null,
  transaction: Transaction,
): Promise<number> {
  let commandId = target.existing?.id;
  if (commandId === undefined) {
    const command = await BehaviorCommand.create(commandColumnsOf(target.settings, false), {
      transaction,
    }).catch((err: unknown) => asNameConflict(err, target.settings.name));
    commandId = command.getDataValue("id") as number;
  }
  // instance save: the model's cross-field validator needs every field
  const model = await BehaviorDefinition.findByPk(row.id, { transaction });
  model!.set(targetLeafColumnsOf(commandId, target, replyVisibility));
  await model!.save({ transaction });
  // the last trigger leaving a group takes its member list along (#137)
  if (row.audienceGroupName !== null) await pruneUnusedGroupMembers(transaction);
  return commandId;
}

interface ToCommand {
  commandId: number;
  target: CommandTarget;
  registration: RegistrationReport;
}

const KEEPS_MESSAGE_TRIGGER = "the behavior keeps its message trigger";

/** `seen` learns the target once it is planned, for the audit of a store that failed. */
async function convertToCommand(
  deps: TriggerConvertDeps,
  row: BehaviorDefinitionRow,
  body: ConvertBody,
  seen: (target: CommandTarget) => void,
): Promise<ToCommand> {
  refuseOtherDirectionFields(body, MESSAGE_FIELDS);
  if (body.command === undefined) {
    refuse("command", "command is required: a new command, or an existing command with subcommands");
  }
  const input = body.command;
  const namespace = () => {
    if (!deps.namespace) throw new Error("CommandNamespace not provided to behavior routes");
    return deps.namespace;
  };
  const leafDescription = body.leafDescription?.trim() ?? null;
  const replyVisibility = replyVisibilityOf(body, row);

  // the checks, every Discord call and the store inside the reconcile lock,
  // so no reconcileAll sweeps the registration before its row exists
  const run = async (locked: LockedRegistration | null): Promise<ToCommand> => {
    const target = await planCommandTarget(namespace, row, input, leafDescription);
    seen(target);
    const behavior = (await loadBehaviorCatalog()).messageTriggers.find((b) => b.id === row.id)!;
    const proposed = proposedTargetCommand(behavior, target, replyVisibility);
    const store = () =>
      behaviorTransaction((transaction) => storeAsLeaf(row, target, replyVisibility, transaction));

    // a disabled behavior on a command with no enabled leaf: nothing for Discord
    if (!proposed.leaves.some((l) => l.enabled)) {
      return { commandId: await store(), target, registration: { status: "removed" } };
    }
    if (!locked) {
      throw new BehaviorApiError(
        "registration_failed",
        `no command reconciler in this process; ${KEEPS_MESSAGE_TRIGGER}`,
        undefined,
        { targets: [] },
      );
    }
    const stored = target.existing;
    const { value: commandId, outcomes } = await registerThenStore(locked, {
      proposed,
      at: target.at,
      keeps: KEEPS_MESSAGE_TRIGGER,
      // Discord shows the existing command as stored again, or nothing under a new name
      restore: stored && stored.leaves.some((l) => l.enabled) ? stored : null,
      takeBackFailed: `behavior trigger convert: storing the conversion to /${target.at.name} failed and its registration could not be taken back; the next full reconcile restores Discord to the stored commands`,
      store,
    });
    return { commandId, target, registration: { status: "registered", targets: outcomes } };
  };
  return deps.reconciler ? deps.reconciler.withRegistrationLock(run) : run(null);
}

// ── to a message ────────────────────────────────────────────────────────────

/** The command the leaf left, registered again; a refusal is reported, not thrown — the conversion stands. */
async function reconcileLeftCommand(
  registrar: BehaviorCommandRegistrar | undefined,
  commandId: number,
  at: RegisteredName,
): Promise<ConvertRegistration> {
  try {
    return await registerCommandWrite(registrar, commandId, at, null, null);
  } catch (err) {
    if (err instanceof BehaviorApiError && err.code === "registration_failed") {
      const targets = (err.details as { targets?: TargetOutcome[] } | undefined)?.targets ?? [];
      return {
        status: "failed",
        reason: `${err.message}; the behavior is a message trigger now, but Discord shows it under /${at.name} until the command is resynced`,
        targets,
      };
    }
    throw err;
  }
}

interface ToMessage {
  state: MessageTriggerState;
  command: { id: number; name: string; removed: boolean };
  registration: ConvertRegistration;
}

async function convertToMessage(
  registrar: BehaviorCommandRegistrar | undefined,
  row: BehaviorDefinitionRow,
  body: ConvertBody,
): Promise<ToMessage> {
  refuseOtherDirectionFields(body, COMMAND_FIELDS);
  if (body.location === undefined) refuse("location", "location is required");
  if (body.patternKind === undefined) refuse("patternKind", "patternKind is required");
  if (body.patternValue === undefined) refuse("patternValue", "patternValue is required");

  const command = await loadCommandRow(row.commandId!);
  refuseSystemCommand(command);
  const state: MessageTriggerState = {
    ...parseMessageTriggerLocation(body.location),
    patternKind: body.patternKind,
    patternValue: body.patternValue,
    ignoreBots: body.ignoreBots ?? true,
    audienceKind: body.audienceKind ?? "all",
    audienceUserId: body.audienceUserId ?? null,
    audienceGroupName: body.audienceGroupName ?? null,
  };
  checkMessageTrigger(state);
  let replyVisibility = replyVisibilityOf(body, row);
  if (state.surface === "bot_dm") {
    if (body.replyVisibility != null) {
      refuse("replyVisibility", "the reply in a DM with the bot is the DM; replyVisibility does not apply there");
    }
    replyVisibility = null;
  }
  const last = (await storedLeafShapes(command.id)).length === 1;

  await behaviorTransaction(async (transaction) => {
    const model = await BehaviorDefinition.findByPk(row.id, { transaction });
    model!.set(
      messageColumnsOf(state, body.stopOnMatch ?? false, await nextMessageSortOrder(transaction), replyVisibility),
    );
    await model!.save({ transaction });
    // the row has left the command; with no leaf left the command goes too
    if (last) await BehaviorCommand.destroy({ where: { id: command.id }, transaction });
  });

  const at = registeredNameOf(command);
  const registration = last
    ? await releaseDeletedCommand(registrar, at)
    : await reconcileLeftCommand(registrar, command.id, at);
  return { state, command: { id: command.id, name: command.name, removed: last }, registration };
}

// ── the route ───────────────────────────────────────────────────────────────

/** The audit's view of a target command: where the behavior goes (no secret, no URL). */
function targetSummary(target: CommandTarget, commandId: number | null): Record<string, unknown> {
  return {
    kind: "command",
    commandId,
    name: target.at.name,
    subcommand: target.leaf.subcommand,
    target: target.at.target,
    created: target.existing === null,
  };
}

export function registerTriggerConvertRoute(
  server: FastifyInstance,
  deps: TriggerConvertDeps,
): void {
  server.post(
    "/api/behaviors/:id/convert-trigger",
    { schema: { params: idParams, body: convertTriggerSchema } },
    async (request, reply) => {
      const id = parseRowId(request.params);
      const body = request.body as ConvertBody;
      const audit = (context: Record<string, unknown>) =>
        auditBehaviorWrite(request, "behavior.trigger.convert", `behavior:${id}`, context);

      /** What the conversion had learnt when it failed: where it came from and where it was going. */
      const seen: { from: Record<string, unknown> | null; target: CommandTarget | null } = {
        from: null,
        target: null,
      };
      let result: { toCommand?: ToCommand; toMessage?: ToMessage };
      try {
        result = await withBehaviorWriteLock(async () => {
          const row = await loadBehaviorRow(id);
          refuseFixedRow(row);
          checkNotStale(row, body.ifUpdatedAt, `behavior ${id}`);
          if (row.triggerKind === body.to) {
            refuse("to", `behavior ${id} already has a ${body.to} trigger`);
          }
          seen.from =
            row.triggerKind === "message"
              ? {
                  kind: "message",
                  location: locationOf(row),
                  patternKind: row.patternKind,
                  patternValue: row.patternValue,
                }
              : { kind: "command", commandId: row.commandId, subcommand: row.subcommand ?? "" };
          if (body.to === "command") {
            return { toCommand: await convertToCommand(deps, row, body, (t) => (seen.target = t)) };
          }
          return { toMessage: await convertToMessage(deps.reconciler, row, body) };
        });
      } catch (err) {
        if (!(err instanceof StoredAfterRegistrationFailed)) throw err;
        // Discord kept a command the DB does not hold: that must be on the trail
        if (!err.takenBack && seen.from && seen.target) {
          await audit({
            from: seen.from,
            to: targetSummary(seen.target, seen.target.existing?.id ?? null),
            outcome: "store_failed",
            registrationTakenBack: false,
            error: err.message,
          });
        }
        throw err.cause;
      }

      if (result.toCommand) {
        const { commandId, target, registration } = result.toCommand;
        await audit({
          from: seen.from,
          to: targetSummary(target, commandId),
          registration: registration.status,
        });
        const command = await commandViewOf(commandId);
        return reply.send({
          behavior: command.leaves.find((l) => l.id === id),
          command,
          registration,
        });
      }

      const { state, command, registration } = result.toMessage!;
      await audit({
        from: { ...seen.from, name: command.name },
        to: {
          kind: "message",
          location: messageTriggerLocation(state),
          patternKind: state.patternKind,
          patternValue: state.patternValue,
        },
        commandRemoved: command.removed,
        registration: registration.status,
      });
      return reply.send({ behavior: await messageTriggerViewOf(id), registration });
    },
  );
}
