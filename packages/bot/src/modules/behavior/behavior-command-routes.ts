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
 * (command-registration-sync.ts). The system login's command is immutable
 * here — its trigger switch is system-login-trigger-route.ts — but can be
 * resynced (re-registered as stored, e.g. after Discord lost it) — by a
 * bot owner only, like the switch.
 */

import type { FastifyInstance } from "fastify";
import { sortJoin } from "../../utils/sort-join.js";
import { requireOwner } from "../web-core/route-guards.js";
import { BehaviorApiError } from "./behavior-api-error.js";
import { auditBehaviorWrite } from "./behavior-audit.js";
import {
  behaviorCommonFields,
  commandFields,
  commandLeafFields,
  commandNameSchema,
  idParams,
  ifUpdatedAtSchema,
  parseRowId,
  subcommandSchema,
} from "./behavior-schemas.js";
import { changedFields, checkNotStale, refuseSystemCommand } from "./behavior-write-guards.js";
import { behaviorTransaction, withBehaviorWriteLock } from "./behavior-write-lock.js";
import {
  registerCommandWrite,
  registeredNameOf,
  releaseDeletedCommand,
  rewriteCommand,
  type BehaviorCommandRegistrar,
  type CommandNamespaceChecker,
} from "./command-registration-sync.js";
import { destroyCommandRows } from "./command-snapshot.js";
import {
  checkCommandSettings,
  checkCommandTree,
  type CommandSettings,
} from "./command-tree-rules.js";
import {
  asNameConflict,
  checkNameFree,
  commandViewOf,
  insertLeaf,
  leafShapeOf,
  loadCommandRow,
  settingsOf,
  storedLeafShapes,
  type LeafInput,
} from "./command-writes.js";
import { BehaviorCommand } from "./models/behavior-command.model.js";
import { BehaviorDefinition } from "./models/behavior-definition.model.js";
import {
  prepareWebhookWrite,
  webhookInputSchema,
  type WebhookWrite,
} from "./webhook-action-input.js";

export interface BehaviorCommandDeps {
  /** Registers behavior commands with Discord; without it registration is deferred. */
  reconciler?: BehaviorCommandRegistrar;
  /** The shared Discord command namespace; required for command writes. */
  namespace?: CommandNamespaceChecker;
  /** Bot owners (tests); production reads BOT_OWNER_IDS. */
  ownerIds?: readonly string[];
}

// ── shapes ──────────────────────────────────────────────────────────────────

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

const leafInputSchema = {
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

/**
 * The create body — also served to the admin UI by GET /api/behaviors/schema,
 * so its command forms check a draft against the rules this route enforces.
 */
export const createCommandSchema = {
  type: "object",
  properties: {
    ...commandFields,
    leaves: { type: "array", minItems: 1, maxItems: 25, items: leafInputSchema },
  },
  required: ["name", "description", "registration", "leaves"],
  additionalProperties: false,
} as const;

/** An added subcommand leaf — served with the create schema. */
export const addLeafSchema = {
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
              integrationTypes: sortJoin([...settings.integrationTypes]),
              contexts: sortJoin([...settings.contexts]),
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
        const at = registeredNameOf(after);
        await checkNameFree(namespace(), at, id);

        const changed = changedFields(before, after);
        const { registration: report } = await rewriteCommand(
          deps.reconciler,
          current,
          async (transaction) => {
            // instance save: the model's cross-field validator needs every field
            const model = await BehaviorCommand.findByPk(id, { transaction });
            model!.set({
              name: after.name,
              description: after.description,
              registration: after.registration,
              guildId: after.guildId,
              integrationTypes: sortJoin([...after.integrationTypes]),
              contexts: sortJoin([...after.contexts]),
              defaultMemberPermissions: after.defaultMemberPermissions,
            });
            await model!
              .save({ transaction })
              .catch((err: unknown) => asNameConflict(err, after.name));
          },
          () => ({
            request,
            action: "behavior.command.update",
            target: `command:${id}`,
            context: { changed },
          }),
          at,
        );
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
        const { value: behaviorId, registration } = await rewriteCommand(
          deps.reconciler,
          command,
          async (transaction) => {
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
          },
          (id) => ({
            request,
            action: "behavior.create",
            target: `behavior:${id}`,
            context: auditContext(webhook.audit),
          }),
        );
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
        const { registration } = await rewriteCommand(
          deps.reconciler,
          command,
          async (transaction) => {
            const model = await BehaviorDefinition.findByPk(root.id, { transaction });
            model!.set({ subcommand: body.subcommand, leafDescription });
            await model!.save({ transaction });
          },
          () => ({
            request,
            action: "behavior.command.convert",
            target: `command:${commandId}`,
            context: { behaviorId: root.id, subcommand: body.subcommand },
          }),
        );
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
      // the login's command: owner only, like its trigger switch
      if ((await loadCommandRow(id)).isSystem && !requireOwner(request, reply, deps.ownerIds, "resync the login command")) {
        return reply;
      }
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
