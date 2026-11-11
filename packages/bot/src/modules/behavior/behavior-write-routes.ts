/**
 * Behavior write routes (#136) on /api/behaviors:
 *
 *   POST   /api/behaviors        — create a Message Trigger
 *   PATCH  /api/behaviors/:id    — edit a Message Trigger or a Command Leaf
 *   DELETE /api/behaviors/:id    — delete a Message Trigger or a Command Leaf
 *
 * Leaves are created under their command (POST
 * /api/behavior-commands/:id/leaves); their edits and removals re-register
 * the command (command-leaf-writes.ts).
 *
 * Registered inside the behavior scope (strict schemas, uniform errors,
 * the behavior.manage gate — see behavior-routes.ts). The System Behavior
 * is immutable here: its trigger switch is system-login-trigger-route.ts.
 * Neither is a Service Behavior (#126): its trigger switch is
 * PUT /api/services/:id/trigger (service-routes.ts).
 */

import type { FastifyInstance } from "fastify";
import { BehaviorApiError } from "./behavior-api-error.js";
import { auditBehaviorWrite } from "./behavior-audit.js";
import {
  behaviorCommonFields,
  commandLeafFields,
  idParams,
  ifUpdatedAtSchema,
  messageTriggerFields,
  parseRowId,
  subcommandSchema,
} from "./behavior-schemas.js";
import { behaviorTransaction, withBehaviorWriteLock } from "./behavior-write-lock.js";
import {
  changedFields,
  checkNotStale,
  loadBehaviorRow,
  refuseFixedRow,
} from "./behavior-write-guards.js";
import { checkMessageTrigger, type MessageTriggerState } from "./message-trigger-rules.js";
import { messageTriggerViewOf, nextMessageSortOrder } from "./message-trigger-writes.js";
import { deleteCommandLeaf, patchCommandLeaf, type LeafPatch } from "./command-leaf-writes.js";
import type { BehaviorCommandRegistrar } from "./command-registration-sync.js";
import {
  BehaviorDefinition,
  type BehaviorDefinitionRow,
  type ReplyVisibility,
} from "./models/behavior-definition.model.js";
import { BehaviorWebhookAction } from "./models/behavior-webhook-action.model.js";
import { destroyPluginActions } from "./models/behavior-plugin-action.model.js";
import { pruneUnusedGroupMembers } from "./models/behavior-group-member.model.js";
import { destroyDmAllowlists } from "./models/behavior-dm-allowlist.model.js";
import { destroyDmLog } from "./behavior-dm-log.js";
import { webhookInputSchema } from "./webhook-action-input.js";
import {
  actionAuditOf,
  issuedSecretOf,
  pluginActionInputSchema,
  prepareActionWrite,
  storeActionWrite,
  type ActionInput,
  type PluginActionCatalog,
} from "./behavior-action-input.js";

// ── shapes ──────────────────────────────────────────────────────────────────

interface MessageTriggerCreate extends Partial<MessageTriggerState>, ActionInput {
  title: string;
  description?: string;
  enabled?: boolean;
  surface: MessageTriggerState["surface"];
  patternKind: MessageTriggerState["patternKind"];
  patternValue: string;
  stopOnMatch?: boolean;
  replyVisibility?: ReplyVisibility | null;
}

type BehaviorPatch = Partial<MessageTriggerCreate> &
  LeafPatch & {
    ifUpdatedAt?: string;
  };

/**
 * The create body — also served to the admin UI by GET /api/behaviors/schema,
 * so the form checks a draft against the very rules this route enforces (#108).
 * The action is `webhook` or `pluginAction`, exactly one (#203): the handler
 * refuses neither or both (behavior-action-input.ts), so the schema
 * requires neither.
 */
export const createMessageTriggerSchema = {
  type: "object",
  properties: {
    ...behaviorCommonFields,
    ...messageTriggerFields,
    webhook: webhookInputSchema,
    pluginAction: pluginActionInputSchema,
  },
  required: ["title", "surface", "patternKind", "patternValue"],
  additionalProperties: false,
} as const;

/** One schema for both kinds; the handler refuses the other kind's fields. */
const patchBehaviorSchema = {
  type: "object",
  properties: {
    ...behaviorCommonFields,
    ...messageTriggerFields,
    subcommand: subcommandSchema,
    ...commandLeafFields,
    webhook: webhookInputSchema,
    pluginAction: pluginActionInputSchema,
    ifUpdatedAt: ifUpdatedAtSchema,
  },
  minProperties: 1,
  additionalProperties: false,
} as const;

/** Fields a message trigger PATCH may change (besides its action). */
const MESSAGE_PATCH_KEYS = [
  "title",
  "description",
  "enabled",
  "replyVisibility",
  ...(Object.keys(messageTriggerFields) as Array<keyof typeof messageTriggerFields>),
] as const;

const LEAF_ONLY_KEYS = ["subcommand", ...Object.keys(commandLeafFields)];

// ── helpers ─────────────────────────────────────────────────────────────────

/** A field of the other trigger kind in a PATCH body → validation_failed. */
function refuseForeignFields(body: object, keys: readonly string[], kind: string): void {
  const foreign = keys.find((k) => k in body);
  if (foreign !== undefined) {
    throw new BehaviorApiError(
      "validation_failed",
      `${foreign} does not apply to a ${kind}`,
      foreign,
    );
  }
}

function stateOf(row: BehaviorDefinitionRow): MessageTriggerState {
  return {
    surface: row.surface ?? "bot_dm",
    guildId: row.guildId,
    channelId: row.channelId,
    patternKind: row.patternKind ?? "startswith",
    patternValue: row.patternValue ?? "",
    ignoreBots: row.ignoreBots,
    audienceKind: row.audienceKind,
    audienceUserId: row.audienceUserId,
    audienceGroupName: row.audienceGroupName,
  };
}

function trimmed<T extends { title?: string; description?: string }>(body: T): T {
  return {
    ...body,
    ...(body.title !== undefined ? { title: body.title.trim() } : {}),
    ...(body.description !== undefined ? { description: body.description.trim() } : {}),
  };
}

// ── routes ──────────────────────────────────────────────────────────────────

export function registerBehaviorWriteRoutes(
  server: FastifyInstance,
  reconciler: BehaviorCommandRegistrar | undefined,
  plugins: PluginActionCatalog | undefined,
): void {
  server.post(
    "/api/behaviors",
    { schema: { body: createMessageTriggerSchema } },
    async (request, reply) => {
      const body = trimmed(request.body as MessageTriggerCreate);
      const state: MessageTriggerState = {
        surface: body.surface,
        guildId: body.guildId ?? null,
        channelId: body.channelId ?? null,
        patternKind: body.patternKind,
        patternValue: body.patternValue,
        ignoreBots: body.ignoreBots ?? true,
        audienceKind: body.audienceKind ?? "all",
        audienceUserId: body.audienceUserId ?? null,
        audienceGroupName: body.audienceGroupName ?? null,
      };
      checkMessageTrigger(state);
      const action = (await prepareActionWrite(body, { behaviorId: null, plugins }, true))!;

      const id = await withBehaviorWriteLock(() =>
        behaviorTransaction(async (transaction) => {
          const row = await BehaviorDefinition.create(
            {
              title: body.title,
              description: body.description ?? "",
              enabled: body.enabled ?? true,
              sortOrder: await nextMessageSortOrder(transaction),
              systemKey: null,
              triggerKind: "message",
              actionSource: action.source,
              commandId: null,
              subcommandGroup: null,
              subcommand: null,
              stopOnMatch: body.stopOnMatch ?? false,
              replyVisibility: body.replyVisibility ?? null,
              ...state,
            },
            { transaction },
          );
          const behaviorId = row.getDataValue("id") as number;
          await storeActionWrite(behaviorId, action, transaction);
          return behaviorId;
        }),
      );

      await auditBehaviorWrite(request, "behavior.create", `behavior:${id}`, {
        kind: "message",
        title: body.title,
        enabled: body.enabled ?? true,
        stopOnMatch: body.stopOnMatch ?? false,
        replyVisibility: body.replyVisibility ?? null,
        ...state,
        ...actionAuditOf(action),
      });
      const secret = issuedSecretOf(action);
      return reply.code(201).send({
        behavior: await messageTriggerViewOf(id),
        ...(secret !== null ? { secret } : {}),
      });
    },
  );

  server.patch(
    "/api/behaviors/:id",
    { schema: { params: idParams, body: patchBehaviorSchema } },
    async (request, reply) => {
      const id = parseRowId(request.params);
      const body = trimmed(request.body as BehaviorPatch);
      const result = await withBehaviorWriteLock(async () => {
        const row = await loadBehaviorRow(id);
        refuseFixedRow(row);
        checkNotStale(row, body.ifUpdatedAt, `behavior ${id}`);
        if (row.triggerKind === "command") {
          refuseForeignFields(body, Object.keys(messageTriggerFields), "command leaf");
          const { audit, ...response } = await patchCommandLeaf(reconciler, plugins, request, row, body);
          return { audit, response };
        }
        refuseForeignFields(body, LEAF_ONLY_KEYS, "message trigger");
        const { audit, issuedSecret } = await patchMessageTrigger(row, body, plugins);
        return {
          audit,
          response: {
            behavior: await messageTriggerViewOf(id),
            ...(issuedSecret !== null ? { secret: issuedSecret } : {}),
          },
        };
      });
      await auditBehaviorWrite(request, "behavior.update", `behavior:${id}`, result.audit);
      return reply.send(result.response);
    },
  );

  server.delete(
    "/api/behaviors/:id",
    { schema: { params: idParams } },
    async (request, reply) => {
      const id = parseRowId(request.params);
      const result = await withBehaviorWriteLock(async () => {
        const current = await loadBehaviorRow(id);
        refuseFixedRow(current);
        if (current.triggerKind === "command") {
          return deleteCommandLeaf(reconciler, request, current);
        }
        await behaviorTransaction(async (transaction) => {
          await destroyDmAllowlists(id, transaction);
          await destroyDmLog(id, transaction);
          // explicit, not via FK cascade: SQLite may run without FK enforcement
          await BehaviorWebhookAction.destroy({ where: { behaviorId: id }, transaction });
          await destroyPluginActions(id, transaction);
          await BehaviorDefinition.destroy({ where: { id }, transaction });
          await pruneUnusedGroupMembers(transaction);
        });
        return { audit: { kind: "message", title: current.title }, registration: null };
      });
      await auditBehaviorWrite(request, "behavior.delete", `behavior:${id}`, result.audit);
      // a leaf's removal changed a Discord command: report its registration
      return result.registration
        ? reply.send({ registration: result.registration })
        : reply.code(204).send();
    },
  );
}

async function patchMessageTrigger(
  row: BehaviorDefinitionRow,
  body: BehaviorPatch,
  plugins: PluginActionCatalog | undefined,
): Promise<{ issuedSecret: string | null; audit: Record<string, unknown> }> {
  const before: Record<string, unknown> = {
    title: row.title,
    description: row.description,
    enabled: row.enabled,
    stopOnMatch: row.stopOnMatch,
    replyVisibility: row.replyVisibility,
    ...stateOf(row),
  };
  const after: Record<string, unknown> = { ...before };
  for (const key of MESSAGE_PATCH_KEYS) {
    if (body[key] !== undefined) after[key] = body[key];
  }
  checkMessageTrigger(after as unknown as MessageTriggerState);

  const action = await prepareActionWrite(body, { behaviorId: row.id, plugins }, false);

  await behaviorTransaction(async (transaction) => {
    const model = await BehaviorDefinition.findByPk(row.id, { transaction });
    model!.set(action ? { ...after, actionSource: action.source } : after);
    await model!.save({ transaction });
    if (action) await storeActionWrite(row.id, action, transaction);
    // the last trigger leaving a group takes its member list along (#137)
    if (after.audienceGroupName !== before.audienceGroupName) {
      await pruneUnusedGroupMembers(transaction);
    }
  });

  return {
    issuedSecret: issuedSecretOf(action),
    audit: {
      kind: "message",
      changed: changedFields(before, after),
      ...(action ? actionAuditOf(action) : {}),
      ...(action && action.source !== row.actionSource
        ? { actionSource: { from: row.actionSource, to: action.source } }
        : {}),
    },
  };
}
