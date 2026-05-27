# DB migrations

Each file here is a one-shot schema or data migration applied by the
umzug runner in `src/db-migrations.ts`. Already-applied migrations are
tracked in a `SequelizeMeta` table on the target connection.

## When to add one

`sequelize.sync()` runs first at boot and CREATEs missing tables. It
does NOT ALTER existing tables — so any of the following needs a
migration:

- adding / dropping / renaming a column on a long-lived table
- changing a column type or default
- adding / dropping an index that the runtime relies on
- backfilling data after the above
- one-shot housekeeping (deleting orphaned rows, recomputing
  derived columns) where re-running it every boot would be wasteful

If you're adding a brand-new table, `sync()` will pick it up — no
migration needed unless you also need a backfill.

## File naming

`NNN-short-description.ts` where `NNN` is a zero-padded monotonic
counter. Umzug sorts lexically, so the prefix is the source of truth
for execution order.

## Shape

```ts
import type { MigrationFn } from "umzug";
import type { QueryInterface } from "sequelize";

export const up: MigrationFn<QueryInterface> = async (params) => {
  const qi = params.context;
  await qi.addColumn("plugins", "new_field", {
    type: DataTypes.STRING,
    allowNull: true,
  });
};

export const down: MigrationFn<QueryInterface> = async (params) => {
  const qi = params.context;
  await qi.removeColumn("plugins", "new_field");
};
```

Idempotency is your friend — re-running a partially-failed migration
after a fix should not double-apply changes (e.g. check column
existence before `addColumn`).

## Two DBs

When the bot runs on SQLite, `bot_events` lives in its own file (Phase
0.7) and gets its own `SequelizeMeta`. Migrations for that DB go in
a future `migrations-bot-events/` directory if/when needed; for now
the runner is only wired to the main DB because `bot_events`'s schema
is stable. Under Postgres both share the main connection so a single
migrations directory suffices.

## Local dev

```bash
# After adding a new migration, restart the bot:
pnpm dev    # ts-node picks up *.ts straight from src/migrations/

# Or, against a built container:
docker compose -f docker-compose.bot.yml up --build -d bot
```

The runner logs every applied migration via the `db-migrations` pino
logger.
