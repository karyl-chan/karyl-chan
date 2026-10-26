/**
 * Command routes (#136) on /api/behavior-commands — a Command (Discord's
 * unit of registration: name + visibility) and its Command Leaves:
 *
 *   POST   /api/behavior-commands             — create a command with its leaves
 *   PATCH  /api/behavior-commands/:id         — edit name / description / visibility
 *   DELETE /api/behavior-commands/:id         — delete it with its leaves
 *   POST   /api/behavior-commands/:id/resync  — register it again as stored
 *   POST   /api/behavior-commands/:id/leaves  — add a subcommand leaf
 *   POST   /api/behavior-commands/:id/convert-to-subcommands
 *                                             — the root leaf becomes the first subcommand
 *
 * (A leaf is edited / removed through PATCH / DELETE /api/behaviors/:id.)
 *
 * Every write is checked against Discord's rules (command-tree-rules.ts)
 * and the shared command namespace — builtin, plugin and behavior
 * commands; `/login` stays reserved for the system login (#96) — then
 * registered through the reconciler; a refusal restores the previous rows
 * (command-registration-sync.ts). The system command is immutable here.
 */

import type { FastifyInstance } from "fastify";
import { UniqueConstraintError, type Transaction } from "sequelize";
import type { NamespaceCheck } from "../command-system/command-namespace.js";
import { BehaviorApiError } from "./behavior-api-error.js";
import { auditBehaviorWrite } from "./behavior-audit.js";
import { loadBehaviorCatalog } from "./behavior-catalog.js";
import { commandView, type CommandView } from "./behavior-list-view.js";
import {
  behaviorCommonFields,
  commandFields,
  commandLeafFields,
  commandNameSchema,
  idParams,
  ifUpdatedAtSchema,
  parseRowId,
} from "./behavior-schemas.js";
import { changedFields, checkNotStale } from "./behavior-write-guards.js";
import { behaviorTransaction, withBehaviorWriteLock } from "./behavior-write-lock.js";
import {
  registerCommandWrite,
  registeredNameOf,
  releaseDeletedCommand,
  type BehaviorCommandRegistrar,
  type CommandNamespaceChecker,
  type RegisteredName,
} from "./command-registration-sync.js";
import { destroyCommandRows, snapshotCommand } from "./command-snapshot.js";
import {
  checkCommandSettings,
  checkCommandTree,
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
import {
  prepareWebhookWrite,
  webhookInputSchema,
  type WebhookInput,
  type WebhookWrite,
} from "./webhook-action-input.js";

export interface BehaviorCommandDeps {
  /** Registers behavior commands with Discord; without it registration is deferred. */
  reconciler?: BehaviorCommandRegistrar;
  /** The shared Discord command namespace; required for command writes. */
  namespace?: CommandNamespaceChecker;
}

// ── shapes ──────────────────────────────────────────────────────────────────

interface OptionInput {
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

interface CommandInput {
  name: string;
  description: string;
  registration: "global" | "guild";
  guildId?: string | null;
  integrationTypes?: string[];
  contexts?: string[];
  defaultMemberPermissions?: string | null;
}

interface CommandCreate extends CommandInput {
  leaves: LeafInput[];
}

type CommandPatch = Partial<CommandInput> & { ifUpdatedAt?: string };

/** '' = the root leaf; otherwise a subcommand name. */
export const subcommandSchema = {
  anyOf: [{ const: "" }, commandNameSchema],
} as const;

export const leafInputSchema = {
  type: "object",
  properties: {
    subcommand: subcommandSchema,
    ...behaviorCommonFields,
    ...commandLeafFields,
    webhook: webhookInputSchema,
  },
  required: ["title", "webhook"],
  additionalProperties: false,
} as const;

const createCommandSchema = {
  type: "object",
  properties: {
    ...commandFields,
    leaves: { type: "array", minItems: 1, maxItems: 25, items: leafInputSchema },
  },
  required: ["name", "description", "registration", "leaves"],
  additionalProperties: false,
} as const;

const addLeafSchema = {
  ...leafInputSchema,
  properties: { ...leafInputSchema.properties, subcommand: commandNameSchema },
  required: ["subcommand", "title", "webhook"],
} as const;

const convertSchema = {
  type: "object",
  properties: {
    subcommand: commandNameSchema,
    leafDescription: commandLeafFields.leafDescription,
  },
  required: ["subcommand"],
  additionalProperties: false,
} as const;

const patchCommandSchema = {
  type: "object",
  properties: { ...commandFields, ifUpdatedAt: ifUpdatedAtSchema },
  minProperties: 1,
  additionalProperties: false,
} as const;

// ── helpers ─────────────────────────────────────────────────────────────────

/** Sorted, comma-joined — how behavior_commands stores the two axes. */
const sortJoin = (values: readonly string[]): string => [...values].sort().join(",");

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

export function refuseSystemCommand(command: { isSystem: boolean }): void {
  if (command.isSystem) {
    throw new BehaviorApiError(
      "system_immutable",
      "the system login command cannot be changed here (its trigger switch comes with #139)",
    );
  }
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

// ── routes ──────────────────────────────────────────────────────────────────

export function registerBehaviorCommandRoutes(
  server: FastifyInstance,
  deps: BehaviorCommandDeps,
): void {
  function namespace(): CommandNamespaceChecker {
    if (!deps.namespace) {
      throw new Error("CommandNamespace not provided to behavior routes");
    }
    return deps.namespace;
  }

  server.post(
    "/api/behavior-commands",
    { schema: { body: createCommandSchema } },
    async (request, reply) => {
      const body = request.body as CommandCreate;
      const settings: CommandSettings = {
        name: body.name,
        description: body.description.trim(),
        registration: body.registration,
        guildId: body.guildId ?? null,
        integrationTypes: body.integrationTypes ?? ["guild_install"],
        contexts: body.contexts ?? ["Guild"],
      };
      checkCommandSettings(settings);
      checkCommandTree(settings, body.leaves.map(leafShapeOf));
      const webhooks = await Promise.all(
        body.leaves.map((leaf, i) => prepareWebhookWrite(leaf.webhook, null, `leaves.${i}.webhook`)),
      );
      const at = registeredNameOf(settings);

      const auditContext = (leafIds: number[]) => ({
        name: settings.name,
        description: settings.description,
        target: at.target,
        integrationTypes: settings.integrationTypes,
        contexts: settings.contexts,
        defaultMemberPermissions: body.defaultMemberPermissions ?? null,
        leaves: body.leaves.map((leaf, i) => ({
          id: leafIds[i],
          subcommand: leaf.subcommand ?? "",
          title: leaf.title.trim(),
          webhook: webhooks[i]!.audit,
        })),
      });

      const { commandId, leafIds, registration } = await withBehaviorWriteLock(async () => {
        await checkNameFree(namespace(), at, null);
        const created = await behaviorTransaction(async (transaction) => {
          const command = await BehaviorCommand.create(
            {
              name: settings.name,
              description: settings.description,
              registration: settings.registration,
              guildId: settings.guildId,
              integrationTypes: sortJoin(settings.integrationTypes),
              contexts: sortJoin(settings.contexts),
              defaultMemberPermissions: body.defaultMemberPermissions ?? null,
              isSystem: false,
            },
            { transaction },
          ).catch((err: unknown) => asNameConflict(err, settings.name));
          const id = command.getDataValue("id") as number;
          const ids: number[] = [];
          for (const [i, leaf] of body.leaves.entries()) {
            ids.push(await insertLeaf(id, leaf, webhooks[i]!, i, transaction));
          }
          return { commandId: id, leafIds: ids };
        });
        const report = await registerCommandWrite(
          deps.reconciler,
          created.commandId,
          at,
          null,
          { commandId: created.commandId, command: null, leaves: [] },
          {
            request,
            action: "behavior.command.create",
            target: `command:${created.commandId}`,
            context: auditContext(created.leafIds),
          },
        );
        return { ...created, registration: report };
      });

      await auditBehaviorWrite(request, "behavior.command.create", `command:${commandId}`, {
        ...auditContext(leafIds),
        registration: registration.status,
      });
      const secrets = body.leaves.flatMap((leaf, i) =>
        webhooks[i]!.issuedSecret !== null
          ? [{ behaviorId: leafIds[i]!, subcommand: leaf.subcommand ?? "", secret: webhooks[i]!.issuedSecret }]
          : [],
      );
      return reply.code(201).send({
        command: await commandViewOf(commandId),
        registration,
        ...(secrets.length > 0 ? { secrets } : {}),
      });
    },
  );

  server.patch(
    "/api/behavior-commands/:id",
    { schema: { params: idParams, body: patchCommandSchema } },
    async (request, reply) => {
      const id = parseRowId(request.params);
      const body = request.body as CommandPatch;

      const { audit, registration } = await withBehaviorWriteLock(async () => {
        const current = await loadCommandRow(id);
        refuseSystemCommand(current);
        checkNotStale(current, body.ifUpdatedAt, `command ${id}`);

        const before = {
          ...settingsOf(current),
          defaultMemberPermissions: current.defaultMemberPermissions,
        };
        const after = { ...before };
        if (body.name !== undefined) after.name = body.name;
        if (body.description !== undefined) after.description = body.description.trim();
        if (body.registration !== undefined) after.registration = body.registration;
        if (body.guildId !== undefined) after.guildId = body.guildId;
        if (body.integrationTypes !== undefined) after.integrationTypes = body.integrationTypes;
        if (body.contexts !== undefined) after.contexts = body.contexts;
        if (body.defaultMemberPermissions !== undefined) {
          after.defaultMemberPermissions = body.defaultMemberPermissions;
        }
        checkCommandSettings(after);
        checkCommandTree(after, await storedLeafShapes(id), () => "leaves");
        const previous = registeredNameOf(current);
        const at = registeredNameOf(after);
        await checkNameFree(namespace(), at, id);

        const snapshot = await snapshotCommand(id);
        await behaviorTransaction(async (transaction) => {
          // instance save: the model's cross-field validator needs every field
          const model = await BehaviorCommand.findByPk(id, { transaction });
          model!.set({
            name: after.name,
            description: after.description,
            registration: after.registration,
            guildId: after.guildId,
            integrationTypes: sortJoin(after.integrationTypes),
            contexts: sortJoin(after.contexts),
            defaultMemberPermissions: after.defaultMemberPermissions,
          });
          await model!.save({ transaction }).catch((err: unknown) => asNameConflict(err, after.name));
        });
        const changed = changedFields(before, after);
        const report = await registerCommandWrite(deps.reconciler, id, at, previous, snapshot, {
          request,
          action: "behavior.command.update",
          target: `command:${id}`,
          context: { changed },
        });
        return {
          registration: report,
          audit: { changed, registration: report.status },
        };
      });

      await auditBehaviorWrite(request, "behavior.command.update", `command:${id}`, audit);
      return reply.send({ command: await commandViewOf(id), registration });
    },
  );

  server.delete(
    "/api/behavior-commands/:id",
    { schema: { params: idParams } },
    async (request, reply) => {
      const id = parseRowId(request.params);
      const { command, registration } = await withBehaviorWriteLock(async () => {
        const current = await loadCommandRow(id);
        refuseSystemCommand(current);
        await behaviorTransaction((transaction) => destroyCommandRows(id, transaction));
        return {
          command: current,
          registration: await releaseDeletedCommand(deps.reconciler, registeredNameOf(current)),
        };
      });
      await auditBehaviorWrite(request, "behavior.command.delete", `command:${id}`, {
        name: command.name,
        target: registeredNameOf(command).target,
        registration: registration.status,
      });
      return reply.send({ registration });
    },
  );

  server.post(
    "/api/behavior-commands/:id/leaves",
    { schema: { params: idParams, body: addLeafSchema } },
    async (request, reply) => {
      const commandId = parseRowId(request.params);
      const body = request.body as LeafInput;
      const auditContext = (webhook: WebhookWrite["audit"]) => ({
        kind: "command_leaf",
        commandId,
        subcommand: body.subcommand,
        title: body.title.trim(),
        webhook,
      });
      const result = await withBehaviorWriteLock(async () => {
        const command = await loadCommandRow(commandId);
        refuseSystemCommand(command);
        const stored = await storedLeafShapes(commandId);
        const shape = leafShapeOf(body);
        checkCommandTree(command, [...stored, shape], (i) =>
          i === stored.length ? "" : "leaves",
        );
        const webhook = await prepareWebhookWrite(body.webhook, null);
        const snapshot = await snapshotCommand(commandId);
        const behaviorId = await behaviorTransaction(async (transaction) => {
          const max = (await BehaviorDefinition.max("sortOrder", {
            where: { commandId },
            transaction,
          })) as number | null;
          return insertLeaf(
            commandId,
            body,
            webhook,
            Number.isFinite(max) ? (max as number) + 1 : 0,
            transaction,
          );
        });
        const at = registeredNameOf(command);
        const registration = await registerCommandWrite(deps.reconciler, commandId, at, at, snapshot, {
          request,
          action: "behavior.create",
          target: `behavior:${behaviorId}`,
          context: auditContext(webhook.audit),
        });
        return { behaviorId, webhook, registration };
      });

      await auditBehaviorWrite(request, "behavior.create", `behavior:${result.behaviorId}`, {
        ...auditContext(result.webhook.audit),
        registration: result.registration.status,
      });
      const command = await commandViewOf(commandId);
      return reply.code(201).send({
        behavior: command.leaves.find((l) => l.id === result.behaviorId),
        command,
        registration: result.registration,
        ...(result.webhook.issuedSecret !== null ? { secret: result.webhook.issuedSecret } : {}),
      });
    },
  );

  server.post(
    "/api/behavior-commands/:id/convert-to-subcommands",
    { schema: { params: idParams, body: convertSchema } },
    async (request, reply) => {
      const commandId = parseRowId(request.params);
      const body = request.body as { subcommand: string; leafDescription?: string | null };
      const result = await withBehaviorWriteLock(async () => {
        const command = await loadCommandRow(commandId);
        refuseSystemCommand(command);
        const stored = await storedLeafShapes(commandId);
        const root = stored.length === 1 && stored[0]!.subcommand === "" ? stored[0]! : null;
        if (!root) {
          throw new BehaviorApiError(
            "invalid_tree",
            "only a command whose single leaf is its root leaf can be converted; this one already has subcommands",
          );
        }
        const leafDescription =
          body.leafDescription !== undefined
            ? (body.leafDescription?.trim() ?? null)
            : root.leafDescription;
        checkCommandTree(command, [{ ...root, subcommand: body.subcommand, leafDescription }], () => "");
        const snapshot = await snapshotCommand(commandId);
        await behaviorTransaction(async (transaction) => {
          const model = await BehaviorDefinition.findByPk(root.id, { transaction });
          model!.set({ subcommand: body.subcommand, leafDescription });
          await model!.save({ transaction });
        });
        const at = registeredNameOf(command);
        const registration = await registerCommandWrite(deps.reconciler, commandId, at, at, snapshot, {
          request,
          action: "behavior.command.convert",
          target: `command:${commandId}`,
          context: { behaviorId: root.id, subcommand: body.subcommand },
        });
        return { behaviorId: root.id, registration };
      });

      await auditBehaviorWrite(request, "behavior.command.convert", `command:${commandId}`, {
        behaviorId: result.behaviorId,
        subcommand: body.subcommand,
        registration: result.registration.status,
      });
      return reply.send({
        command: await commandViewOf(commandId),
        registration: result.registration,
      });
    },
  );

  server.post(
    "/api/behavior-commands/:id/resync",
    { schema: { params: idParams } },
    async (request, reply) => {
      const id = parseRowId(request.params);
      const registration = await withBehaviorWriteLock(async () => {
        const current = await loadCommandRow(id);
        return registerCommandWrite(deps.reconciler, id, registeredNameOf(current), null, null);
      });
      await auditBehaviorWrite(request, "behavior.command.resync", `command:${id}`, {
        registration: registration.status,
      });
      return reply.send({ command: await commandViewOf(id), registration });
    },
  );
}
