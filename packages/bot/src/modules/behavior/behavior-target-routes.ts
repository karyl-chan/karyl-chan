/**
 * The Behavior Target directory (ADR 0004), for the admin:
 *
 *   POST   /api/behavior-targets      — create a guild, channel, user or group target
 *   DELETE /api/behavior-targets/:id  — delete one nothing uses
 *
 * A target is listed (GET /api/behaviors → `targets`) from the moment it is
 * created, with no behavior yet. It cannot be renamed or moved: delete it
 * and create another. Deleting is refused (`target_in_use`) while a
 * behavior belongs to it or, for a group, a DM allowlist names it — a
 * group's member list goes with its target. The three built-in targets
 * have no row and so no id to delete.
 */

import type { FastifyInstance } from "fastify";
import { BehaviorApiError, NON_BLANK_PATTERN } from "./behavior-api-error.js";
import { auditBehaviorWrite } from "./behavior-audit.js";
import { loadBehaviorCatalog } from "./behavior-catalog.js";
import { idParams, parseRowId, snowflake } from "./behavior-schemas.js";
import { loadBehaviorTargetUsage } from "./behavior-target-registry.js";
import { behaviorTargetView, type BehaviorTargetView } from "./behavior-target-view.js";
import {
  behaviorTargetKey,
  type BehaviorTargetFields,
  type BehaviorTargetKind,
} from "./behavior-target.js";
import { behaviorTransaction, withBehaviorWriteLock } from "./behavior-write-lock.js";
import { dmAllowlistGroupRefs } from "./models/behavior-dm-allowlist.model.js";
import { destroyGroupMembers } from "./models/behavior-group-member.model.js";
import {
  BehaviorTarget,
  rowOfBehaviorTarget,
  type BehaviorTargetRow,
} from "./models/behavior-target.model.js";

/**
 * One flat object rather than a `oneOf` per kind: which fields a kind
 * takes is checked below, so a refusal names the field instead of "must
 * match exactly one schema".
 */
export const createTargetSchema = {
  type: "object",
  properties: {
    kind: { enum: ["guild", "channel", "user", "group"] },
    guildId: snowflake,
    channelId: snowflake,
    userId: snowflake,
    name: { type: "string", minLength: 1, maxLength: 200, pattern: NON_BLANK_PATTERN },
  },
  required: ["kind"],
  additionalProperties: false,
} as const;

interface CreateTargetBody {
  kind: BehaviorTargetKind;
  guildId?: string;
  channelId?: string;
  userId?: string;
  name?: string;
}

type BodyField = "guildId" | "channelId" | "userId" | "name";

const FIELDS_OF: Record<BehaviorTargetKind, readonly BodyField[]> = {
  guild: ["guildId"],
  channel: ["guildId", "channelId"],
  user: ["userId"],
  group: ["name"],
};

function fieldsOf(body: CreateTargetBody): BehaviorTargetFields {
  const wanted = FIELDS_OF[body.kind];
  for (const field of ["guildId", "channelId", "userId", "name"] as const) {
    if (wanted.includes(field) && body[field] === undefined) {
      throw new BehaviorApiError("validation_failed", `a ${body.kind} target needs ${field}`, field);
    }
    if (!wanted.includes(field) && body[field] !== undefined) {
      throw new BehaviorApiError("validation_failed", `a ${body.kind} target takes no ${field}`, field);
    }
  }
  return {
    kind: body.kind,
    guildId: body.guildId ?? null,
    channelId: body.channelId ?? null,
    userId: body.userId ?? null,
    groupName: body.name !== undefined ? body.name.trim() : null,
  };
}

async function viewOf(row: BehaviorTargetRow): Promise<BehaviorTargetView> {
  const [catalog, allowlistGroups] = await Promise.all([loadBehaviorCatalog(), dmAllowlistGroupRefs()]);
  return behaviorTargetView(row, catalog, allowlistGroups);
}

export function registerBehaviorTargetRoutes(server: FastifyInstance): void {
  server.post(
    "/api/behavior-targets",
    { schema: { body: createTargetSchema } },
    async (request, reply) => {
      const fields = fieldsOf(request.body as CreateTargetBody);
      const key = behaviorTargetKey(fields);
      const row = await withBehaviorWriteLock(() =>
        behaviorTransaction(async (transaction) => {
          if ((await BehaviorTarget.count({ where: { key }, transaction })) > 0) {
            throw new BehaviorApiError(
              "name_conflict",
              fields.kind === "group"
                ? `a group named '${fields.groupName}' already exists`
                : `this ${fields.kind} is already a target`,
              FIELDS_OF[fields.kind].at(-1),
            );
          }
          return rowOfBehaviorTarget(await BehaviorTarget.create({ key, ...fields }, { transaction }));
        }),
      );
      await auditBehaviorWrite(request, "behavior.target.create", `target:${key}`, { ...fields });
      return reply.code(201).send({ target: await viewOf(row) });
    },
  );

  server.delete(
    "/api/behavior-targets/:id",
    { schema: { params: idParams } },
    async (request, reply) => {
      const id = parseRowId(request.params);
      const row = await withBehaviorWriteLock(() =>
        behaviorTransaction(async (transaction) => {
          const model = await BehaviorTarget.findByPk(id, { transaction });
          if (!model) throw new BehaviorApiError("not_found", `target ${id} does not exist`);
          const target = rowOfBehaviorTarget(model);
          const usage = await loadBehaviorTargetUsage(transaction);
          const behaviors = usage.behaviors.get(target.key) ?? 0;
          const allowlists =
            target.groupName !== null ? (usage.allowlistGroups.get(target.groupName) ?? 0) : 0;
          if (behaviors > 0 || allowlists > 0) {
            throw new BehaviorApiError(
              "target_in_use",
              behaviors > 0
                ? `${behaviors} behavior(s) still belong to this target; move or delete them first`
                : `${allowlists} behavior(s) name this group in their DM allowlist; remove it there first`,
              undefined,
              { behaviors, allowlists },
            );
          }
          if (target.groupName !== null) await destroyGroupMembers(target.groupName, transaction);
          await model.destroy({ transaction });
          return target;
        }),
      );
      const { id: _id, key, ...fields } = row;
      await auditBehaviorWrite(request, "behavior.target.delete", `target:${key}`, { ...fields });
      return reply.code(204).send();
    },
  );
}
