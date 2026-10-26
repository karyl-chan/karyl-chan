/**
 * Rewrote legacy `behavior_session.expiresAt` values into ISO 8601.
 *
 * Superseded: continuous sessions were removed by ADR 0003 and
 * migration 010 drops the `behavior_sessions` table, so there is
 * nothing left to rewrite. Kept as a no-op so the SequelizeMeta ledger
 * of existing deployments stays consistent.
 */

import type { MigrationFn } from "umzug";
import type { QueryInterface } from "sequelize";

export const up: MigrationFn<QueryInterface> = async () => {};

export const down: MigrationFn<QueryInterface> = async () => {};
