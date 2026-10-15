import { hashOf } from "../core/hash.js";
import { mulberry32, seedFrom, shuffle } from "../core/prng.js";
import { type Db, getMeta, setMeta } from "../store/db.js";
import type { Candidate } from "./candidates.js";
import type { Snapshot } from "./snapshot.js";

export type Pool = "main" | "heldout";

export interface SampleOptions {
  seed: number;
  /** Total sample size of the pool. */
  size: number;
  /** Every stratum gets at least this many items, or all of its items if it has fewer. */
  minPerStratum: number;
  /** Share of each stratum labelled by the second annotator too. */
  doubleShare: number;
}

export interface SampledItem {
  candidate: string;
  stratum: string;
  rank: number;
  double: boolean;
}

export interface Sample {
  pool: Pool;
  allocation: Record<string, { population: number; sample: number }>;
  items: SampledItem[];
}

/**
 * Stratified allocation: proportional to the stratum sizes, with every
 * stratum raised to `min` (or to its size if smaller) and the others scaled
 * down to keep the total; largest remainders settle the rounding.
 */
export function allocate(populations: Record<string, number>, total: number, min: number): Record<string, number> {
  const strata = Object.keys(populations).sort();
  const N = strata.reduce((s, h) => s + (populations[h] ?? 0), 0);
  if (total >= N) return Object.fromEntries(strata.map((h) => [h, populations[h] ?? 0]));
  const fixed = new Map<string, number>();
  for (;;) {
    const free = strata.filter((h) => !fixed.has(h));
    const budget = total - [...fixed.values()].reduce((s, v) => s + v, 0);
    const freeN = free.reduce((s, h) => s + (populations[h] ?? 0), 0);
    const share = (h: string) => (freeN === 0 ? 0 : (budget * (populations[h] ?? 0)) / freeN);
    const raise = free.filter((h) => share(h) < Math.min(min, populations[h] ?? 0));
    const cap = free.filter((h) => share(h) > (populations[h] ?? 0));
    if (raise.length === 0 && cap.length === 0) {
      return { ...Object.fromEntries(fixed), ...roundShares(free, share, budget) };
    }
    for (const h of raise) fixed.set(h, Math.min(min, populations[h] ?? 0));
    for (const h of cap) fixed.set(h, populations[h] ?? 0);
  }
}

function roundShares(strata: string[], share: (h: string) => number, budget: number): Record<string, number> {
  const floors = strata.map((h) => ({ h, n: Math.floor(share(h)), rest: share(h) - Math.floor(share(h)) }));
  let left = budget - floors.reduce((s, f) => s + f.n, 0);
  for (const f of [...floors].sort((a, b) => b.rest - a.rest || (a.h < b.h ? -1 : 1))) {
    if (left <= 0) break;
    f.n++;
    left--;
  }
  return Object.fromEntries(floors.map((f) => [f.h, f.n]));
}

/**
 * Draws the stratified sample of a pool. Within a stratum the candidates are
 * shuffled with a seed derived from the sample seed and the stratum, so the
 * same seed and population always give the same items; the labelling order
 * and the second annotator's share are drawn with seeds of their own.
 */
export function drawSample(pool: Pool, candidates: Candidate[], opts: SampleOptions): Sample {
  const byStratum = new Map<string, string[]>();
  for (const c of candidates) {
    const list = byStratum.get(c.stratum) ?? [];
    list.push(c.id);
    byStratum.set(c.stratum, list);
  }
  const populations = Object.fromEntries([...byStratum.entries()].map(([h, ids]) => [h, ids.length]));
  const sizes = allocate(populations, opts.size, opts.minPerStratum);

  const splitOf = new Map(candidates.map((c) => [c.id, c.split]));
  const stratumOf = new Map<string, string>();
  const doubles = new Set<string>();
  for (const h of [...byStratum.keys()].sort()) {
    const ids = [...(byStratum.get(h) ?? [])].sort();
    const picked = shuffle(ids, mulberry32(seedFrom(opts.seed, pool, "stratum", h))).slice(0, sizes[h] ?? 0);
    for (const id of picked) stratumOf.set(id, h);
    const second = Math.ceil(picked.length * opts.doubleShare);
    for (const id of shuffle([...picked].sort(), mulberry32(seedFrom(opts.seed, pool, "double", h))).slice(0, second)) {
      doubles.add(id);
    }
  }
  // Labelling order, split by split (annotators work through one split at a
  // time): the strata take turns, each in its own random order, so any prefix
  // (the pilot, or an unfinished labelling) covers every stratum and is a
  // random subset within each.
  const ordered: Array<{ candidate: string; stratum: string }> = [];
  for (const split of ["dev", "test", "heldout"]) {
    const queues = [...byStratum.keys()].sort().map((h) =>
      shuffle(
        [...stratumOf.keys()].filter((id) => stratumOf.get(id) === h && splitOf.get(id) === split).sort(),
        mulberry32(seedFrom(opts.seed, pool, "order", split, h)),
      ),
    );
    const total = queues.reduce((s, q) => s + q.length, 0);
    for (let i = 0, n = 0; n < total; i++) {
      for (const q of queues) {
        const id = q[i];
        if (id !== undefined) {
          ordered.push({ candidate: id, stratum: stratumOf.get(id) ?? "" });
          n++;
        }
      }
    }
  }
  return {
    pool,
    allocation: Object.fromEntries(Object.keys(populations).sort().map((h) => [h, { population: populations[h] ?? 0, sample: sizes[h] ?? 0 }])),
    items: ordered.map((c, i) => ({ ...c, rank: i + 1, double: doubles.has(c.candidate) })),
  };
}

/**
 * Files read in full for the gap check: a seeded random choice among the
 * files that use an HTTP or queue client.
 */
export function drawGapFiles(
  snapshot: Snapshot,
  gapImports: RegExp[],
  count: number,
  seed: number,
  splits: string[],
): Array<{ repo: string; path: string; split: string; rank: number }> {
  const eligible = snapshot.files
    .filter((f) => splits.includes(f.split) && f.lang !== null && ["ts", "tsx", "js", "jsx"].includes(f.lang))
    .filter((f) => {
      const text = snapshot.read(f.repo, f.path);
      return gapImports.some((re) => re.test(text));
    })
    .map((f) => ({ repo: f.repo, path: f.path, split: f.split }));
  return shuffle(eligible, mulberry32(seedFrom(seed, "gap")))
    .slice(0, count)
    .map((f, i) => ({ ...f, rank: i + 1 }));
}

export function sampleHash(sample: Sample): string {
  return hashOf(sample.items);
}

/** Stored sample of a pool, in labelling order. */
export function loadSample(db: Db, pool: Pool): SampledItem[] {
  return (
    db
      .prepare(
        `SELECT s.candidate, c.stratum, s.rank, s.double FROM sample s JOIN candidate c ON c.id = s.candidate
         WHERE s.pool = ? ORDER BY s.rank`,
      )
      .all(pool) as Array<Omit<SampledItem, "double"> & { double: number }>
  ).map((r) => ({ ...r, double: r.double === 1 }));
}

/**
 * Stores a sample. Drawing again with the same inputs is a no-op; a different
 * sample replaces the stored one only with `force`, since labels refer to it.
 */
export function storeSample(db: Db, sample: Sample, opts: { force: boolean; params: unknown }): "stored" | "unchanged" {
  const hash = sampleHash(sample);
  const previous = getMeta(db, `sample.${sample.pool}.hash`);
  if (previous === hash) return "unchanged";
  if (previous !== undefined && !opts.force) {
    throw new Error(`a different ${sample.pool} sample is already stored; use --force to replace it`);
  }
  const insert = db.prepare("INSERT INTO sample(candidate, pool, rank, double) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    db.prepare("DELETE FROM sample WHERE pool = ?").run(sample.pool);
    for (const item of sample.items) insert.run(item.candidate, sample.pool, item.rank, item.double ? 1 : 0);
    setMeta(db, `sample.${sample.pool}.hash`, hash);
    setMeta(db, `sample.${sample.pool}.allocation`, JSON.stringify(sample.allocation));
    setMeta(db, `sample.${sample.pool}.params`, JSON.stringify(opts.params));
  })();
  return "stored";
}

export function storeGapFiles(db: Db, files: Array<{ repo: string; path: string; split: string; rank: number }>): void {
  const insert = db.prepare("INSERT INTO gap_file(repo, path, split, rank) VALUES (@repo, @path, @split, @rank)");
  db.transaction(() => {
    db.exec("DELETE FROM gap_file");
    for (const f of files) insert.run(f);
  })();
}
