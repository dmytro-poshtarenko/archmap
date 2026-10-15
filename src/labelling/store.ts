import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { DataLayout } from "../core/paths.js";
import type { Db } from "../store/db.js";
import { type Migration, runMigrations } from "../store/migrate.js";

export type Split = "dev" | "test" | "heldout";
export const SPLITS: Split[] = ["dev", "test", "heldout"];

/**
 * Why a labels database is opened. Annotating writes the annotator's own
 * labels; evaluating or exporting reads them as the reference.
 */
export type Access = "annotate" | "evaluate";

export class LabelsLockedError extends Error {}

/**
 * Candidates, the sample, gap-check files and the reference catalog: the text
 * search and what was drawn from it. None of it is a label.
 */
const CANDIDATE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "candidates",
    sql: `
      CREATE TABLE candidate (
        id        TEXT PRIMARY KEY,          -- '<repo>:<path>:<line>'
        repo      TEXT NOT NULL,
        path      TEXT NOT NULL,
        line      INTEGER NOT NULL,
        split     TEXT NOT NULL CHECK (split IN ('dev', 'test', 'heldout')),
        component TEXT,                      -- calling component per the inventory mapping
        stratum   TEXT NOT NULL,             -- interaction type of the first pattern that matched
        patterns  TEXT NOT NULL,             -- JSON array of matching pattern ids
        text_sha  TEXT NOT NULL              -- sha256 of the trimmed line, to detect drift
      );
      CREATE INDEX candidate_stratum ON candidate(stratum, split);

      CREATE TABLE sample (
        candidate TEXT PRIMARY KEY REFERENCES candidate(id),
        pool      TEXT NOT NULL CHECK (pool IN ('main', 'heldout')),
        rank      INTEGER NOT NULL,          -- labelling order within the pool
        double    INTEGER NOT NULL CHECK (double IN (0, 1)),
        UNIQUE (pool, rank)
      );

      CREATE TABLE gap_file (
        repo  TEXT NOT NULL,
        path  TEXT NOT NULL,
        split TEXT NOT NULL,
        rank  INTEGER NOT NULL UNIQUE,
        PRIMARY KEY (repo, path)
      );

      CREATE TABLE catalog (
        key       TEXT PRIMARY KEY,
        kind      TEXT NOT NULL,
        name      TEXT NOT NULL,
        component TEXT,
        source    TEXT,                      -- where the declaration was found, '<repo>:<path>:<line>'
        origin    TEXT NOT NULL CHECK (origin IN ('extracted', 'manual')),
        note      TEXT
      );

      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

/** Reference labels of one split. */
const LABEL_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "labels",
    sql: `
      CREATE TABLE label (
        item       TEXT NOT NULL,            -- '<repo>:<path>:<line>'
        annotator  TEXT NOT NULL,
        repo       TEXT NOT NULL,
        path       TEXT NOT NULL,
        line       INTEGER NOT NULL,
        end_line   INTEGER,                  -- last line of a call spanning several lines
        origin     TEXT NOT NULL CHECK (origin IN ('sample', 'gap', 'blind', 'manual')),
        is_site    INTEGER NOT NULL CHECK (is_site IN (0, 1)),
        type       TEXT CHECK (type IN ('http', 'ddp', 'broker', 'db', 'trigger')),
        target     TEXT,                     -- target key or 'NONE'
        case_no    INTEGER CHECK (case_no BETWEEN 1 AND 8),
        reason     TEXT,                     -- why it is not a site, or why the target is NONE
        note       TEXT,
        guide      TEXT NOT NULL,            -- version of the labelling guide followed
        updated_at TEXT NOT NULL,
        PRIMARY KEY (item, annotator),
        CHECK (end_line IS NULL OR end_line >= line),
        CHECK (is_site = 1 OR (type IS NULL AND target IS NULL AND case_no IS NULL)),
        CHECK (is_site = 0 OR (type IS NOT NULL AND target IS NOT NULL)),
        CHECK ((target IS NULL OR target = 'NONE') = (case_no IS NULL))
      );

      -- Append-only history of every save, for the labelling protocol.
      CREATE TABLE label_event (
        id        INTEGER PRIMARY KEY,
        item      TEXT NOT NULL,
        annotator TEXT NOT NULL,
        at        TEXT NOT NULL,
        label     TEXT NOT NULL              -- JSON of the saved label
      );

      -- Gap-check files an annotator has read in full.
      CREATE TABLE gap_review (
        repo      TEXT NOT NULL,
        path      TEXT NOT NULL,
        annotator TEXT NOT NULL,
        done_at   TEXT NOT NULL,
        PRIMARY KEY (repo, path, annotator)
      );

      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

export function labelsDir(layout: DataLayout, target: string): string {
  return join(layout.root, "labels", target);
}

export function openCandidates(layout: DataLayout, target: string): Db {
  return open(join(labelsDir(layout, target), "candidates.sqlite"), CANDIDATE_MIGRATIONS);
}

/**
 * Opens the labels of a split. The test split may be annotated at any time
 * but read as the reference only after the freeze; the held-out split exists
 * only after the freeze.
 */
export function openLabels(layout: DataLayout, target: string, split: Split, access: Access, frozen: boolean): Db {
  if (!frozen && split === "heldout") {
    throw new LabelsLockedError("the held-out labels are available only after the method is frozen");
  }
  if (!frozen && split === "test" && access === "evaluate") {
    throw new LabelsLockedError("the test labels can be read as the reference only after the method is frozen");
  }
  return open(join(labelsDir(layout, target), `${split}.sqlite`), LABEL_MIGRATIONS);
}

function open(file: string, migrations: Migration[]): Db {
  mkdirSync(join(file, ".."), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db, migrations);
  return db;
}
