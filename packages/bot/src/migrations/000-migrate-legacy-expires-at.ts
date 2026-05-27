/**
 * Rewrite legacy `behavior_session.expiresAt` values into ISO 8601.
 *
 * Pre-L-2 the column was declared `DataTypes.DATE` and Sequelize's
 * SQLite adapter wrote `"YYYY-MM-DD HH:MM:SS.sss +00:00"`. After L-2
 * the column became STRING with `new Date().toISOString()` writers
 * (`"YYYY-MM-DDTHH:MM:SS.sssZ"`). New `Op.lt` / `Op.gt` queries
 * lexicographically compare ISO strings; the legacy format sorts
 * differently and silently mis-orders.
 *
 * This was previously a per-boot helper (`migrateLegacyExpiresAt`)
 * that scanned the table every time. Recasting it as the first proper
 * migration:
 *   - existing deployments: function is idempotent, finds nothing
 *     left to rewrite (the legacy boot call already cleaned it up
 *     over previous restarts), gets recorded as applied, future boots
 *     skip the scan entirely
 *   - fresh deployments: empty table → no-op → recorded as applied
 */

import type { MigrationFn } from "umzug";
import type { QueryInterface } from "sequelize";
import { migrateLegacyExpiresAt } from "../modules/behavior/models/behavior-session.model.js";

export const up: MigrationFn<QueryInterface> = async () => {
  await migrateLegacyExpiresAt();
};

export const down: MigrationFn<QueryInterface> = async () => {
  // Down-migration intentionally absent: the legacy format is a
  // strictly worse representation and we never want to recreate it.
  // umzug.down() on this migration is a no-op.
};
