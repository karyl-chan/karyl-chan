/**
 * One-shot SQLite → Postgres DATA migration (PR-2.2).
 *
 * Schema is intentionally NOT created here. The bot is the single source
 * of truth for the schema (sync() + umzug migrations at boot), so the
 * migration procedure is:
 *
 *   1. Point the bot at the EMPTY Postgres once so it builds the schema:
 *        DB_URL=postgres://user:pw@host:5432/karyl \
 *        BOT_SKIP_DISCORD=true node build/main.js   # let it boot, then stop
 *   2. Copy the rows with this script:
 *        node build/scripts/migrate-sqlite-to-pg.js \
 *          ./data/database.sqlite \
 *          postgres://user:pw@host:5432/karyl
 *   3. Start the bot for real against Postgres.
 *
 * Type correctness: the copy is generic (no model imports) but type-safe —
 * every value is cast to the TARGET column's actual type, read from
 * information_schema, so SQLite's loose storage (0/1 for booleans, ISO
 * strings for timestamps, TEXT for json) lands correctly in Postgres's
 * strict columns. FK ordering is sidestepped by disabling replication
 * triggers for the load (requires the target role to be table owner /
 * superuser — the usual migration credential). Identity/serial sequences
 * are reset afterwards so future inserts don't collide with copied PKs.
 *
 * `bot_events` lives in its OWN SQLite file when the main DB is SQLite, so
 * it is not in the source DB and not migrated — it's high-churn diagnostic
 * log data that doesn't need to survive the cutover. Migrate it separately
 * by pointing this script at the bot_events sqlite file if you must.
 */

import { Sequelize, QueryTypes } from "sequelize";

/** Postgres data_type → a cast applied to each bound placeholder, so a
 *  loosely-typed SQLite value coerces into the strict target column. */
function castFor(dataType: string): string {
  switch (dataType) {
    case "boolean":
      return "::boolean";
    case "json":
      return "::json";
    case "jsonb":
      return "::jsonb";
    case "timestamp with time zone":
      return "::timestamptz";
    case "timestamp without time zone":
      return "::timestamp";
    case "date":
      return "::date";
    case "integer":
    case "smallint":
      return "::integer";
    case "bigint":
      return "::bigint";
    case "double precision":
    case "real":
    case "numeric":
      return "::double precision";
    default:
      return ""; // text / varchar / uuid / bytea — bind as-is
  }
}

/** Coerce a raw SQLite value into a JS value the cast above accepts. */
function coerce(value: unknown, dataType: string): unknown {
  if (value === null || value === undefined) return null;
  switch (dataType) {
    case "boolean":
      return (
        value === true || value === 1 || value === "1" || value === "true" || value === "t"
      );
    case "json":
    case "jsonb":
      // SQLite stores json as TEXT; pass valid json text through, stringify
      // anything already parsed.
      return typeof value === "string" ? value : JSON.stringify(value);
    case "timestamp with time zone":
    case "timestamp without time zone":
    case "date":
      return value instanceof Date ? value.toISOString() : String(value);
    default:
      return value;
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface MigrateResult {
  /** table → rows copied */
  copied: Record<string, number>;
  /** tables present in source but absent in target (skipped) */
  skippedMissingTarget: string[];
  /** sequences reset */
  sequencesReset: string[];
}

const SKIP_TABLES = new Set(["SequelizeMeta", "sqlite_sequence"]);
const CHUNK = 500;

/**
 * Copy all data tables from `source` (SQLite) into `target` (Postgres).
 * The target schema must already exist (see file header). Idempotent at
 * the row level via ON CONFLICT DO NOTHING.
 */
export async function migrateData(
  source: Sequelize,
  target: Sequelize,
  log: (msg: string) => void = () => {},
): Promise<MigrateResult> {
  const result: MigrateResult = {
    copied: {},
    skippedMissingTarget: [],
    sequencesReset: [],
  };

  const sourceTables = (
    await source.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      { type: QueryTypes.SELECT },
    )
  )
    .map((r) => r.name)
    .filter((t) => !SKIP_TABLES.has(t));

  // Bulk-load with FK/triggers off so table order doesn't matter.
  const tx = await target.transaction();
  try {
    await target.query("SET session_replication_role = 'replica'", {
      transaction: tx,
    });

    for (const table of sourceTables) {
      const cols = await target.query<{
        column_name: string;
        data_type: string;
      }>(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        { type: QueryTypes.SELECT, bind: [table], transaction: tx },
      );
      if (cols.length === 0) {
        result.skippedMissingTarget.push(table);
        log(`skip ${table}: not present in target schema`);
        continue;
      }
      const typeOf = new Map(cols.map((c) => [c.column_name, c.data_type]));

      const rows = await source.query<Record<string, unknown>>(
        `SELECT * FROM "${table}"`,
        { type: QueryTypes.SELECT },
      );
      if (rows.length === 0) {
        result.copied[table] = 0;
        continue;
      }

      // Only copy columns that exist on BOTH sides.
      const columns = Object.keys(rows[0]).filter((c) => typeOf.has(c));
      const quotedCols = columns.map((c) => `"${c}"`).join(", ");

      let copied = 0;
      for (const part of chunk(rows, CHUNK)) {
        const bind: unknown[] = [];
        const valuesSql = part
          .map((row) => {
            const placeholders = columns.map((col) => {
              const dt = typeOf.get(col)!;
              bind.push(coerce(row[col], dt));
              return `$${bind.length}${castFor(dt)}`;
            });
            return `(${placeholders.join(", ")})`;
          })
          .join(", ");
        await target.query(
          `INSERT INTO "${table}" (${quotedCols}) VALUES ${valuesSql}
           ON CONFLICT DO NOTHING`,
          { bind, transaction: tx },
        );
        copied += part.length;
      }
      result.copied[table] = copied;
      log(`copied ${table}: ${copied} rows`);
    }

    await target.query("SET session_replication_role = 'origin'", {
      transaction: tx,
    });
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  // Reset identity/serial sequences so the next INSERT picks up after the
  // highest copied PK instead of colliding with it.
  const seqCols = await target.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'`,
    { type: QueryTypes.SELECT },
  );
  for (const { table_name, column_name } of seqCols) {
    if (result.copied[table_name] == null) continue;
    await target.query(
      `SELECT setval(
         pg_get_serial_sequence('"${table_name}"', '${column_name}'),
         GREATEST((SELECT MAX("${column_name}") FROM "${table_name}"), 1)
       )`,
    );
    result.sequencesReset.push(`${table_name}.${column_name}`);
  }

  return result;
}

/** CLI entry. */
async function main(): Promise<void> {
  const sourcePath = process.env.SOURCE_SQLITE ?? process.argv[2];
  const targetUrl = process.env.TARGET_PG_URL ?? process.argv[3];
  if (!sourcePath || !targetUrl) {
    console.error(
      "Usage: node build/scripts/migrate-sqlite-to-pg.js <source.sqlite> <postgres-url>\n" +
        "   or: SOURCE_SQLITE=... TARGET_PG_URL=... node build/scripts/migrate-sqlite-to-pg.js\n\n" +
        "The target schema must already exist — boot the bot once against the\n" +
        "empty Postgres first (see this file's header).",
    );
    process.exit(2);
  }

  const source = new Sequelize({
    dialect: "sqlite",
    storage: sourcePath,
    logging: false,
  });
  const target = new Sequelize(targetUrl, { dialect: "postgres", logging: false });

  try {
    await source.authenticate();
    await target.authenticate();
    const res = await migrateData(source, target, (m) => console.log(m));
    const totalRows = Object.values(res.copied).reduce((a, b) => a + b, 0);
    console.log(
      `\nDone. ${totalRows} rows across ${Object.keys(res.copied).length} tables; ` +
        `${res.sequencesReset.length} sequences reset.`,
    );
    if (res.skippedMissingTarget.length > 0) {
      console.log(
        `Skipped (no target table): ${res.skippedMissingTarget.join(", ")}`,
      );
    }
  } finally {
    await source.close();
    await target.close();
  }
}

// Run only when invoked directly, not when imported by the test.
if (
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`
) {
  main().catch((err) => {
    console.error("migration failed:", err);
    process.exit(1);
  });
}
