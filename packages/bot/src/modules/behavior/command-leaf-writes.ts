/**
 * Command Leaf edits and removals, reached through PATCH / DELETE
 * /api/behaviors/:id when the row is a leaf (behavior-write-routes.ts).
 *
 * A leaf never changes its place in the tree here: the root leaf stays
 * the root and a subcommand stays a subcommand (`convert-to-subcommands`
 * is the one way from root to subcommand). A command keeps at least one
 * leaf — removing the last one is deleting the command.
 *
 * A change Discord sees (enabled, subcommand, leafDescription, options,
 * a subcommand's title as its fallback description) is re-registered and
 * restored when refused (command-registration-sync.ts); a change it does
 * not see (admin note, webhook) is only stored.
 */

import type { FastifyRequest } from "fastify";
import { BehaviorApiError } from "./behavior-api-error.js";
import type { CommandLeafView, CommandView } from "./behavior-list-view.js";
import { changedFields } from "./behavior-write-guards.js";
import { behaviorTransaction } from "./behavior-write-lock.js";
import {
  commandViewOf,
  loadCommandRow,
  normalizeOptions,
  refuseSystemCommand,
  storedLeafShapes,
  type LeafInput,
} from "./behavior-command-routes.js";
import {
  registerCommandWrite,
  registeredNameOf,
  type BehaviorCommandRegistrar,
  type RegistrationReport,
} from "./command-registration-sync.js";
import { snapshotCommand } from "./command-snapshot.js";
import { checkCommandTree, leafDiscordDescription, type LeafShape } from "./command-tree-rules.js";
import {
  BehaviorDefinition,
  type BehaviorDefinitionRow,
} from "./models/behavior-definition.model.js";
import { BehaviorStat } from "./models/behavior-stats.model.js";
import {
  BehaviorWebhookAction,
  rowOfBehaviorWebhookAction,
} from "./models/behavior-webhook-action.model.js";
import { prepareWebhookWrite } from "./webhook-action-input.js";

export type LeafPatch = Partial<Omit<LeafInput, "webhook">> & {
  webhook?: LeafInput["webhook"];
};

export interface LeafWriteResult {
  behavior: CommandLeafView;
  command: CommandView;
  registration?: RegistrationReport;
  secret?: string;
  audit: Record<string, unknown>;
}

function leafOf(command: CommandView, id: number): CommandLeafView {
  const leaf = command.leaves.find((l) => l.id === id);
  if (!leaf) throw new BehaviorApiError("not_found", `behavior ${id} does not exist`);
  return leaf;
}

/** What Discord registers for a leaf; a change here means re-registering. */
function discordFacing(leaf: LeafShape & { enabled: boolean }): string {
  return JSON.stringify([
    leaf.enabled,
    leaf.subcommand,
    leaf.subcommand === "" ? null : leafDiscordDescription(leaf),
    leaf.options,
  ]);
}

export async function patchCommandLeaf(
  registrar: BehaviorCommandRegistrar | undefined,
  request: FastifyRequest,
  row: BehaviorDefinitionRow,
  body: LeafPatch,
): Promise<LeafWriteResult> {
  const commandId = row.commandId!;
  const command = await loadCommandRow(commandId);
  refuseSystemCommand(command);

  const stored = await storedLeafShapes(commandId);
  const index = stored.findIndex((l) => l.id === row.id);
  const current = stored[index]!;
  const next: LeafShape = {
    subcommand: body.subcommand ?? current.subcommand,
    title: body.title?.trim() ?? current.title,
    leafDescription:
      body.leafDescription !== undefined
        ? (body.leafDescription?.trim() ?? null)
        : current.leafDescription,
    options: body.options !== undefined ? normalizeOptions(body.options) : current.options,
  };
  if (
    next.subcommand !== current.subcommand &&
    stored.some((l) => l.subcommand === next.subcommand)
  ) {
    throw new BehaviorApiError(
      "invalid_tree",
      `subcommand '${next.subcommand}' already exists`,
      "subcommand",
    );
  }
  if ((current.subcommand === "") !== (next.subcommand === "")) {
    throw new BehaviorApiError(
      "invalid_tree",
      current.subcommand === ""
        ? "the root leaf becomes a subcommand only through convert-to-subcommands"
        : "a subcommand cannot become the root leaf; a command with subcommands cannot be invoked itself",
      "subcommand",
    );
  }
  checkCommandTree(
    command,
    stored.map((l, i) => (i === index ? next : l)),
    (i) => (i === index ? "" : "leaves"),
  );

  const action = await BehaviorWebhookAction.findByPk(row.id);
  const webhook = body.webhook
    ? await prepareWebhookWrite(body.webhook, action ? rowOfBehaviorWebhookAction(action) : null)
    : null;

  const before = {
    title: row.title,
    description: row.description,
    enabled: row.enabled,
    subcommand: current.subcommand,
    leafDescription: current.leafDescription,
    options: current.options,
  };
  const after = {
    ...before,
    ...next,
    ...(body.description !== undefined ? { description: body.description.trim() } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
  };
  const reregister =
    discordFacing({ ...current, enabled: row.enabled }) !==
    discordFacing({ ...next, enabled: after.enabled });

  const snapshot = reregister ? await snapshotCommand(commandId) : null;
  await behaviorTransaction(async (transaction) => {
    const model = await BehaviorDefinition.findByPk(row.id, { transaction });
    model!.set({
      title: after.title,
      description: after.description,
      enabled: after.enabled,
      subcommand: after.subcommand,
      leafDescription: after.leafDescription,
      options: after.options.length > 0 ? JSON.stringify(after.options) : null,
    });
    await model!.save({ transaction });
    if (webhook) {
      await BehaviorWebhookAction.upsert({ behaviorId: row.id, ...webhook.values }, { transaction });
    }
  });
  const at = registeredNameOf(command);
  const audit = {
    kind: "command_leaf",
    commandId,
    changed: changedFields(before, after),
    ...(webhook ? { webhook: webhook.audit } : {}),
  };
  const registration = reregister
    ? await registerCommandWrite(registrar, commandId, at, at, snapshot, {
        request,
        action: "behavior.update",
        target: `behavior:${row.id}`,
        context: audit,
      })
    : undefined;

  const view = await commandViewOf(commandId);
  return {
    behavior: leafOf(view, row.id),
    command: view,
    ...(registration ? { registration } : {}),
    ...(webhook?.issuedSecret ? { secret: webhook.issuedSecret } : {}),
    audit: {
      ...audit,
      ...(registration ? { registration: registration.status } : {}),
    },
  };
}

export async function deleteCommandLeaf(
  registrar: BehaviorCommandRegistrar | undefined,
  request: FastifyRequest,
  row: BehaviorDefinitionRow,
): Promise<{ registration: RegistrationReport; audit: Record<string, unknown> }> {
  const commandId = row.commandId!;
  const command = await loadCommandRow(commandId);
  refuseSystemCommand(command);
  const stored = await storedLeafShapes(commandId);
  if (stored.length <= 1) {
    throw new BehaviorApiError(
      "invalid_tree",
      "a command needs at least one leaf; delete the command instead",
    );
  }

  const snapshot = await snapshotCommand(commandId);
  await behaviorTransaction(async (transaction) => {
    await BehaviorWebhookAction.destroy({ where: { behaviorId: row.id }, transaction });
    await BehaviorStat.destroy({ where: { behaviorId: row.id }, transaction });
    await BehaviorDefinition.destroy({ where: { id: row.id }, transaction });
  });
  const at = registeredNameOf(command);
  const audit = {
    kind: "command_leaf",
    commandId,
    subcommand: row.subcommand ?? "",
    title: row.title,
  };
  const registration = await registerCommandWrite(registrar, commandId, at, at, snapshot, {
    request,
    action: "behavior.delete",
    target: `behavior:${row.id}`,
    context: audit,
  });
  return { registration, audit: { ...audit, registration: registration.status } };
}
