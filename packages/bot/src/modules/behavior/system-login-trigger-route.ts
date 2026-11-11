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
 * one goes after — the fixed-row switch (fixed-trigger-switch.ts), which
 * the Service Behaviors share. `/login` is the login's own name. Only a
 * bot owner may switch it (requireOwner): an admin who is not the owner
 * must not be able to break the owner's way in.
 *
 * To a message, neither the pattern nor the sample DM may be taken by a
 * Service Behavior's trigger (#126): those are matched before the login
 * (service-behavior-rules.ts).
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
import { requireOwner } from "../web-core/route-guards.js";
import { BehaviorApiError } from "./behavior-api-error.js";
import { auditBehaviorWrite } from "./behavior-audit.js";
import {
  loadBehaviorCatalog,
  systemLoginOf,
  type SystemLoginEntry,
} from "./behavior-catalog.js";
import { buildBehaviorListView, type BehaviorListView } from "./behavior-list-view.js";
import { commandFields, ifUpdatedAtSchema, messageTriggerFields } from "./behavior-schemas.js";
import { withBehaviorWriteLock } from "./behavior-write-lock.js";
import type { RegistrationReport } from "./command-registration-sync.js";
import { StoredAfterRegistrationFailed } from "./command-register-first.js";
import {
  failureOutcome,
  globalCommandSettings,
  storedSummary,
  switchFixedTrigger,
  type FixedTrigger,
  type FixedTriggerDeps,
  type FixedTriggerRegistrar,
} from "./fixed-trigger-switch.js";
import { findStatsBulk } from "./models/behavior-stats.model.js";
import { checkLoginClearOfServices } from "./service-behavior-rules.js";
import { loginTriggerOf, type LoginTrigger, type LoginTriggerBody } from "./system-login-trigger.js";

/** What the switch needs of the CommandReconciler (injected, as for command writes). */
export type SystemLoginRegistrar = FixedTriggerRegistrar;

export interface SystemLoginTriggerDeps extends FixedTriggerDeps {
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

/** The login's trigger in the fixed-row switch's terms: everyone may DM it (the action checks who). */
function fixedTriggerOf(next: LoginTrigger): FixedTrigger {
  if (next.kind === "message") {
    return {
      kind: "message",
      patternKind: next.patternKind,
      patternValue: next.patternValue,
      audienceKind: "all",
      audienceUserId: null,
      audienceGroupName: null,
    };
  }
  return { kind: "command", settings: globalCommandSettings(next) };
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
          switchFixedTrigger(deps, {
            load: loadSystemLogin,
            next: fixedTriggerOf(next),
            ifUpdatedAt: body.ifUpdatedAt,
            what: "the system login",
            ownsReservedNames: true,
            check: (catalog) => {
              // loginTriggerOf made sure a message switch carries its sample
              if (next.kind === "message") {
                checkLoginClearOfServices(catalog, { patternValue: next.patternValue, sample: body.sample! });
              }
            },
            loaded: (login) => (seen.login = login),
          }),
        );
      } catch (err) {
        const failure = failureOutcome(err);
        if (seen.login && failure) await audit(seen.login, failure);
        throw err instanceof StoredAfterRegistrationFailed ? err.cause : err;
      }

      await audit(seen.login!, { outcome: "switched", registration: registration?.status ?? null });
      return reply.send({ system: await systemView(), registration });
    },
  );
}
