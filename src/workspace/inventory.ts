import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import picomatch from "picomatch";
import { globSync } from "tinyglobby";
import { type ComponentConfig, type RepoConfig, splitRepoGlob, type TargetConfig } from "../config/schema.js";
import { sha256Hex } from "../core/hash.js";
import type { DataLayout } from "../core/paths.js";
import { unitInterval } from "../core/prng.js";
import { type Db, setMeta } from "../store/db.js";
import { locateRepo } from "./repos.js";

export type Split = "dev" | "test" | "heldout";
export type UnitKind = "package" | "split" | "repo";

export interface InventoryFile {
  repoId: string;
  path: string;
  sha256: string;
  bytes: number;
  /** Non-blank lines; 0 for binary files. */
  loc: number;
  lang: string | null;
  codeUnit: string;
  component: string | null;
  licence: string;
  publishable: boolean;
  split: Split;
}

export interface CodeUnit {
  id: string;
  repoId: string;
  root: string;
  kind: UnitKind;
}

export interface RepoInventory {
  repo: RepoConfig;
  sha: string;
  units: CodeUnit[];
  files: InventoryFile[];
}

export interface InventoryResult {
  hash: string;
  repos: Array<{ id: string; sha: string; files: number; units: number; splits: Record<Split, number> }>;
  skipped: string[];
}

export class InventoryError extends Error {}

/** Directories never inventoried, on top of the config's `exclude`. */
export const ALWAYS_EXCLUDED = [".git/**", "**/node_modules/**"];

const PICO = { dot: true } as const;

/**
 * Describes every file of every repository: content hash, size, code unit,
 * component, licence zone and dev/test split. Re-running it on the same
 * snapshots and config produces the same rows and the same inventory hash.
 */
export function runInventory(
  db: Db,
  config: TargetConfig,
  layout: DataLayout,
  configPath: string,
  opts: { allowHeldout: boolean; configHash: string; log?: (message: string) => void },
): InventoryResult {
  const inventories: RepoInventory[] = [];
  const skipped: string[] = [];
  for (const repo of config.repos) {
    if (repo.role === "heldout" && !opts.allowHeldout) {
      opts.log?.(`${repo.id}: held out until the method is frozen, skipped`);
      skipped.push(repo.id);
      continue;
    }
    const loc = locateRepo(repo, layout, configPath);
    if (!loc.present) throw new InventoryError(`repo '${repo.id}' is not available at ${loc.dir}; run 'archmap fetch' first`);
    inventories.push(inventoryRepo(repo, loc.sha, loc.dir, config));
  }
  writeInventory(db, config, inventories, skipped);
  const hash = inventoryHash(db);
  setMeta(db, "inventory.hash", hash);
  setMeta(db, "inventory.configHash", opts.configHash);
  return {
    hash,
    skipped,
    repos: inventories.map((inv) => ({
      id: inv.repo.id,
      sha: inv.sha,
      files: inv.files.length,
      units: inv.units.length,
      splits: countSplits(inv.files),
    })),
  };
}

export function inventoryRepo(repo: RepoConfig, sha: string, dir: string, config: TargetConfig): RepoInventory {
  const paths = globSync(["**"], {
    cwd: dir,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    expandDirectories: false,
    ignore: [...ALWAYS_EXCLUDED, ...config.exclude],
  })
    .filter((p) => !lstatSync(join(dir, p)).isSymbolicLink())
    .sort();

  const units = codeUnits(repo.id, paths, globsFor(config.codeUnits.splitDirs, repo.id));
  const unitOf = unitResolver(units);
  const componentOf = componentResolver(repo.id, config.components);
  const zoneOf = licenceResolver(repo, config);

  const files = paths.map((path): InventoryFile => {
    const content = readFileSync(join(dir, path));
    const zone = zoneOf(path);
    return {
      repoId: repo.id,
      path,
      sha256: sha256Hex(content),
      bytes: content.length,
      loc: isBinary(content) ? 0 : countLoc(content.toString("utf8")),
      lang: languageOf(path),
      codeUnit: unitOf(path),
      component: componentOf(path),
      licence: zone.licence,
      publishable: zone.publishable,
      split: splitOf(repo, path, config.experiment.seeds.split, config.experiment.devShare),
    };
  });
  return { repo, sha, units, files };
}

/** File-level split: the same file always lands in the same part for a given seed. */
export function splitOf(repo: RepoConfig, path: string, seed: number, devShare: number): Split {
  if (repo.role === "heldout") return "heldout";
  return unitInterval(sha256Hex(`${seed}|${repo.id}|${path}`)) < devShare ? "dev" : "test";
}

/**
 * Code units are the directories holding a `package.json`, the configured
 * split directories, and the repository root when it has no `package.json`.
 */
export function codeUnits(repoId: string, paths: string[], splitGlobs: string[]): CodeUnit[] {
  const roots = new Map<string, UnitKind>();
  for (const p of paths) {
    if (posix.basename(p) === "package.json") roots.set(posix.dirname(p), "package");
  }
  if (splitGlobs.length > 0) {
    const isSplit = picomatch(splitGlobs, PICO);
    for (const d of directoriesOf(paths)) {
      if (!roots.has(d) && isSplit(d)) roots.set(d, "split");
    }
  }
  if (!roots.has(".")) roots.set(".", "repo");
  return [...roots.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([root, kind]) => ({ id: `${repoId}:${root}`, repoId, root, kind }));
}

function unitResolver(units: CodeUnit[]): (path: string) => string {
  const byRoot = new Map(units.map((u) => [u.root, u.id]));
  return (path) => {
    for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
      const id = byRoot.get(dir);
      if (id !== undefined) return id;
      if (dir === ".") throw new InventoryError(`no code unit for ${path}`);
    }
  };
}

/**
 * Each file goes to the component whose matching include glob is the most
 * specific (longest literal prefix, then most literal characters); ties go to
 * the component declared first. Files no component claims stay unmapped.
 */
export function componentResolver(repoId: string, components: ComponentConfig[]): (path: string) => string | null {
  const compiled = components.map((c, order) => ({
    id: c.id,
    order,
    includes: globsFor(c.include, repoId).map((g) => ({ match: picomatch(g, PICO), score: specificity(g) })),
    exclude: globsFor(c.exclude, repoId).length > 0 ? picomatch(globsFor(c.exclude, repoId), PICO) : () => false,
  }));
  return (path) => {
    let best: { id: string; score: [number, number]; order: number } | undefined;
    for (const c of compiled) {
      if (c.exclude(path)) continue;
      for (const inc of c.includes) {
        if (!inc.match(path)) continue;
        if (best === undefined || compareScore(inc.score, best.score) > 0) {
          best = { id: c.id, score: inc.score, order: c.order };
        }
      }
    }
    return best?.id ?? null;
  };
}

export function specificity(glob: string): [number, number] {
  const special = glob.search(/[*?[\]{}()!+@]/);
  const prefix = special === -1 ? glob.length : special;
  return [prefix, glob.replace(/[*?[\]{}()!+@]/g, "").length];
}

function compareScore(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

export function licenceResolver(repo: RepoConfig, config: TargetConfig): (path: string) => { licence: string; publishable: boolean } {
  const zones = config.licenceZones
    .filter((z) => z.repo === repo.id)
    .map((z) => ({ match: picomatch(z.globs, PICO), licence: z.licence, publishable: z.publishable }));
  const fallback = { licence: repo.licence, publishable: repo.publishable };
  return (path) => zones.find((z) => z.match(path)) ?? fallback;
}

function globsFor(repoGlobs: string[], repoId: string): string[] {
  return repoGlobs.map(splitRepoGlob).filter((g) => g.repo === repoId).map((g) => g.glob);
}

function directoriesOf(paths: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) {
    for (let d = posix.dirname(p); d !== "." && !dirs.has(d); d = posix.dirname(d)) dirs.add(d);
  }
  return dirs;
}

export function isBinary(content: Uint8Array): boolean {
  return content.subarray(0, 8000).includes(0);
}

export function countLoc(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") n++;
  return n;
}

const LANGUAGES: Record<string, string> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".tf": "hcl",
  ".conf": "conf",
  ".md": "md",
  ".sh": "sh",
};

export function languageOf(path: string): string | null {
  const base = posix.basename(path);
  if (base === "Dockerfile" || base.startsWith("Dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "env";
  return LANGUAGES[posix.extname(base).toLowerCase()] ?? null;
}

function countSplits(files: InventoryFile[]): Record<Split, number> {
  const out: Record<Split, number> = { dev: 0, test: 0, heldout: 0 };
  for (const f of files) out[f.split]++;
  return out;
}

/**
 * Upserts rather than replaces, so a file keeps its row id across re-runs on
 * the same snapshot; rows of files, units and components that disappeared are
 * removed. Repositories skipped as held out keep whatever rows they had.
 */
function writeInventory(db: Db, config: TargetConfig, inventories: RepoInventory[], skipped: string[]): void {
  const upsertRepo = db.prepare(
    `INSERT INTO repo(id, url, sha, role, licence) VALUES (@id, @url, @sha, @role, @licence)
     ON CONFLICT(id) DO UPDATE SET url = excluded.url, sha = excluded.sha, role = excluded.role, licence = excluded.licence`,
  );
  const upsertComponent = db.prepare(
    "INSERT INTO component(id, kind) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind",
  );
  const upsertUnit = db.prepare(
    `INSERT INTO code_unit(id, repo_id, root, kind) VALUES (@id, @repoId, @root, @kind)
     ON CONFLICT(id) DO UPDATE SET repo_id = excluded.repo_id, root = excluded.root, kind = excluded.kind`,
  );
  const upsertFile = db.prepare(
    `INSERT INTO file(repo_id, path, sha256, bytes, loc, lang, code_unit, component, licence, publishable, split)
     VALUES (@repoId, @path, @sha256, @bytes, @loc, @lang, @codeUnit, @component, @licence, @publishable, @split)
     ON CONFLICT(repo_id, path) DO UPDATE SET sha256 = excluded.sha256, bytes = excluded.bytes, loc = excluded.loc,
       lang = excluded.lang, code_unit = excluded.code_unit, component = excluded.component,
       licence = excluded.licence, publishable = excluded.publishable, split = excluded.split`,
  );

  db.transaction(() => {
    const keptRepos = new Set([...inventories.map((i) => i.repo.id), ...skipped]);
    for (const c of config.components) upsertComponent.run(c.id, c.kind);
    for (const inv of inventories) {
      const r = inv.repo;
      upsertRepo.run({ id: r.id, url: r.url ?? r.path ?? "", sha: inv.sha, role: r.role, licence: r.licence });
      for (const u of inv.units) upsertUnit.run(u);
      for (const f of inv.files) upsertFile.run({ ...f, publishable: f.publishable ? 1 : 0 });
      const paths = JSON.stringify(inv.files.map((f) => f.path));
      db.prepare("DELETE FROM file WHERE repo_id = ? AND path NOT IN (SELECT value FROM json_each(?))").run(r.id, paths);
      const units = JSON.stringify(inv.units.map((u) => u.id));
      db.prepare("DELETE FROM code_unit WHERE repo_id = ? AND id NOT IN (SELECT value FROM json_each(?))").run(r.id, units);
    }
    const repoIds = JSON.stringify([...keptRepos]);
    db.prepare("DELETE FROM file WHERE repo_id NOT IN (SELECT value FROM json_each(?))").run(repoIds);
    db.prepare("DELETE FROM code_unit WHERE repo_id NOT IN (SELECT value FROM json_each(?))").run(repoIds);
    db.prepare("DELETE FROM repo WHERE id NOT IN (SELECT value FROM json_each(?))").run(repoIds);
    db.prepare("DELETE FROM component WHERE id NOT IN (SELECT value FROM json_each(?))").run(
      JSON.stringify(config.components.map((c) => c.id)),
    );
  })();
}

/** Hash of the stored inventory, independent of insertion order and row ids. */
export function inventoryHash(db: Db): string {
  const h = createHash("sha256");
  for (const row of db.prepare("SELECT id, sha, role, licence FROM repo ORDER BY id").raw().iterate()) {
    h.update(`${JSON.stringify(row)}\n`);
  }
  const files = db
    .prepare(
      `SELECT repo_id, path, sha256, bytes, loc, lang, code_unit, component, licence, publishable, split
       FROM file ORDER BY repo_id, path`,
    )
    .raw();
  for (const row of files.iterate()) h.update(`${JSON.stringify(row)}\n`);
  return h.digest("hex");
}
