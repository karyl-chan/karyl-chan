/**
 * DbDriver — abstraction over the relational store.
 *
 * The InProcess default is the existing `db.ts` Sequelize+SQLite stack.
 * Phase 2.1 of SCALING_PLAN swaps in a Postgres-backed driver behind
 * this same interface — same Sequelize dialect family, same migration
 * tooling (umzug), different connection string.
 *
 * We deliberately keep the surface tiny: anything that wants to talk
 * to the DB still imports the model classes; this interface only
 * exposes what the *boot path* needs to spin a driver up and down,
 * plus the `flavor` field that lets code branch on dialect for the
 * (rare) place where SQLite and Postgres have to be handled
 * differently (e.g. `bot_events` partitioning).
 */

import type { Sequelize } from "sequelize";

export type DbFlavor = "sqlite" | "postgres";

export interface DbDriver {
  readonly sequelize: Sequelize;
  readonly flavor: DbFlavor;
  /**
   * Run schema migrations to head. Called once at boot. Default
   * SQLite impl is `sequelize.sync()` (legacy); the Postgres impl
   * runs umzug against `migrations/`.
   */
  migrate(): Promise<void>;
  /** Graceful close. */
  close(): Promise<void>;
}
