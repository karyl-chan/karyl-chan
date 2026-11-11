/**
 * A behavior's direct messages to other users (#157), for the admin:
 *
 *   GET /api/behaviors/:id/dm-allowlist  — { userIds, groupNames } (empty: no list)
 *   PUT /api/behaviors/:id/dm-allowlist  — replace it; both empty removes it
 *   GET /api/behaviors/:id/dm-log        — the last 50 DMs, newest first
 *
 * With a list, the behavior's replies may DM only its users and the
 * members of its behavior groups; without one, members of the triggering
 * guild (any guild for a DM trigger) — behavior-direct-messages.ts. A
 * group a list names is in use (groupInUse), so its members can be set;
 * dropping it from the last list that names it prunes its members, as a
 * message trigger leaving it does. The fixed rows — the System Behavior
 * and the Service Behaviors (#126) — have no list (refuseFixedRow).
 */

import type { FastifyInstance } from "fastify";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { auditBehaviorWrite } from "./behavior-audit.js";
import { findRecentDmLog } from "./behavior-dm-log.js";
import { idParams, parseRowId, snowflake } from "./behavior-schemas.js";
import { behaviorTransaction, withBehaviorWriteLock } from "./behavior-write-lock.js";
import { loadBehaviorRow, refuseFixedRow } from "./behavior-write-guards.js";
import { findDmAllowlist, replaceDmAllowlist, type DmAllowlist } from "./models/behavior-dm-allowlist.model.js";
import { pruneUnusedGroupMembers } from "./models/behavior-group-member.model.js";

/** The most user ids and group names one list holds. */
export const MAX_DM_ALLOWLIST_USERS = 100;
export const MAX_DM_ALLOWLIST_GROUPS = 20;

export const dmAllowlistSchema = {
  type: "object",
  properties: {
    userIds: { type: "array", maxItems: MAX_DM_ALLOWLIST_USERS, items: snowflake },
    groupNames: {
      type: "array",
      maxItems: MAX_DM_ALLOWLIST_GROUPS,
      items: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
    },
  },
  required: ["userIds", "groupNames"],
  additionalProperties: false,
} as const;

const EMPTY: DmAllowlist = { userIds: [], groupNames: [] };

export function registerBehaviorDmRoutes(server: FastifyInstance): void {
  server.get(
    "/api/behaviors/:id/dm-allowlist",
    { schema: { params: idParams } },
    async (request, reply) => {
      const { id } = await loadBehaviorRow(parseRowId(request.params));
      return reply.send((await findDmAllowlist(id)) ?? EMPTY);
    },
  );

  server.put(
    "/api/behaviors/:id/dm-allowlist",
    { schema: { params: idParams, body: dmAllowlistSchema } },
    async (request, reply) => {
      const id = parseRowId(request.params);
      const body = request.body as DmAllowlist;
      const list = {
        userIds: body.userIds,
        groupNames: body.groupNames.map((g) => g.trim()),
      };
      const saved = await withBehaviorWriteLock(async () => {
        refuseFixedRow(await loadBehaviorRow(id));
        return behaviorTransaction(async (transaction) => {
          const after = await replaceDmAllowlist(id, list, transaction);
          // a group no list or trigger names any more takes its members along
          await pruneUnusedGroupMembers(transaction);
          return after ?? EMPTY;
        });
      });
      await auditBehaviorWrite(request, "behavior.dm_allowlist.replace", `behavior:${id}`, { ...saved });
      botEventLog.record(
        "info",
        "bot",
        `behavior ${id}: DM allowlist set to ${saved.userIds.length} user(s), ${saved.groupNames.length} group(s)`,
        { behaviorId: id, actor: request.authUserId ?? null },
      );
      return reply.send(saved);
    },
  );

  server.get(
    "/api/behaviors/:id/dm-log",
    { schema: { params: idParams } },
    async (request, reply) => {
      const { id } = await loadBehaviorRow(parseRowId(request.params));
      return reply.send({ entries: await findRecentDmLog(id) });
    },
  );
}
