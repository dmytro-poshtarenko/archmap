import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { migrations } from "./migrations.js";

export type Db = Database.Database;

export const SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/** Applies every migration newer than the database, each in its own transaction. */
export function migrate(db: Db): number {
  const current = schemaVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(`database schema v${current} is newer than this tool (v${SCHEMA_VERSION})`);
  }
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
  return schemaVersion(db);
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}
