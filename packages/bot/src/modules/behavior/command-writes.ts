/**
 * What the command write routes share (behavior-command-routes.ts,
 * command-leaf-writes.ts): the shapes a command / leaf write takes and
 * their tree-rule forms, the row loads, the namespace check every command
 * write makes, the response view, and inserting a leaf.
 */

import { UniqueConstraintError, type Transaction } from "sequelize";
import type { NamespaceCheck } from "../command-system/command-namespace.js";
import { BehaviorApiError } from "./behavior-api-error.js";
import { loadBehaviorCatalog } from "./behavior-catalog.js";
import { commandView, type CommandView } from "./behavior-list-view.js";
import type { CommandNamespaceChecker, RegisteredName } from "./command-registration-sync.js";
import {
  RESERVED_COMMAND_NAMES,
  type CommandSettings,
  type LeafShape,
} from "./command-tree-rules.js";
import {
  BehaviorCommand,
  rowOfBehaviorCommand,
  type BehaviorCommandRow,
} from "./models/behavior-command.model.js";
import {
  BehaviorDefinition,
  parseLeafOptions,
  rowOfBehaviorDefinition,
  type BehaviorCommandOption,
} from "./models/behavior-definition.model.js";
import { BehaviorWebhookAction } from "./models/behavior-webhook-action.model.js";
import { findStatsBulk } from "./models/behavior-stats.model.js";
import type { WebhookInput, WebhookWrite } from "./webhook-action-input.js";

export interface OptionInput {
  type: BehaviorCommandOption["type"];
  name: string;
  description: string;
  required?: boolean;
}

export interface LeafInput {
  subcommand?: string;
  title: string;
  description?: string;
  enabled?: boolean;
  leafDescription?: string | null;
  options?: OptionInput[];
  webhook: WebhookInput;
}

export function normalizeOptions(options: OptionInput[] | undefined): BehaviorCommandOption[] {
  return (options ?? []).map((o) => ({
    type: o.type,
    name: o.name,
    description: o.description.trim(),
    required: o.required ?? false,
  }));
}

export function leafShapeOf(input: LeafInput): LeafShape {
  return {
    subcommand: input.subcommand ?? "",
    title: input.title.trim(),
    leafDescription: input.leafDescription?.trim() ?? null,
    options: normalizeOptions(input.options),
  };
}

export function settingsOf(command: BehaviorCommandRow): CommandSettings {
  return {
    name: command.name,
    description: command.description,
    registration: command.registration,
    guildId: command.guildId,
    integrationTypes: command.integrationTypes.split(","),
    contexts: command.contexts.split(","),
  };
}

export async function loadCommandRow(id: number): Promise<BehaviorCommandRow> {
  const model = await BehaviorCommand.findByPk(id);
  if (!model) throw new BehaviorApiError("not_found", `command ${id} does not exist`);
  return rowOfBehaviorCommand(model);
}

/** The leaves of a command as tree-rule shapes, in leaf order. */
export async function storedLeafShapes(
  commandId: number,
): Promise<Array<LeafShape & { id: number }>> {
  const rows = await BehaviorDefinition.findAll({
    where: { commandId },
    order: [
      ["sortOrder", "ASC"],
      ["id", "ASC"],
    ],
  });
  return rows.map((m) => {
    const row = rowOfBehaviorDefinition(m);
    return {
      id: row.id,
      subcommand: row.subcommand ?? "",
      title: row.title,
      leafDescription: row.leafDescription,
      options: parseLeafOptions(row.options) ?? [],
    };
  });
}

function describeOwner(conflict: Extract<NamespaceCheck, { ok: false }>["conflict"]): string {
  const where = conflict.target === "global" ? "globally" : `in ${conflict.target}`;
  switch (conflict.owner.kind) {
    case "builtin":
      return `a built-in command (${where})`;
    case "plugin_command":
      return `a command of plugin #${conflict.owner.pluginId} (${where})`;
    case "behavior_command":
      return `behavior command #${conflict.owner.commandId} (${where})`;
  }
}

/** Save-time half of #96: the name must be free where it will be registered. */
export async function checkNameFree(
  namespace: CommandNamespaceChecker,
  at: RegisteredName,
  ownCommandId: number | null,
): Promise<void> {
  if (RESERVED_COMMAND_NAMES.has(at.name)) {
    throw new BehaviorApiError(
      "name_conflict",
      `/${at.name} is reserved for the system login`,
      "name",
    );
  }
  const verdict = await namespace.check(
    at.name,
    at.target,
    ownCommandId !== null ? { commandId: ownCommandId } : undefined,
  );
  if (!verdict.ok) {
    throw new BehaviorApiError(
      "name_conflict",
      `/${at.name} is already taken by ${describeOwner(verdict.conflict)}`,
      "name",
    );
  }
}

/** A unique index caught what the namespace check could not (a race). */
export function asNameConflict(err: unknown, name: string): never {
  if (err instanceof UniqueConstraintError) {
    throw new BehaviorApiError("name_conflict", `/${name} is already taken`, "name");
  }
  throw err;
}

export async function commandViewOf(id: number): Promise<CommandView> {
  const catalog = await loadBehaviorCatalog();
  const command = catalog.commands.find((c) => c.id === id);
  if (!command) throw new BehaviorApiError("not_found", `command ${id} does not exist`);
  return commandView(command, await findStatsBulk(command.leaves.map((l) => l.id)));
}

/** Insert one leaf (with its webhook action) under `commandId`. */
export async function insertLeaf(
  commandId: number,
  input: LeafInput,
  webhook: WebhookWrite,
  sortOrder: number,
  transaction: Transaction,
): Promise<number> {
  const shape = leafShapeOf(input);
  const row = await BehaviorDefinition.create(
    {
      title: shape.title,
      description: input.description?.trim() ?? "",
      enabled: input.enabled ?? true,
      sortOrder,
      systemKey: null,
      triggerKind: "command",
      actionSource: "webhook",
      commandId,
      subcommandGroup: "",
      subcommand: shape.subcommand,
      leafDescription: shape.leafDescription,
      options: shape.options.length > 0 ? JSON.stringify(shape.options) : null,
      surface: null,
      guildId: null,
      channelId: null,
      patternKind: null,
      patternValue: null,
      audienceKind: "all",
      audienceUserId: null,
      audienceGroupName: null,
    },
    { transaction },
  );
  const behaviorId = row.getDataValue("id") as number;
  await BehaviorWebhookAction.create({ behaviorId, ...webhook.values }, { transaction });
  return behaviorId;
}
