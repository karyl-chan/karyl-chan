/**
 * ADR 0003: remove continuous sessions together with the `break` and
 * `manual` system behaviors.
 *
 *   - delete the `manual` / `break` system rows (and their stats; the FK
 *     cascade is not relied on because SQLite may run without FK
 *     enforcement)
 *   - rewrite any `forwardType='continuous'` row to `one_time` and clear
 *     its now-meaningless `sessionExpireHours`
 *   - drop `behavior_sessions`
 *
 * The admin-login system row is untouched, so a DM `!login` (or `/login`)
 * keeps working across the upgrade. Their slash commands, if registered,
 * are removed by the boot-time reconcile: they are no longer in the
 * desired set and the reconciler owns them.
 *
 * Idempotent: each step is a no-op once applied.
 */

import type { MigrationFn } from "umzug";
import type { QueryInterface } from "sequelize";

const BEHAVIORS = "behaviors";
const STATS = "behavior_stats";
const SESSIONS = "behavior_sessions";
const REMOVED_SYSTEM_KEYS = ["manual", "break"];

export const up: MigrationFn<QueryInterface> = async ({ context: qi }) => {
  const tables = (await qi.showAllTables()) as string[];

  if (tables.includes(BEHAVIORS)) {
    const removed = (await qi.select(null, BEHAVIORS, {
      where: { source: "system", systemKey: REMOVED_SYSTEM_KEYS },
    })) as Array<{ id: number }>;
    const ids = removed.map((r) => r.id);
    if (ids.length > 0) {
      if (tables.includes(STATS)) {
        await qi.bulkDelete(STATS, { behaviorId: ids });
      }
      if (tables.includes(SESSIONS)) {
        await qi.bulkDelete(SESSIONS, { behaviorId: ids });
      }
      await qi.bulkDelete(BEHAVIORS, { id: ids });
    }

    const columns = await qi.describeTable(BEHAVIORS);
    if (columns["forwardType"]) {
      await qi.bulkUpdate(
        BEHAVIORS,
        {
          forwardType: "one_time",
          ...(columns["sessionExpireHours"] ? { sessionExpireHours: null } : {}),
        },
        { forwardType: "continuous" },
      );
    }
  }

  if (tables.includes(SESSIONS)) {
    await qi.dropTable(SESSIONS);
  }
};

export const down: MigrationFn<QueryInterface> = async () => {
  // Not reversible: the removed rows and sessions carry no data worth
  // restoring, and the runtime no longer understands them.
};
