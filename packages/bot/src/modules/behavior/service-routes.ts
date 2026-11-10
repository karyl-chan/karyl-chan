/**
 * Service admin routes (#126) on /api/services — the services page:
 *
 *   GET    /api/services              — every service, with its behavior's id and trigger
 *   POST   /api/services              — add a service; its Service Behavior comes with it
 *   PUT    /api/services/:id          — rename it, change its audience or redirect URL
 *   DELETE /api/services/:id          — remove it and its Service Behavior
 *   PUT    /api/services/:id/trigger  — switch its Service Behavior's trigger
 *
 * Registered inside the behavior scope (strict schemas, uniform errors,
 * the admin / behavior.manage gate — see behavior-routes.ts), and owner
 * only on top of it, as the login's trigger is (requireOwner, before the
 * body is validated): whoever sets a redirect URL receives the tokens of
 * everyone who logs in to that service, and a service trigger decides
 * who gets one.
 *
 * A service and its behavior row are written in one transaction, so there
 * is never one without the other. A new service's behavior is a bot DM
 * Message Trigger on exactly `!login-<audience>` (service-behavior-rules.ts),
 * matched before the login. Its trigger then changes only through the
 * fixed-row switch the login shares (fixed-trigger-switch.ts): a bot DM
 * pattern with an audience, or a global command — the new trigger takes
 * effect before the old one goes. Changing the audience moves a trigger
 * that is still the old default to the new default; one the owner changed
 * stays.
 *
 * The redirect URL must be https: the link carries a service token. It
 * may not carry credentials or a `token` parameter of its own (the bot
 * adds one).
 *
 * Audited as `behavior.service.create` / `.update` / `.delete` on
 * `service:<id>`; the trigger switch as `behavior.service.trigger` with
 * an `outcome`, like the login's (`behavior.system.trigger`).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UniqueConstraintError, type Transaction } from "sequelize";
import { requireOwner } from "../web-core/route-guards.js";
import { BehaviorApiError, NON_BLANK_PATTERN } from "./behavior-api-error.js";
import { auditBehaviorWrite } from "./behavior-audit.js";
import {
  loadBehaviorCatalog,
  serviceBehaviorOf,
  serviceBehaviorsOf,
  type FixedRowEntry,
} from "./behavior-catalog.js";
import { serviceBehaviorView, type ServiceBehaviorView } from "./behavior-list-view.js";
import {
  commandFields,
  idParams,
  ifUpdatedAtSchema,
  messageTriggerFields,
  parseRowId,
} from "./behavior-schemas.js";
import { changedFields, checkNotStale } from "./behavior-write-guards.js";
import { behaviorTransaction, withBehaviorWriteLock } from "./behavior-write-lock.js";
import { StoredAfterRegistrationFailed } from "./command-register-first.js";
import { releaseDeletedCommand, type RegistrationReport } from "./command-registration-sync.js";
import { BehaviorCommand } from "./models/behavior-command.model.js";
import {
  failureOutcome,
  storedSummary,
  switchFixedTrigger,
  triggerSummary,
  type FixedTriggerDeps,
} from "./fixed-trigger-switch.js";
import {
  BehaviorDefinition,
  type BehaviorAudienceKind,
  type BehaviorPatternKind,
} from "./models/behavior-definition.model.js";
import { pruneUnusedGroupMembers } from "./models/behavior-group-member.model.js";
import { findStatsBulk } from "./models/behavior-stats.model.js";
import {
  SERVICE_AUDIENCE_PATTERN,
  Service,
  rowOfService,
  serviceBehaviorTitle,
  type ServiceRow,
} from "./models/service.model.js";
import {
  SERVICE_BEHAVIOR_DESCRIPTION,
  SERVICE_SORT_ORDER,
  checkServiceTriggerClear,
  defaultServicePattern,
  serviceTriggerOf,
  type ServiceTriggerBody,
} from "./service-behavior-rules.js";

export interface ServiceRouteDeps extends FixedTriggerDeps {
  /** Bot owners (tests); production reads BOT_OWNER_IDS. */
  ownerIds?: readonly string[];
}

// ── shapes ──────────────────────────────────────────────────────────────────

interface ServiceInput {
  name: string;
  audience: string;
  redirectUrl: string;
}

type ServicePatch = Partial<ServiceInput> & { ifUpdatedAt?: string };

/** What the services page shows of a service's trigger. */
export type ServiceTriggerView =
  | {
      kind: "message";
      patternKind: BehaviorPatternKind | null;
      patternValue: string | null;
      audienceKind: BehaviorAudienceKind;
    }
  | { kind: "command"; name: string };

/** What the services page shows of a service. */
export interface ServiceView extends ServiceInput {
  id: number;
  /** its Service Behavior — where its trigger is switched */
  behaviorId: number | null;
  trigger: ServiceTriggerView | null;
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

const updateServiceSchema = {
  type: "object",
  properties: { ...serviceFields, ifUpdatedAt: ifUpdatedAtSchema },
  minProperties: 1,
  additionalProperties: false,
} as const;

/** The trigger switch's body — also served by GET /api/behaviors/schema. */
export const serviceTriggerSchema = {
  type: "object",
  properties: {
    kind: { enum: ["message", "command"] },
    patternKind: messageTriggerFields.patternKind,
    patternValue: messageTriggerFields.patternValue,
    audienceKind: messageTriggerFields.audienceKind,
    audienceUserId: messageTriggerFields.audienceUserId,
    audienceGroupName: messageTriggerFields.audienceGroupName,
    name: commandFields.name,
    description: commandFields.description,
    integrationTypes: commandFields.integrationTypes,
    contexts: commandFields.contexts,
    ifUpdatedAt: ifUpdatedAtSchema,
  },
  required: ["kind"],
  additionalProperties: false,
} as const;

// ── rules ───────────────────────────────────────────────────────────────────

function refuse(field: string, message: string): never {
  throw new BehaviorApiError("validation_failed", message, field);
}

/** An https URL without credentials or a `token` parameter. */
export function checkRedirectUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    refuse("redirectUrl", "redirectUrl is not a URL");
  }
  if (url.protocol !== "https:") {
    refuse("redirectUrl", "redirectUrl must be https: the link carries a service token");
  }
  if (url.username !== "" || url.password !== "") {
    refuse("redirectUrl", "redirectUrl must not carry credentials");
  }
  if (url.searchParams.has("token")) {
    refuse("redirectUrl", "redirectUrl must not have a token parameter: the bot adds it");
  }
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
  transaction?: Transaction,
): Promise<void> {
  const other = await Service.findOne({ where: { audience }, transaction });
  if (other && other.getDataValue("id") !== ownId) throw audienceTaken(audience);
}

// ── views ───────────────────────────────────────────────────────────────────

function triggerViewOf({ row, command }: FixedRowEntry): ServiceTriggerView {
  return command
    ? { kind: "command", name: command.name }
    : {
        kind: "message",
        patternKind: row.patternKind,
        patternValue: row.patternValue,
        audienceKind: row.audienceKind,
      };
}

function serviceViewOfEntry(service: ServiceRow, entry: FixedRowEntry | null): ServiceView {
  return {
    id: service.id,
    name: service.name,
    audience: service.audience,
    redirectUrl: service.redirectUrl,
    behaviorId: entry?.row.id ?? null,
    trigger: entry ? triggerViewOf(entry) : null,
    createdAt: service.createdAt.toISOString(),
    updatedAt: service.updatedAt.toISOString(),
  };
}

/** Every service, from its behavior row (a service never goes without one). */
async function serviceViews(): Promise<ServiceView[]> {
  return serviceBehaviorsOf(await loadBehaviorCatalog()).flatMap((entry) =>
    entry.row.service ? [serviceViewOfEntry(entry.row.service, entry)] : [],
  );
}

async function serviceViewOf(id: number): Promise<ServiceView> {
  const view = (await serviceViews()).find((s) => s.id === id);
  if (!view) throw new BehaviorApiError("not_found", `service ${id} does not exist`);
  return view;
}

async function serviceBehaviorViewOf(serviceId: number): Promise<ServiceBehaviorView> {
  const entry = serviceBehaviorOf(await loadBehaviorCatalog(), serviceId);
  const view = entry ? serviceBehaviorView(entry, await findStatsBulk([entry.row.id])) : null;
  if (!view) throw new BehaviorApiError("not_found", `service ${serviceId} does not exist`);
  return view;
}

async function loadService(id: number, transaction?: Transaction): Promise<ServiceRow> {
  const model = await Service.findByPk(id, { transaction });
  if (!model) throw new BehaviorApiError("not_found", `service ${id} does not exist`);
  return rowOfService(model);
}

async function loadServiceBehavior(serviceId: number): Promise<FixedRowEntry> {
  const entry = serviceBehaviorOf(await loadBehaviorCatalog(), serviceId);
  if (!entry?.row.service) throw new BehaviorApiError("not_found", `service ${serviceId} does not exist`);
  return entry;
}

function trimmedName<T extends { name?: string }>(body: T): T {
  return body.name !== undefined ? { ...body, name: body.name.trim() } : body;
}

// ── routes ──────────────────────────────────────────────────────────────────

export function registerServiceRoutes(server: FastifyInstance, deps: ServiceRouteDeps): void {
  // only an owner manages services; a caller who is not one learns nothing about the shapes
  const ownerOnly = {
    preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireOwner(request, reply, deps.ownerIds, "manage services")) return reply;
    },
  };

  server.get("/api/services", ownerOnly, async (_request, reply) => {
    return reply.send({ services: await serviceViews() });
  });

  server.post(
    "/api/services",
    { ...ownerOnly, schema: { body: createServiceSchema } },
    async (request, reply) => {
      const body = trimmedName(request.body as ServiceInput);
      checkRedirectUrl(body.redirectUrl);
      const pattern = defaultServicePattern(body.audience);

      const ids = await withBehaviorWriteLock(async () => {
        await refuseTakenAudience(body.audience, null);
        checkServiceTriggerClear(await loadBehaviorCatalog(), null, body.audience, pattern);
        return behaviorTransaction(async (transaction) => {
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
        ...body,
        behaviorId: ids.behaviorId,
        trigger: pattern,
      });
      return reply.code(201).send({ service: await serviceViewOf(ids.serviceId) });
    },
  );

  server.put(
    "/api/services/:id",
    { ...ownerOnly, schema: { params: idParams, body: updateServiceSchema } },
    async (request, reply) => {
      const id = parseRowId(request.params);
      const body = trimmedName(request.body as ServicePatch);
      if (body.redirectUrl !== undefined) checkRedirectUrl(body.redirectUrl);

      const audit = await withBehaviorWriteLock(async () => {
        const current = await loadService(id);
        checkNotStale(current, body.ifUpdatedAt, `service ${id}`);
        const before: ServiceInput = {
          name: current.name,
          audience: current.audience,
          redirectUrl: current.redirectUrl,
        };
        const after: ServiceInput = {
          name: body.name ?? before.name,
          audience: body.audience ?? before.audience,
          redirectUrl: body.redirectUrl ?? before.redirectUrl,
        };

        if (after.audience !== before.audience) await refuseTakenAudience(after.audience, id);

        // a message trigger still on the old default follows the audience
        const catalog = await loadBehaviorCatalog();
        const behavior = serviceBehaviorOf(catalog, id);
        const oldDefault = defaultServicePattern(before.audience);
        const followsAudience =
          behavior !== null &&
          behavior.command === null &&
          after.audience !== before.audience &&
          behavior.row.patternKind === oldDefault.patternKind &&
          behavior.row.patternValue === oldDefault.patternValue;
        const trigger = followsAudience ? defaultServicePattern(after.audience) : null;
        if (trigger) checkServiceTriggerClear(catalog, id, after.audience, trigger);

        await behaviorTransaction(async (transaction) => {
          const model = await Service.findByPk(id, { transaction });
          model!.set(after);
          await model!.save({ transaction }).catch((err: unknown) => asAudienceConflict(err, after.audience));
          if (behavior && (trigger || after.name !== before.name)) {
            const row = await BehaviorDefinition.findByPk(behavior.row.id, { transaction });
            row!.set({ title: serviceBehaviorTitle(after.name), ...(trigger ?? {}) });
            await row!.save({ transaction });
          }
        });
        return {
          changed: changedFields({ ...before }, { ...after }),
          ...(trigger ? { trigger } : {}),
        };
      });

      await auditBehaviorWrite(request, "behavior.service.update", `service:${id}`, audit);
      return reply.send({ service: await serviceViewOf(id) });
    },
  );

  server.delete(
    "/api/services/:id",
    { ...ownerOnly, schema: { params: idParams } },
    async (request, reply) => {
      const id = parseRowId(request.params);
      const removed = await withBehaviorWriteLock(async () => {
        const service = await loadService(id);
        const command = serviceBehaviorOf(await loadBehaviorCatalog(), id)?.command ?? null;
        await behaviorTransaction(async (transaction) => {
          await BehaviorDefinition.destroy({ where: { serviceId: id }, transaction });
          if (command) await BehaviorCommand.destroy({ where: { id: command.id }, transaction });
          await Service.destroy({ where: { id }, transaction });
          // its trigger may have been the last user of an audience group
          await pruneUnusedGroupMembers(transaction);
        });
        // a command trigger leaves Discord too (deferred: the next full reconcile removes it)
        const registration = command
          ? await releaseDeletedCommand(deps.reconciler, { name: command.name, target: "global" })
          : null;
        return { service, registration };
      });
      await auditBehaviorWrite(request, "behavior.service.delete", `service:${id}`, {
        name: removed.service.name,
        audience: removed.service.audience,
        ...(removed.registration ? { registration: removed.registration.status } : {}),
      });
      return removed.registration
        ? reply.send({ registration: removed.registration })
        : reply.code(204).send();
    },
  );

  server.put(
    "/api/services/:id/trigger",
    { ...ownerOnly, schema: { params: idParams, body: serviceTriggerSchema } },
    async (request, reply) => {
      const id = parseRowId(request.params);
      const body = request.body as ServiceTriggerBody;
      const next = serviceTriggerOf(body);

      const seen: { entry: FixedRowEntry | null } = { entry: null };
      const audit = (from: FixedRowEntry, result: Record<string, unknown>) =>
        auditBehaviorWrite(request, "behavior.service.trigger", `service:${id}`, {
          behaviorId: from.row.id,
          from: storedSummary(from),
          to: triggerSummary(next),
          ...result,
        });

      let registration: RegistrationReport | null;
      try {
        registration = await withBehaviorWriteLock(() =>
          switchFixedTrigger(deps, {
            load: () => loadServiceBehavior(id),
            next,
            ifUpdatedAt: body.ifUpdatedAt,
            what: `the login of service ${id}`,
            ownsReservedNames: false,
            check: (catalog, current) => {
              if (next.kind === "message") {
                checkServiceTriggerClear(catalog, id, current.row.service!.audience, next);
              }
            },
            loaded: (entry) => (seen.entry = entry),
          }),
        );
      } catch (err) {
        const failure = failureOutcome(err);
        if (seen.entry && failure) await audit(seen.entry, failure);
        throw err instanceof StoredAfterRegistrationFailed ? err.cause : err;
      }

      await audit(seen.entry!, { outcome: "switched", registration: registration?.status ?? null });
      return reply.send({ behavior: await serviceBehaviorViewOf(id), registration });
    },
  );
}
