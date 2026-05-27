import { Sequelize, Transaction, type Options } from "sequelize";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { config } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __dirname is `src/` in dev and `build/` in container; both share the
// same parent (the package root). Walk one level up, then into ./data.
// The previous form used `../data` which jumped one folder higher and
// resolved to a non-writable path inside the container (masked by
// SQLITE_DB_PATH in production compose, but broken on a clean image).
const DEFAULT_DB_PATH = resolve(dirname(__dirname), "data/database.sqlite");

/**
 * DB_URL takes priority — hook for Postgres connections. Falls back
 * to the legacy `SQLITE_DB_PATH` / hardcoded path so existing
 * single-host deployments are unchanged.
 *
 * Examples:
 *   (unset)                                         → SQLite at default path
 *   sqlite:/var/lib/karyl/database.sqlite           → SQLite explicit
 *   postgres://user:pw@host:5432/karyl              → Postgres
 *   postgres+ssl://user:pw@host:5432/karyl          → Postgres with SSL
 */
type Dialect = "sqlite" | "postgres";

function parseDbUrl(url: string): { dialect: Dialect; options: Options } {
  if (url.startsWith("sqlite:")) {
    const storage = url.slice("sqlite:".length) || DEFAULT_DB_PATH;
    return { dialect: "sqlite", options: { storage, dialect: "sqlite" } };
  }
  if (
    url.startsWith("postgres://") ||
    url.startsWith("postgresql://") ||
    url.startsWith("postgres+ssl://")
  ) {
    const ssl = url.startsWith("postgres+ssl://");
    const normalized = ssl
      ? url.replace("postgres+ssl://", "postgres://")
      : url;
    return {
      dialect: "postgres",
      options: {
        dialect: "postgres",
        dialectOptions: ssl
          ? { ssl: { require: true, rejectUnauthorized: false } }
          : {},
        // Pass the connection string straight through — Sequelize
        // handles parsing of user/pw/host/port/db.
        url: normalized as unknown as string,
      } as unknown as Options,
    };
  }
  throw new Error(
    `DB_URL '${url}' has an unrecognised scheme. Use sqlite:<path>, ` +
      `postgres://..., or unset for the default SQLite file.`,
  );
}

function buildDb(): { sequelize: Sequelize; dialect: Dialect } {
  const dbUrl = (process.env.DB_URL ?? "").trim();
  if (!dbUrl) {
    // Legacy path: SQLite at config.db.sqlitePath or DEFAULT_DB_PATH.
    return {
      dialect: "sqlite",
      sequelize: new Sequelize({
        storage: config.db.sqlitePath ?? DEFAULT_DB_PATH,
        dialect: "sqlite",
        logging: false,
        transactionType: Transaction.TYPES.IMMEDIATE,
        hooks: { afterConnect: sqliteAfterConnect },
      }),
    };
  }
  const { dialect, options } = parseDbUrl(dbUrl);
  const seqOptions: Options = {
    ...options,
    logging: false,
    transactionType: Transaction.TYPES.IMMEDIATE,
    // SQLite-specific pragmas only apply to SQLite connections.
    hooks: dialect === "sqlite" ? { afterConnect: sqliteAfterConnect } : {},
  };
  // For Postgres, Sequelize accepts the URL as a positional first arg.
  if (dialect === "postgres") {
    // `url` was injected into options just for routing; pull it back out.
    const { url: pgUrl, ...rest } = options as Options & { url?: string };
    const finalUrl = pgUrl ?? dbUrl;
    return {
      dialect,
      sequelize: new Sequelize(finalUrl, {
        ...rest,
        ...seqOptions,
        dialect: "postgres",
      }),
    };
  }
  return { dialect, sequelize: new Sequelize(seqOptions) };
}

async function sqliteAfterConnect(connection: unknown): Promise<void> {
  // SQLite needs per-connection PRAGMA tuning that doesn't survive the
  // raw open. afterConnect runs once per underlying connection in the
  // pool — single-connection today, but the hook is also correct for
  // any future pool expansion.
  //   foreign_keys = ON    : enforce FK constraints (off by default)
  //   journal_mode = WAL   : concurrent reader + single writer instead
  //                          of full-DB lock; massively reduces SQLITE_BUSY
  //                          when SSE handlers race audit writes.
  //   busy_timeout = 3000  : when a writer collides anyway, wait up to
  //                          3s for the lock instead of immediately
  //                          surfacing SQLITE_BUSY to the caller.
  const conn = connection as {
    run?: (sql: string, cb?: (err: Error | null) => void) => void;
  };
  if (typeof conn.run !== "function") return;
  const exec = (sql: string) =>
    new Promise<void>((resolveHook, reject) => {
      conn.run!(sql, (err) => (err ? reject(err) : resolveHook()));
    });
  await exec("PRAGMA foreign_keys = ON;");
  await exec("PRAGMA journal_mode = WAL;");
  await exec("PRAGMA busy_timeout = 3000;");
  await exec("PRAGMA synchronous = NORMAL;");
}

const built = buildDb();
export const sequelize = built.sequelize;
export const dbDialect = built.dialect;

/**
 * Retry a DB operation that still surfaces SQLITE_BUSY. With WAL +
 * busy_timeout + IMMEDIATE transactions a genuine BUSY is rare — only
 * a writer holding the lock past busy_timeout produces one — so this
 * is the last line of defence for writes that must not be silently
 * dropped (e.g. plugin-capability reconcile on concurrent register).
 *
 * For Postgres this is a near-noop — `database is locked` is not a
 * thing there. The retry remains because the same call sites run
 * under both dialects.
 */
export async function withBusyRetry<T>(
  op: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      const text =
        err instanceof Error
          ? `${err.message} ${(err as { parent?: Error }).parent?.message ?? ""}`
          : String(err);
      const busy =
        text.includes("SQLITE_BUSY") || text.includes("database is locked");
      if (!busy || attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}
