/**
 * Forward-only schema migrations. A migration is never edited after it has
 * been applied to a real workspace; schema changes go into a new entry.
 * The applied version is tracked with `PRAGMA user_version`.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "inventory",
    sql: `
      CREATE TABLE repo (
        id         TEXT PRIMARY KEY,
        url        TEXT NOT NULL,
        sha        TEXT NOT NULL,
        role       TEXT NOT NULL,
        licence    TEXT NOT NULL
      );

      CREATE TABLE code_unit (
        id      TEXT PRIMARY KEY,           -- '<repo>:<root>' with root '.' for the repository itself
        repo_id TEXT NOT NULL REFERENCES repo(id),
        root    TEXT NOT NULL,
        kind    TEXT NOT NULL CHECK (kind IN ('package', 'split', 'repo'))
      );

      CREATE TABLE component (
        id   TEXT PRIMARY KEY,
        kind TEXT NOT NULL
      );

      CREATE TABLE file (
        id          INTEGER PRIMARY KEY,
        repo_id     TEXT NOT NULL REFERENCES repo(id),
        path        TEXT NOT NULL,
        sha256      TEXT NOT NULL,
        bytes       INTEGER NOT NULL,
        loc         INTEGER NOT NULL,
        lang        TEXT,
        code_unit   TEXT REFERENCES code_unit(id),
        component   TEXT REFERENCES component(id),
        licence     TEXT NOT NULL,
        publishable INTEGER NOT NULL CHECK (publishable IN (0, 1)),
        split       TEXT NOT NULL CHECK (split IN ('dev', 'test', 'heldout')),
        UNIQUE (repo_id, path)
      );
      CREATE INDEX file_component ON file(component);
      CREATE INDEX file_unit ON file(code_unit);

      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];
