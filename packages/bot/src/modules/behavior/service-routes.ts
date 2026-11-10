/**
 * Service admin routes (#126) on /api/services — the services page:
 *
 *   GET    /api/services      — every service, with its behavior's id and trigger
 *   POST   /api/services      — add a service; its Service Behavior comes with it
 *   PUT    /api/services/:id  — rename it, change its audience or redirect URL
 *   DELETE /api/services/:id  — remove it and its Service Behavior
 *
 * Registered inside the behavior scope (strict schemas, uniform errors,
 * the admin / behavior.manage gate — see behavior-routes.ts): a service is
 * administered with the behaviors that trigger it.
 *
 * A service and its behavior row are written in one transaction, so there
 * is never one without the other. A new service's behavior is a bot DM
 * Message Trigger on `!login-<audience>` (service-behavior-rules.ts), matched
 * before the login; its trigger is then edited on the behaviors page
 * (PATCH /api/behaviors/:id). Changing the audience moves a trigger that is
 * still the old default to the new default; one the admin changed stays.
 *
 * The redirect URL must be https: the link carries a token that logs the
 * user in. It may not carry credentials or a `token` parameter of its own
 * (the bot adds one).
 *
 * Audited as `behavior.service.create` / `.update` / `.delete` on
 * `service:<id>`.
 */

import type { FastifyInstance } from "fastify";
import { UniqueConstraintError, type Transaction } from "sequelize";
import { BehaviorApiError, NON_BLANK_PATTERN } from "./behavior-api-error.js";
import { auditBehaviorWrite } from "./behavior-audit.js";
import { loadBehaviorCatalog, serviceBehaviorsOf } from "./behavior-catalog.js";
import { idParams, ifUpdatedAtSchema, parseRowId } from "./behavior-schemas.js";
import { changedFields, checkNotStale } from "./behavior-write-guards.js";
import { behaviorTransaction, withBehaviorWriteLock } from "./behavior-write-lock.js";
import { BehaviorDefinition } from "./models/behavior-definition.model.js";
import { pruneUnusedGroupMembers } from "./models/behavior-group-member.model.js";
import {
  SERVICE_AUDIENCE_PATTERN,
  Service,
  rowOfService,
  type ServiceRow,
} from "./models/service.model.js";
import {
  SERVICE_BEHAVIOR_DESCRIPTION,
  SERVICE_SORT_ORDER,
  checkClearOfLogin,
  defaultServicePattern,
  serviceBehaviorTitle,
} from "./service-behavior-rules.js";

// ── shapes ──────────────────────────────────────────────────────────────────

interface ServiceInput {
  name: string;
  audience: string;
  redirectUrl: string;
}

type ServicePatch = Partial<ServiceInput> & { ifUpdatedAt?: string };

/** What the services page shows of a service. */
export interface ServiceView extends ServiceInput {
  id: number;
  /** its Service Behavior — where its trigger is edited */
  behaviorId: number | null;
  trigger: {
    patternKind: string | null;
    patternValue: string | null;
    audienceKind: string;
  } | null;
  createdAt: string;
  /** send back as `ifUpdatedAt` to refuse a stale edit */
  updatedAt: string;
}

const serviceFields = {
  name: { type: "string", minLength: 1, maxLength: 100, pattern: NON_BLANK_PATTERN },
  audience: { type: "string", minLength: 1, maxLength: 64, pattern: SERVICE_AUDIENCE_PATTERN },
  redirectUrl: { type: "string", minLength: 1, maxLength: 2000 },
} as const;

export const createServiceSchema = {
  type: "object",
  properties: serviceFields,
  required: ["name", "audience", "redirectUrl"],
  additionalProperties: false,
} as const;

export const updateServiceSchema = {
  type: "object",
  properties: { ...serviceFields, ifUpdatedAt: ifUpdatedAtSchema },
  minProperties: 1,
  additionalProperties: false,
} as const;

// ── rules ───────────────────────────────────────────────────────────────────

function refuse(field: string, message: string): never {
  throw new BehaviorApiError("validation_failed", message, field);
}

/** An https URL without credentials or a `token` parameter; returned as written. */
export function checkRedirectUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    refuse("redirectUrl", "redirectUrl is not a URL");
  }
  if (url.protocol !== "https:") {
    refuse("redirectUrl", "redirectUrl must be https: the link carries a login token");
  }
  if (url.username !== "" || url.password !== "") {
    refuse("redirectUrl", "redirectUrl must not carry credentials");
  }
  if (url.searchParams.has("token")) {
    refuse("redirectUrl", "redirectUrl must not have a token parameter: the bot adds it");
  }
  return raw;
}

function audienceTaken(audience: string): BehaviorApiError {
  return new BehaviorApiError(
    "name_conflict",
    `audience "${audience}" is already used by another service`,
    "audience",
  );
}

/** A save that lost the race to the unique index → the same refusal as the check before it. */
function asAudienceConflict(err: unknown, audience: string): never {
  throw err instanceof UniqueConstraintError ? audienceTaken(audience) : err;
}

async function refuseTakenAudience(
  audience: string,
  ownId: number | null,
  transaction: Transaction,
): Promise<void> {
  const other = await Service.findOne({ where: { audience }, transaction });
  if (other && other.getDataValue("id") !== ownId) throw audienceTaken(audience);
}

// ── views ───────────────────────────────────────────────────────────────────

async function serviceViews(): Promise<ServiceView[]> {
  const catalog = await loadBehaviorCatalog();
  const behaviors = new Map(serviceBehaviorsOf(catalog).map((b) => [b.serviceId, b]));
  const services = (await Service.findAll({ order: [["id", "ASC"]] })).map(rowOfService);
  return services.map((s) => {
    const b = behaviors.get(s.id);
    return {
      id: s.id,
      name: s.name,
      audience: s.audience,
      redirectUrl: s.redirectUrl,
      behaviorId: b?.id ?? null,
      trigger: b
        ? { patternKind: b.patternKind, patternValue: b.patternValue, audienceKind: b.audienceKind }
        : null,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  });
}

async function serviceViewOf(id: number): Promise<ServiceView> {
  const view = (await serviceViews()).find((s) => s.id === id);
  if (!view) throw new BehaviorApiError("not_found", `service ${id} does not exist`);
  return view;
}

async function loadService(id: number, transaction?: Transaction): Promise<ServiceRow> {
  const model = await Service.findByPk(id, { transaction });
  if (!model) throw new BehaviorApiError("not_found", `service ${id} does not exist`);
  return rowOfService(model);
}

function trimmedName<T extends { name?: string }>(body: T): T {
  return body.name !== undefined ? { ...body, name: body.name.trim() } : body;
}

// ── routes ──────────────────────────────────────────────────────────────────

export function registerServiceRoutes(server: FastifyInstance): void {
  server.get("/api/services", async (_request, reply) => {
    return reply.send({ services: await serviceViews() });
  });

  server.post(
    "/api/services",
    { schema: { body: createServiceSchema } },
    async (request, reply) => {
      const body = trimmedName(request.body as ServiceInput);
      checkRedirectUrl(body.redirectUrl);
      const pattern = defaultServicePattern(body.audience);

      const ids = await withBehaviorWriteLock(async () => {
        checkClearOfLogin(await loadBehaviorCatalog(), pattern);
        return behaviorTransaction(async (transaction) => {
          await refuseTakenAudience(body.audience, null, transaction);
          const service = await Service.create(
            { name: body.name, audience: body.audience, redirectUrl: body.redirectUrl },
            { transaction },
          ).catch((err: unknown) => asAudienceConflict(err, body.audience));
          const serviceId = service.getDataValue("id") as number;
          const row = await BehaviorDefinition.create(
            {
              title: serviceBehaviorTitle(body.name),
              description: SERVICE_BEHAVIOR_DESCRIPTION,
              enabled: true,
              sortOrder: SERVICE_SORT_ORDER,
              systemKey: null,
              triggerKind: "message",
              actionSource: "service",
              serviceId,
              commandId: null,
              subcommandGroup: null,
              subcommand: null,
              surface: "bot_dm",
              guildId: null,
              channelId: null,
              ...pattern,
              stopOnMatch: true,
              ignoreBots: true,
              audienceKind: "all",
              audienceUserId: null,
              audienceGroupName: null,
              replyVisibility: null,
            },
            { transaction },
          );
          return { serviceId, behaviorId: row.getDataValue("id") as number };
        });
      });

      await auditBehaviorWrite(request, "behavior.service.create", `service:${ids.serviceId}`, {
        name: body.name,
        audience: body.audience,
        redirectUrl: body.redirectUrl,
        behaviorId: ids.behaviorId,
        trigger: pattern,
      });
      return reply.code(201).send({ service: await serviceViewOf(ids.serviceId) });
    },
  );

  server.put(
    "/api/services/:id",
    { schema: { params: idParams, body: updateServiceSchema } },
    async (request, reply) => {
      const id = parseRowId(request.params);
      const body = trimmedName(request.body as ServicePatch);
      if (body.redirectUrl !== undefined) checkRedirectUrl(body.redirectUrl);

      const audit = await withBehaviorWriteLock(async () => {
        const current = await loadService(id);
        checkNotStale(current, body.ifUpdatedAt, `service ${id}`);
        const before = { name: current.name, audience: current.audience, redirectUrl: current.redirectUrl };
        const after = {
          name: body.name ?? before.name,
          audience: body.audience ?? before.audience,
          redirectUrl: body.redirectUrl ?? before.redirectUrl,
        };

        // a trigger still on the old default follows the audience
        const catalog = await loadBehaviorCatalog();
        const behavior = serviceBehaviorsOf(catalog).find((b) => b.serviceId === id) ?? null;
        const oldDefault = defaultServicePattern(before.audience);
        const followsAudience =
          behavior !== null &&
          after.audience !== before.audience &&
          behavior.patternKind === oldDefault.patternKind &&
          behavior.patternValue === oldDefault.patternValue;
        const trigger = followsAudience ? defaultServicePattern(after.audience) : null;
        if (trigger) checkClearOfLogin(catalog, trigger);

        await behaviorTransaction(async (transaction) => {
          if (after.audience !== before.audience) {
            await refuseTakenAudience(after.audience, id, transaction);
          }
          const model = await Service.findByPk(id, { transaction });
          model!.set(after);
          await model!.save({ transaction }).catch((err: unknown) => asAudienceConflict(err, after.audience));
          if (behavior && (trigger || after.name !== before.name)) {
            const row = await BehaviorDefinition.findByPk(behavior.id, { transaction });
            row!.set({ title: serviceBehaviorTitle(after.name), ...(trigger ?? {}) });
            await row!.save({ transaction });
          }
        });
        return {
          changed: changedFields(before, after),
          ...(trigger ? { trigger } : {}),
        };
      });

      await auditBehaviorWrite(request, "behavior.service.update", `service:${id}`, audit);
      return reply.send({ service: await serviceViewOf(id) });
    },
  );

  server.delete(
    "/api/services/:id",
    { schema: { params: idParams } },
    async (request, reply) => {
      const id = parseRowId(request.params);
      const removed = await withBehaviorWriteLock(() =>
        behaviorTransaction(async (transaction) => {
          const service = await loadService(id, transaction);
          await BehaviorDefinition.destroy({ where: { serviceId: id }, transaction });
          await Service.destroy({ where: { id }, transaction });
          // its trigger may have been the last user of an audience group
          await pruneUnusedGroupMembers(transaction);
          return service;
        }),
      );
      await auditBehaviorWrite(request, "behavior.service.delete", `service:${id}`, {
        name: removed.name,
        audience: removed.audience,
      });
      return reply.code(204).send();
    },
  );
}
