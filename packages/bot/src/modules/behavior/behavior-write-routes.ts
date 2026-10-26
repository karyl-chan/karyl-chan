/**
 * Behavior write routes (#136) on /api/behaviors:
 *
 *   POST   /api/behaviors        — create a Message Trigger
 *   PATCH  /api/behaviors/:id    — edit a Message Trigger
 *   DELETE /api/behaviors/:id    — delete a Message Trigger
 *
 * Registered inside the behavior scope (strict schemas, uniform errors,
 * the behavior.manage gate — see behavior-routes.ts). The System Behavior
 * is immutable here: switching its trigger is S7 (#139).
 */

import type { FastifyInstance } from "fastify";
import type { Transaction } from "sequelize";
import { BehaviorApiError } from "./behavior-api-error.js";
import { auditBehaviorWrite } from "./behavior-audit.js";
import { loadBehaviorCatalog } from "./behavior-catalog.js";
import { messageTriggerView, type MessageTriggerView } from "./behavior-list-view.js";
import {
  behaviorCommonFields,
  idParams,
  ifUpdatedAtSchema,
  messageTriggerFields,
  parseRowId,
} from "./behavior-schemas.js";
import { behaviorTransaction, withBehaviorWriteLock } from "./behavior-write-lock.js";
import { checkMessageTrigger, type MessageTriggerState } from "./message-trigger-rules.js";
import {
  BehaviorDefinition,
  rowOfBehaviorDefinition,
  type BehaviorDefinitionRow,
} from "./models/behavior-definition.model.js";
import {
  BehaviorWebhookAction,
  rowOfBehaviorWebhookAction,
} from "./models/behavior-webhook-action.model.js";
import { findStatsBulk } from "./models/behavior-stats.model.js";
import {
  prepareWebhookWrite,
  webhookInputSchema,
  type WebhookInput,
} from "./webhook-action-input.js";

// ── shapes ──────────────────────────────────────────────────────────────────

interface MessageTriggerCreate extends Partial<MessageTriggerState> {
  title: string;
  description?: string;
  enabled?: boolean;
  surface: MessageTriggerState["surface"];
  patternKind: MessageTriggerState["patternKind"];
  patternValue: string;
  stopOnMatch?: boolean;
  webhook: WebhookInput;
}

type BehaviorPatch = Partial<Omit<MessageTriggerCreate, "webhook">> & {
  webhook?: WebhookInput;
  ifUpdatedAt?: string;
};

const createMessageTriggerSchema = {
  type: "object",
  properties: {
    ...behaviorCommonFields,
    ...messageTriggerFields,
    webhook: webhookInputSchema,
  },
  required: ["title", "surface", "patternKind", "patternValue", "webhook"],
  additionalProperties: false,
} as const;

const patchBehaviorSchema = {
  type: "object",
  properties: {
    ...behaviorCommonFields,
    ...messageTriggerFields,
    webhook: webhookInputSchema,
    ifUpdatedAt: ifUpdatedAtSchema,
  },
  minProperties: 1,
  additionalProperties: false,
} as const;

/** Fields a message trigger PATCH may change (besides webhook). */
const MESSAGE_PATCH_KEYS = [
  "title",
  "description",
  "enabled",
  ...(Object.keys(messageTriggerFields) as Array<keyof typeof messageTriggerFields>),
] as const;

// ── helpers ─────────────────────────────────────────────────────────────────

export async function loadBehaviorRow(id: number): Promise<BehaviorDefinitionRow> {
  const model = await BehaviorDefinition.findByPk(id);
  if (!model) throw new BehaviorApiError("not_found", `behavior ${id} does not exist`);
  return rowOfBehaviorDefinition(model);
}

export function refuseSystem(row: { systemKey: string | null }): void {
  if (row.systemKey !== null) {
    throw new BehaviorApiError(
      "system_immutable",
      "the system behavior cannot be changed or deleted here (its trigger switch comes with #139)",
    );
  }
}

export function checkNotStale(
  current: { updatedAt: Date },
  ifUpdatedAt: string | undefined,
  what: string,
): void {
  if (ifUpdatedAt === undefined) return;
  if (current.updatedAt.toISOString() !== ifUpdatedAt) {
    throw BehaviorApiError.stale(
      "ifUpdatedAt",
      `${what} was changed by someone else (now at ${current.updatedAt.toISOString()}); reload and retry`,
    );
  }
}

async function messageTriggerViewOf(id: number): Promise<MessageTriggerView> {
  const catalog = await loadBehaviorCatalog();
  const trigger = catalog.messageTriggers.find((t) => t.id === id);
  if (!trigger) throw new BehaviorApiError("not_found", `behavior ${id} does not exist`);
  return messageTriggerView(trigger, await findStatsBulk([id]));
}

/** The next sortOrder after every message trigger (inside the write transaction). */
async function nextMessageSortOrder(transaction: Transaction): Promise<number> {
  const max = (await BehaviorDefinition.max("sortOrder", {
    where: { triggerKind: "message" },
    transaction,
  })) as number | null;
  return Number.isFinite(max) ? (max as number) + 1 : 0;
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

/** `{ field: { from, to } }` for every field whose value changes. */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, to] of Object.entries(after)) {
    const from = before[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) changed[key] = { from, to };
  }
  return changed;
}

function trimmed<T extends { title?: string; description?: string }>(body: T): T {
  return {
    ...body,
    ...(body.title !== undefined ? { title: body.title.trim() } : {}),
    ...(body.description !== undefined ? { description: body.description.trim() } : {}),
  };
}

// ── routes ──────────────────────────────────────────────────────────────────

export function registerBehaviorWriteRoutes(server: FastifyInstance): void {
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
      const webhook = await prepareWebhookWrite(body.webhook, null);

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
              actionSource: "webhook",
              commandId: null,
              subcommandGroup: null,
              subcommand: null,
              stopOnMatch: body.stopOnMatch ?? false,
              ...state,
            },
            { transaction },
          );
          const behaviorId = row.getDataValue("id") as number;
          await BehaviorWebhookAction.create(
            { behaviorId, ...webhook.values },
            { transaction },
          );
          return behaviorId;
        }),
      );

      await auditBehaviorWrite(request, "behavior.create", `behavior:${id}`, {
        kind: "message",
        title: body.title,
        enabled: body.enabled ?? true,
        stopOnMatch: body.stopOnMatch ?? false,
        ...state,
        webhook: webhook.audit,
      });
      return reply.code(201).send({
        behavior: await messageTriggerViewOf(id),
        ...(webhook.issuedSecret !== null ? { secret: webhook.issuedSecret } : {}),
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
        refuseSystem(row);
        checkNotStale(row, body.ifUpdatedAt, `behavior ${id}`);
        if (row.triggerKind !== "message") {
          throw new BehaviorApiError(
            "validation_failed",
            "command leaves are edited through the command routes",
          );
        }
        return patchMessageTrigger(row, body);
      });
      await auditBehaviorWrite(request, "behavior.update", `behavior:${id}`, result.audit);
      return reply.send({
        behavior: await messageTriggerViewOf(id),
        ...(result.issuedSecret !== null ? { secret: result.issuedSecret } : {}),
      });
    },
  );

  server.delete(
    "/api/behaviors/:id",
    { schema: { params: idParams } },
    async (request, reply) => {
      const id = parseRowId(request.params);
      const row = await withBehaviorWriteLock(async () => {
        const current = await loadBehaviorRow(id);
        refuseSystem(current);
        if (current.triggerKind !== "message") {
          throw new BehaviorApiError(
            "validation_failed",
            "command leaves are removed through the command routes",
          );
        }
        await BehaviorDefinition.destroy({ where: { id } });
        return current;
      });
      await auditBehaviorWrite(request, "behavior.delete", `behavior:${id}`, {
        kind: row.triggerKind,
        title: row.title,
      });
      return reply.code(204).send();
    },
  );
}

async function patchMessageTrigger(
  row: BehaviorDefinitionRow,
  body: BehaviorPatch,
): Promise<{ issuedSecret: string | null; audit: Record<string, unknown> }> {
  const before: Record<string, unknown> = {
    title: row.title,
    description: row.description,
    enabled: row.enabled,
    stopOnMatch: row.stopOnMatch,
    ...stateOf(row),
  };
  const after: Record<string, unknown> = { ...before };
  for (const key of MESSAGE_PATCH_KEYS) {
    if (body[key] !== undefined) after[key] = body[key];
  }
  checkMessageTrigger(after as unknown as MessageTriggerState);

  const existingAction = await BehaviorWebhookAction.findByPk(row.id);
  const webhook = body.webhook
    ? await prepareWebhookWrite(
        body.webhook,
        existingAction ? rowOfBehaviorWebhookAction(existingAction) : null,
      )
    : null;

  await behaviorTransaction(async (transaction) => {
    const model = await BehaviorDefinition.findByPk(row.id, { transaction });
    model!.set(after);
    await model!.save({ transaction });
    if (webhook) {
      await BehaviorWebhookAction.upsert(
        { behaviorId: row.id, ...webhook.values },
        { transaction },
      );
    }
  });

  return {
    issuedSecret: webhook?.issuedSecret ?? null,
    audit: {
      kind: "message",
      changed: changedFields(before, after),
      ...(webhook ? { webhook: webhook.audit } : {}),
    },
  };
}
