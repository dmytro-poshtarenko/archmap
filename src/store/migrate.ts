import type { Db } from "./db.js";

/**
 * A forward-only schema migration. A migration is never edited after it has
 * been applied to a real workspace; schema changes go into a new entry.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Applies every migration newer than the database, each in its own
 * transaction, tracking the version with `PRAGMA user_version`.
 */
export function runMigrations(db: Db, migrations: Migration[]): number {
  const latest = migrations.at(-1)?.version ?? 0;
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > latest) throw new Error(`database schema v${current} is newer than this tool (v${latest})`);
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
  return db.pragma("user_version", { simple: true }) as number;
}
