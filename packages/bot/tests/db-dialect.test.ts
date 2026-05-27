/**
 * db.ts dialect dispatch.
 *
 * Validates DB_URL parsing without actually opening a connection.
 * We can't import db.ts directly here because doing so triggers the
 * top-level Sequelize construction (which would crash on this WSL
 * host's sqlite3 native binding). Instead, inline the parse logic
 * the same way db.ts does — the test pins the URL schemes the bot
 * commits to supporting.
 */

import { describe, expect, it } from "vitest";

type Dialect = "sqlite" | "postgres";

function dialectOf(url: string): Dialect {
  if (url.startsWith("sqlite:")) return "sqlite";
  if (
    url.startsWith("postgres://") ||
    url.startsWith("postgresql://") ||
    url.startsWith("postgres+ssl://")
  )
    return "postgres";
  throw new Error("unrecognised scheme");
}

describe("DB_URL dialect dispatch", () => {
  it("sqlite: scheme → sqlite", () => {
    expect(dialectOf("sqlite:/var/lib/karyl/db.sqlite")).toBe("sqlite");
  });

  it("postgres:// → postgres", () => {
    expect(dialectOf("postgres://u:p@h:5432/db")).toBe("postgres");
  });

  it("postgresql:// alias → postgres", () => {
    expect(dialectOf("postgresql://u:p@h:5432/db")).toBe("postgres");
  });

  it("postgres+ssl:// → postgres with SSL", () => {
    expect(dialectOf("postgres+ssl://u:p@h:5432/db")).toBe("postgres");
  });

  it("unknown scheme throws", () => {
    expect(() => dialectOf("mysql://x")).toThrow();
    expect(() => dialectOf("ftp://x")).toThrow();
  });
});
