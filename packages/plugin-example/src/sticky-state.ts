/**
 * Sticky-note KV store — per-user notes scoped to a guild.
 *
 * Keys are `<guildId>:<userId>`; the row stores a single text body.
 * The "user-bound webui ↔ persisted state" demo: the WebUI loads the
 * note on mount, autosaves on every edit (debounced), and Discord's
 * `/example sticky show` slash command reads the same row back.
 *
 * Uses better-sqlite3 because every existing karyl-chan plugin does;
 * the storage layer isn't the point of this demo, so keep it boring.
 */

import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const DEFAULT_DB_PATH = "/app/data/example.db";

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  const path = process.env.EXAMPLE_DB_PATH ?? DEFAULT_DB_PATH;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  _db = new Database(path);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS stickies (
      guild_id  TEXT NOT NULL,
      user_id   TEXT NOT NULL,
      body      TEXT NOT NULL DEFAULT '',
      updated   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
  `);
  return _db;
}

export interface Sticky {
  body: string;
  updated: number;
}

export function getSticky(guildId: string, userId: string): Sticky {
  const row = db()
    .prepare<[string, string], { body: string; updated: number }>(
      `SELECT body, updated FROM stickies WHERE guild_id = ? AND user_id = ?`,
    )
    .get(guildId, userId);
  return row ?? { body: "", updated: 0 };
}

export function setSticky(
  guildId: string,
  userId: string,
  body: string,
): Sticky {
  const updated = Date.now();
  db()
    .prepare(
      `INSERT INTO stickies (guild_id, user_id, body, updated)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET body = excluded.body, updated = excluded.updated`,
    )
    .run(guildId, userId, body, updated);
  return { body, updated };
}

export function deleteSticky(guildId: string, userId: string): void {
  db()
    .prepare(`DELETE FROM stickies WHERE guild_id = ? AND user_id = ?`)
    .run(guildId, userId);
}

/** Manage surface: list all stickies for an admin. */
export function listStickies(
  guildId: string,
): Array<{ userId: string; body: string; updated: number }> {
  return db()
    .prepare<
      [string],
      { user_id: string; body: string; updated: number }
    >(
      `SELECT user_id, body, updated FROM stickies WHERE guild_id = ? ORDER BY updated DESC`,
    )
    .all(guildId)
    .map((r) => ({ userId: r.user_id, body: r.body, updated: r.updated }));
}
