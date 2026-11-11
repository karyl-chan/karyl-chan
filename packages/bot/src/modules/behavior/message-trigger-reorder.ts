/**
 * PUT /api/behaviors/reorder (#121): order the Message Triggers of one
 * Message Trigger Location (CONTEXT.md) — `bot_dm`, `guild:all`,
 * `guild:<id>` or `channel:<guildId>:<channelId>`.
 *
 * Message triggers are matched in ONE order (sortOrder, then id) across
 * every location, because a guild message is checked against `guild:all`,
 * its guild and its channel together. Reordering one location therefore
 * keeps the slots its triggers occupy in that order and only changes which
 * of them sits in which slot: other locations' triggers stay exactly where
 * they were relative to everything else. The custom triggers are
 * renumbered 0..n-1 in the process, so slots that used to share one
 * sortOrder become distinct; the System Behavior's row is never written
 * (it keeps its sortOrder, -1000 as seeded, which pins it first), nor are
 * the Service Behaviors' (#126: SERVICE_SORT_ORDER pins them before the
 * login; the admin UI lists them apart), and the renumbering does not
 * bump any row's updatedAt.
 *
 * Concurrency: `ids` must be exactly the location's current triggers —
 * a trigger added, moved or deleted by someone else since the admin's list
 * was loaded makes it a stale request (409). The read and the renumbering
 * run in one behavior write transaction.
 */

import type { FastifyInstance } from "fastify";
import { BehaviorApiError } from "./behavior-api-error.js";
import { auditBehaviorWrite } from "./behavior-audit.js";
import { behaviorTransaction, withBehaviorWriteLock } from "./behavior-write-lock.js";
import {
  MESSAGE_TRIGGER_LOCATION_PATTERN,
  messageTriggerLocation,
} from "./message-trigger-rules.js";
import {
  BehaviorDefinition,
  isServiceBehavior,
  rowOfBehaviorDefinition,
} from "./models/behavior-definition.model.js";

const reorderSchema = {
  type: "object",
  properties: {
    location: { type: "string", pattern: MESSAGE_TRIGGER_LOCATION_PATTERN },
    ids: {
      type: "array",
      items: { type: "integer", minimum: 1 },
      uniqueItems: true,
      maxItems: 1000,
    },
  },
  required: ["location", "ids"],
  additionalProperties: false,
} as const;

interface ReorderBody {
  location: string;
  ids: number[];
}

/** Rows this route never moves: the login and the Service Behaviors. */
function isPinned(row: { systemKey: string | null; actionSource: string }): boolean {
  return row.systemKey !== null || isServiceBehavior(row);
}

function sameSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

export function registerMessageTriggerReorderRoute(server: FastifyInstance): void {
  server.put(
    "/api/behaviors/reorder",
    { schema: { body: reorderSchema } },
    async (request, reply) => {
      const { location, ids } = request.body as ReorderBody;

      await withBehaviorWriteLock(() =>
        behaviorTransaction(async (transaction) => {
          const all = (
            await BehaviorDefinition.findAll({
              where: { triggerKind: "message" },
              order: [
                ["sortOrder", "ASC"],
                ["id", "ASC"],
              ],
              transaction,
            })
          ).map((m) => ({ model: m, row: rowOfBehaviorDefinition(m) }));

          const atLocation = all.filter(
            ({ row }) =>
              messageTriggerLocation({
                surface: row.surface ?? "bot_dm",
                guildId: row.guildId,
                channelId: row.channelId,
              }) === location,
          );
          const pinned = atLocation.find(({ row }) => isPinned(row) && ids.includes(row.id));
          if (pinned) {
            throw new BehaviorApiError(
              "system_immutable",
              pinned.row.systemKey !== null
                ? "the system behavior stays pinned at the top of its location"
                : "a service's behavior stays pinned before the login",
              "ids",
            );
          }
          const movable = atLocation.filter(({ row }) => !isPinned(row));
          if (!sameSet(movable.map(({ row }) => row.id), ids)) {
            throw BehaviorApiError.stale(
              "ids",
              `the triggers at ${location} changed since this list was loaded; reload and retry`,
            );
          }

          // the location's slots, in matching order, refilled in the new
          // order; the System Behavior is not one of them and keeps its row
          // exactly as it is (#127: it is never changed here)
          const byId = new Map(movable.map((entry) => [entry.row.id, entry]));
          const queue = ids.map((id) => byId.get(id)!);
          const reordered = all
            .filter(({ row }) => !isPinned(row))
            .map((entry) => (byId.has(entry.row.id) ? queue.shift()! : entry));
          for (const [index, { model, row }] of reordered.entries()) {
            if (row.sortOrder !== index) {
              // silent: a new place in the order is not an edit — it must not
              // turn someone's pending ifUpdatedAt edit into a stale one
              await model.update({ sortOrder: index }, { transaction, silent: true });
            }
          }
        }),
      );

      await auditBehaviorWrite(request, "behavior.reorder", `location:${location}`, { ids });
      return reply.send({ location, ids });
    },
  );
}
