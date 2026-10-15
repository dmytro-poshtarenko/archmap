import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrate.js";
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

export function migrate(db: Db): number {
  return runMigrations(db, migrations);
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
