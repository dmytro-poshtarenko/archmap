import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TargetConfig } from "../config/schema.js";
import type { DataLayout } from "../core/paths.js";
import { type Db, getMeta } from "../store/db.js";
import { locateRepo } from "../workspace/repos.js";
import type { Split } from "./store.js";

export interface SourceFile {
  repo: string;
  path: string;
  lang: string | null;
  split: Split;
  component: string | null;
}

/**
 * The inventoried snapshot as the labelling side sees it: the file list and
 * the files' text. Only the inventory is read from the method database,
 * never anything the method computed.
 */
export interface Snapshot {
  files: SourceFile[];
  inventoryHash: string;
  has(repo: string, path: string): boolean;
  file(repo: string, path: string): SourceFile | undefined;
  /** Text of an inventoried file; anything else is refused. */
  read(repo: string, path: string): string;
}

export class SnapshotError extends Error {}

export function openSnapshot(db: Db, config: TargetConfig, layout: DataLayout, configPath: string): Snapshot {
  const inventoryHash = getMeta(db, "inventory.hash");
  if (inventoryHash === undefined) throw new SnapshotError("no inventory yet; run 'archmap inventory' first");
  const files = db
    .prepare("SELECT repo_id AS repo, path, lang, split, component FROM file ORDER BY repo_id, path")
    .all() as SourceFile[];
  const index = new Map(files.map((f) => [`${f.repo}:${f.path}`, f]));
  const dirs = new Map<string, string>();
  for (const repo of config.repos) {
    if (files.some((f) => f.repo === repo.id)) dirs.set(repo.id, locateRepo(repo, layout, configPath).dir);
  }
  return {
    files,
    inventoryHash,
    has: (repo, path) => index.has(`${repo}:${path}`),
    file: (repo, path) => index.get(`${repo}:${path}`),
    read(repo, path) {
      const dir = dirs.get(repo);
      if (dir === undefined || !index.has(`${repo}:${path}`)) throw new SnapshotError(`${repo}:${path} is not in the inventory`);
      return readFileSync(join(dir, path), "utf8");
    },
  };
}
