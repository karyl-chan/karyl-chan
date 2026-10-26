/**
 * One-shot cleanup for #137 (from #116): an Audience Group exists only
 * while a message trigger refers to it, and its member list goes with the
 * last such trigger (behavior-group-member.model.ts). Lists left behind
 * before that rule — set for a group no trigger uses — are deleted here.
 * The count (and the group names) go to bot_events.
 *
 * Re-running deletes nothing new. There is no down: the rows are gone.
 */

import type { MigrationFn } from "umzug";
import { QueryTypes, type QueryInterface } from "sequelize";
import { botEventLog } from "../modules/bot-events/bot-event-log.js";

const UNUSED = `
  FROM "behavior_group_members"
  WHERE "groupName" NOT IN (
    SELECT "audienceGroupName" FROM "behavior_definitions"
    WHERE "triggerKind" = 'message' AND "audienceGroupName" IS NOT NULL
  )`;

async function hasTable(qi: QueryInterface, table: string): Promise<boolean> {
  try {
    await qi.describeTable(table);
    return true;
  } catch {
    return false;
  }
}

export const up: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  if (!(await hasTable(qi, "behavior_group_members"))) return;
  if (!(await hasTable(qi, "behavior_definitions"))) return;

  const rows = await qi.sequelize.query<{ groupName: string }>(
    `SELECT DISTINCT "groupName" ${UNUSED}`,
    { type: QueryTypes.SELECT },
  );
  const [{ count }] = await qi.sequelize.query<{ count: number | string }>(
    `SELECT COUNT(*) AS "count" ${UNUSED}`,
    { type: QueryTypes.SELECT },
  );
  const removed = Number(count);
  if (removed > 0) await qi.sequelize.query(`DELETE ${UNUSED}`);

  botEventLog.record(
    "info",
    "bot",
    `migration 013: removed ${removed} member row(s) of audience groups no message trigger uses`,
    { removed, groups: rows.map((r) => r.groupName) },
  );
};

export const down: MigrationFn<QueryInterface> = async () => {
  // the deleted member lists cannot be restored
};
