import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { globSync } from "tinyglobby";
import type { TargetConfig } from "../config/schema.js";
import { hashOf, sha256Hex } from "../core/hash.js";
import { type DataLayout, repoDirName } from "../core/paths.js";
import { GitError, listWorkingFiles } from "./git.js";
import { ALWAYS_EXCLUDED, isBinary, licenceResolver } from "./inventory.js";
import { LOCAL_SHA, locateRepo } from "./repos.js";

/** Consecutive non-trivial lines that make up one fingerprint. */
export const WINDOW = 6;
/** Normalised lines shorter than this carry too little to count. */
export const MIN_LINE_LENGTH = 10;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ALGORITHM = { version: 1, window: WINDOW, minLine: MIN_LINE_LENGTH };
const SKIPPED_FILES = /(^|\/)(yarn\.lock|pnpm-lock\.yaml|package-lock\.json)$|\.(lock|map|snap)$/;

export interface Finding {
  file: string;
  startLine: number;
  endLine: number;
  /** `repo:path:line` of the first protected line that matched. */
  source: string;
}

export interface LicenceCheckResult {
  protectedRepos: Array<{ id: string; files: number; fingerprints: number; cached: boolean }>;
  /** Repos with protected zones that could not be fingerprinted (not fetched, or held out). */
  unavailable: string[];
  scanned: number;
  findings: Finding[];
}

export function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

function isTrivial(normalized: string): boolean {
  return normalized.length < MIN_LINE_LENGTH || !/[A-Za-z0-9]/.test(normalized);
}

/** Fingerprints of every window of `WINDOW` consecutive non-trivial lines, with the window's first line number. */
export function fingerprintText(text: string): Array<{ fp: string; line: number; endLine: number }> {
  const lines: Array<{ text: string; line: number }> = [];
  text.split("\n").forEach((raw, i) => {
    const norm = normalizeLine(raw);
    if (!isTrivial(norm)) lines.push({ text: norm, line: i + 1 });
  });
  const out: Array<{ fp: string; line: number; endLine: number }> = [];
  for (let i = 0; i + WINDOW <= lines.length; i++) {
    const window = lines.slice(i, i + WINDOW);
    out.push({
      fp: sha256Hex(window.map((l) => l.text).join("\n")).slice(0, 16),
      line: window[0]?.line ?? 0,
      endLine: window[WINDOW - 1]?.line ?? 0,
    });
  }
  return out;
}

function readText(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
  const content = readFileSync(file);
  return isBinary(content) ? undefined : content.toString("utf8");
}

/**
 * Builds (or loads from `data/fingerprints`) the fingerprints of every file
 * that may not be published, then looks for them in the files of `scanRoot`:
 * tracked and untracked-but-not-ignored files when it is a git repository,
 * every file otherwise.
 */
export function licenceCheck(
  config: TargetConfig,
  layout: DataLayout,
  configPath: string,
  opts: { scanRoot: string; allowHeldout: boolean; log?: (message: string) => void },
): LicenceCheckResult {
  const fingerprints = new Map<string, string>();
  const protectedRepos: LicenceCheckResult["protectedRepos"] = [];
  const unavailable: string[] = [];

  for (const repo of config.repos) {
    const zones = config.licenceZones.filter((z) => z.repo === repo.id);
    if (repo.publishable && zones.every((z) => z.publishable)) continue;
    if (repo.role === "heldout" && !opts.allowHeldout) {
      unavailable.push(repo.id);
      continue;
    }
    const loc = locateRepo(repo, layout, configPath);
    if (!loc.present) {
      unavailable.push(repo.id);
      continue;
    }
    const key = hashOf({ ALGORITHM, zones, licence: repo.licence, publishable: repo.publishable }).slice(0, 12);
    const cacheFile = join(layout.fingerprints, `${repoDirName(repo.id, loc.sha)}-${key}.json`);
    let entries: Record<string, string>;
    let files: number;
    const cached = loc.sha !== LOCAL_SHA && existsSync(cacheFile);
    if (cached) {
      ({ entries, files } = JSON.parse(readFileSync(cacheFile, "utf8")) as { entries: Record<string, string>; files: number });
    } else {
      opts.log?.(`${repo.id}: fingerprinting protected files`);
      const zoneOf = licenceResolver(repo, config);
      const paths = globSync(["**"], { cwd: loc.dir, dot: true, onlyFiles: true, followSymbolicLinks: false, ignore: ALWAYS_EXCLUDED })
        .filter((p) => !zoneOf(p).publishable && !SKIPPED_FILES.test(p))
        .sort();
      entries = {};
      files = 0;
      for (const path of paths) {
        const text = readText(join(loc.dir, path));
        if (text === undefined) continue;
        files++;
        for (const w of fingerprintText(text)) entries[w.fp] ??= `${repo.id}:${path}:${w.line}`;
      }
      if (loc.sha !== LOCAL_SHA) {
        mkdirSync(layout.fingerprints, { recursive: true });
        writeFileSync(cacheFile, JSON.stringify({ ...ALGORITHM, repo: repo.id, sha: loc.sha, files, entries }));
      }
    }
    for (const [fp, where] of Object.entries(entries)) if (!fingerprints.has(fp)) fingerprints.set(fp, where);
    protectedRepos.push({ id: repo.id, files, fingerprints: Object.keys(entries).length, cached });
  }

  const targets = scanTargets(opts.scanRoot);
  const findings: Finding[] = [];
  let scanned = 0;
  for (const rel of targets) {
    if (SKIPPED_FILES.test(rel)) continue;
    const text = readText(join(opts.scanRoot, rel));
    if (text === undefined) continue;
    scanned++;
    let open: Finding | undefined;
    for (const w of fingerprintText(text)) {
      const source = fingerprints.get(w.fp);
      if (source === undefined) continue;
      if (open !== undefined && w.line <= open.endLine) {
        open.endLine = Math.max(open.endLine, w.endLine);
      } else {
        open = { file: rel, startLine: w.line, endLine: w.endLine, source };
        findings.push(open);
      }
    }
  }
  return { protectedRepos, unavailable, scanned, findings };
}

function scanTargets(root: string): string[] {
  try {
    return listWorkingFiles(root);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    return globSync(["**"], { cwd: root, dot: true, onlyFiles: true, followSymbolicLinks: false, ignore: ALWAYS_EXCLUDED })
      .map((p) => posix.normalize(p))
      .sort();
  }
}
