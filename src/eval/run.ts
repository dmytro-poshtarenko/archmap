import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toolRoot } from "../core/paths.js";
import { loadSites } from "../extract/run.js";
import { listLabels } from "../labelling/labels.js";
import type { Split } from "../labelling/store.js";
import { loadLinks } from "../match/run.js";
import type { Db } from "../store/db.js";
import { alignUnits, type Metrics, metricsOf, type SampleFrame, siteResultsCsv, type Unit } from "./evaluate.js";

export interface Evaluation {
  run: string;
  split: Split;
  annotator: string;
  units: Unit[];
  /** Sampled lines of the split the annotator has not labelled yet. */
  pending: number;
  metrics: Metrics;
}

/** The sampling frame: every candidate line and the sampled ones. */
export function sampleFrame(candidates: Db): SampleFrame {
  const rows = candidates.prepare("SELECT id, stratum, split, component FROM candidate").all() as Array<{ id: string; stratum: string; split: string; component: string | null }>;
  const sampled = (candidates.prepare("SELECT candidate FROM sample ORDER BY pool, rank").all() as Array<{ candidate: string }>).map((r) => r.candidate);
  return { candidates: new Map(rows.map((r) => [r.id, { stratum: r.stratum, split: r.split, component: r.component }])), sampled };
}

/**
 * Compares one run of the method with the reference labels of a split. The
 * labels database must have been opened through the guard (`openLabels`),
 * which refuses the test split before the freeze.
 */
export function evaluateRun(opts: { method: Db; candidates: Db; labels: Db; run: string; split: Split; annotator: string }): Evaluation {
  const frame = sampleFrame(opts.candidates);
  const sites = loadSites(opts.method);
  const links = new Map(loadLinks(opts.method, opts.run).map((l) => [l.site, l]));
  if (links.size === 0) throw new Error(`run '${opts.run}' has no links; run \`archmap match\` first`);
  const { units, pending } = alignUnits(frame, opts.split, listLabels(opts.labels, opts.annotator), sites, links);
  const siteParts = new Map(sites.map((s) => [s.id, s.components]));
  const partsOf = (u: Unit) => {
    const own = frame.candidates.get(u.unit)?.component;
    if (own) return [own];
    const parts = u.site ? siteParts.get(u.site) : undefined;
    return parts && parts.length > 0 ? parts : ["?"];
  };
  return { run: opts.run, split: opts.split, annotator: opts.annotator, units, pending, metrics: metricsOf(units, partsOf) };
}

/**
 * Writes `site_results.csv` and `metrics.json` under
 * `data/out/<target>/<run>/eval/<split>/` and appends the evaluation to the
 * audit log of the tool repository.
 */
export function writeEvaluation(
  dataRoot: string,
  target: string,
  e: Evaluation,
  meta: { configHash: string; toolSha: string | null },
  auditFile = join(toolRoot, "audit", "evaluations.jsonl"),
): string {
  const dir = join(dataRoot, "out", target, e.run, "eval", e.split);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "site_results.csv"), siteResultsCsv(e.units));
  writeFileSync(join(dir, "metrics.json"), `${JSON.stringify({ run: e.run, split: e.split, annotator: e.annotator, pending: e.pending, ...e.metrics }, null, 2)}\n`);
  mkdirSync(dirname(auditFile), { recursive: true });
  const w = e.metrics.weighted;
  appendFileSync(
    auditFile,
    `${JSON.stringify({ at: new Date().toISOString(), target, run: e.run, split: e.split, annotator: e.annotator, units: e.units.length, pending: e.pending, recall17: w.recall17, precision: w.precision, theta: w.theta, ...meta })}\n`,
  );
  return dir;
}
