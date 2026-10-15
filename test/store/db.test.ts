import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { getMeta, migrate, openDb, SCHEMA_VERSION, schemaVersion, setMeta } from "../../src/store/db.js";
import { tempDir } from "../helpers.js";

describe("store", () => {
  it("migrates a new database to the latest schema", () => {
    const db = openDb(":memory:");
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
    expect(tables).toEqual(expect.arrayContaining(["repo", "code_unit", "component", "file", "meta"]));
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("is idempotent across reopenings", () => {
    const file = join(tempDir(), "db", "t.sqlite");
    const db = openDb(file);
    setMeta(db, "k", "v1");
    setMeta(db, "k", "v2");
    db.close();
    const again = openDb(file);
    expect(migrate(again)).toBe(SCHEMA_VERSION);
    expect(getMeta(again, "k")).toBe("v2");
    expect(again.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("refuses a database written by a newer tool", () => {
    const file = join(tempDir(), "newer.sqlite");
    const raw = new Database(file);
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => openDb(file)).toThrow(/newer than this tool/);
  });

  it("enforces the split values", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO repo(id, url, sha, role, licence) VALUES ('r', 'u', 's', 'main', 'MIT')").run();
    const insert = (split: string) =>
      db
        .prepare(
          `INSERT INTO file(repo_id, path, sha256, bytes, loc, licence, publishable, split)
           VALUES ('r', ?, 'h', 1, 1, 'MIT', 1, ?)`,
        )
        .run(`f-${split}`, split);
    expect(() => insert("heldout")).not.toThrow();
    expect(() => insert("train")).toThrow(/CHECK/);
  });
});
