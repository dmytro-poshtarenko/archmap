import type { Migration } from "./migrate.js";

/** Schema of the method database (`data/db/<target>.sqlite`). */
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
  {
    version: 2,
    name: "extraction",
    sql: `
      -- Computed once per snapshot and rules; every method variant reads the same rows.
      CREATE TABLE call_site (
        id          TEXT PRIMARY KEY,         -- '<repo>:<path>:<line>:<column>'
        repo        TEXT NOT NULL,
        path        TEXT NOT NULL,
        line        INTEGER NOT NULL,
        end_line    INTEGER NOT NULL,
        col         INTEGER NOT NULL,
        type        TEXT NOT NULL CHECK (type IN ('http', 'ddp', 'broker', 'db', 'trigger')),
        role        TEXT NOT NULL CHECK (role IN ('request', 'publish', 'subscribe', 'access', 'schedule')),
        detector    TEXT NOT NULL,
        method      TEXT,                     -- JSON AbstractValue, HTTP only
        address     TEXT NOT NULL,            -- JSON AbstractValue
        display     TEXT NOT NULL,            -- readable address, e.g. {env:ORDERS_URL}/orders
        components  TEXT NOT NULL,            -- JSON array of the components that run this code
        lifted_from TEXT,                     -- '<repo>:<path>:<line>:<column>' of the call inside the wrapper
        FOREIGN KEY (repo, path) REFERENCES file(repo_id, path) ON DELETE CASCADE
      );
      CREATE INDEX call_site_file ON call_site(repo, path);
      CREATE INDEX call_site_type ON call_site(type);

      CREATE TABLE route (
        id         TEXT PRIMARY KEY,          -- '<repo>:<path>:<line>:<column>', '#n' for several routes of one declaration
        kind       TEXT NOT NULL CHECK (kind IN ('http', 'ddp-method', 'broker-action', 'event', 'collection', 'timer')),
        repo       TEXT NOT NULL,
        path       TEXT NOT NULL,
        line       INTEGER NOT NULL,
        col        INTEGER NOT NULL,
        method     TEXT,
        template   TEXT NOT NULL,
        detector   TEXT NOT NULL,
        source     TEXT NOT NULL CHECK (source IN ('rules', 'llm', 'catalog')),
        components TEXT NOT NULL,
        extra      TEXT,
        FOREIGN KEY (repo, path) REFERENCES file(repo_id, path) ON DELETE CASCADE
      );
      CREATE INDEX route_template ON route(kind, template);
    `,
  },
  {
    version: 3,
    name: "infrastructure",
    sql: `
      CREATE TABLE container (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        format     TEXT NOT NULL,
        source     TEXT NOT NULL,              -- '<repo>:<path>:<line>'
        component  TEXT,
        image      TEXT,
        hostnames  TEXT NOT NULL,              -- JSON array
        ports      TEXT NOT NULL,              -- JSON array
        env        TEXT NOT NULL               -- JSON object, after substitution
      );
      CREATE INDEX container_component ON container(component);

      CREATE TABLE gateway_rule (
        id        INTEGER PRIMARY KEY,
        gateway   TEXT NOT NULL,
        match     TEXT NOT NULL CHECK (match IN ('prefix', 'exact', 'regex')),
        path      TEXT NOT NULL,
        host      TEXT,
        strip     TEXT,
        replace   TEXT,
        target    TEXT NOT NULL,               -- container name
        priority  INTEGER NOT NULL,
        source    TEXT NOT NULL
      );
    `,
  },
];
