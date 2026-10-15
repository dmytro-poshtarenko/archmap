import type { InteractionType } from "../config/schema.js";
import { sha256Hex } from "../core/hash.js";
import { type Db, getMeta, setMeta } from "../store/db.js";
import type { CompiledPacks } from "./patterns.js";
import type { Snapshot, SourceFile } from "./snapshot.js";
import type { Split } from "./store.js";

export interface Candidate {
  id: string;
  repo: string;
  path: string;
  line: number;
  split: Split;
  component: string | null;
  stratum: InteractionType;
  patterns: string[];
  textSha: string;
}

export function candidateId(repo: string, path: string, line: number): string {
  return `${repo}:${path}:${line}`;
}

/**
 * Runs every pattern over the whole text of each file and reports one
 * candidate per matching line. A line matched by several patterns keeps all
 * their ids; its stratum is the type of the first pattern in pack order.
 * Files, lines and patterns are visited in a fixed order, so the result is
 * the same on every run.
 */
export function findCandidates(snapshot: Snapshot, packs: CompiledPacks): Candidate[] {
  const out: Candidate[] = [];
  for (const file of snapshot.files) {
    const patterns = packs.patterns.filter((p) => file.lang !== null && p.langs.has(file.lang));
    if (patterns.length === 0) continue;
    out.push(...candidatesInText(file, snapshot.read(file.repo, file.path), patterns));
  }
  return out;
}

export function candidatesInText(
  file: SourceFile,
  text: string,
  patterns: CompiledPacks["patterns"],
): Candidate[] {
  const starts = lineStarts(text);
  const byLine = new Map<number, { stratum: InteractionType; patterns: string[] }>();
  for (const p of patterns) {
    const global = new RegExp(p.regex.source, `${p.regex.flags.replace("g", "")}g`);
    for (const m of text.matchAll(global)) {
      const line = lineOf(starts, m.index);
      const entry = byLine.get(line);
      if (entry === undefined) byLine.set(line, { stratum: p.type, patterns: [p.id] });
      else if (!entry.patterns.includes(p.id)) entry.patterns.push(p.id);
    }
  }
  const lines = text.split("\n");
  return [...byLine.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, entry]) => ({
      id: candidateId(file.repo, file.path, line),
      repo: file.repo,
      path: file.path,
      line,
      split: file.split,
      component: file.component,
      stratum: entry.stratum,
      patterns: entry.patterns,
      textSha: sha256Hex((lines[line - 1] ?? "").trim()),
    }));
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** 1-based line holding `offset`. */
function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export interface StoredSearch {
  packsHash: string;
  inventoryHash: string;
  count: number;
}

/**
 * Replaces the stored candidate population. Refused once a sample exists,
 * unless the population is unchanged, because the sample is drawn from it.
 */
export function storeCandidates(db: Db, candidates: Candidate[], meta: Omit<StoredSearch, "count">): { changed: boolean } {
  const previous = getMeta(db, "candidates.hash");
  const hash = sha256Hex(candidates.map((c) => `${c.id}\t${c.stratum}\t${c.patterns.join(",")}\t${c.textSha}`).join("\n"));
  if (previous === hash) return { changed: false };
  const sampled = db.prepare("SELECT count(*) FROM sample").pluck().get() as number;
  if (sampled > 0) {
    throw new Error("a sample has already been drawn from the candidates; changing them needs 'label sample --force' afterwards");
  }
  const insert = db.prepare(
    `INSERT INTO candidate(id, repo, path, line, split, component, stratum, patterns, text_sha)
     VALUES (@id, @repo, @path, @line, @split, @component, @stratum, @patterns, @textSha)`,
  );
  db.transaction(() => {
    db.exec("DELETE FROM candidate");
    for (const c of candidates) insert.run({ ...c, patterns: JSON.stringify(c.patterns) });
    setMeta(db, "candidates.hash", hash);
    setMeta(db, "candidates.packsHash", meta.packsHash);
    setMeta(db, "candidates.inventoryHash", meta.inventoryHash);
    setMeta(db, "candidates.count", String(candidates.length));
  })();
  return { changed: true };
}

export function loadCandidates(db: Db): Candidate[] {
  return (
    db
      .prepare(
        `SELECT id, repo, path, line, split, component, stratum, patterns, text_sha AS textSha
         FROM candidate ORDER BY repo, path, line`,
      )
      .all() as Array<Omit<Candidate, "patterns"> & { patterns: string }>
  ).map((c) => ({ ...c, patterns: JSON.parse(c.patterns) as string[] }));
}
