import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toolRoot } from "../core/paths.js";
import type { CallSite } from "../core/types.js";
import { loadSites } from "../extract/run.js";
import { listLabels } from "../labelling/labels.js";
import type { Split } from "../labelling/store.js";
import { loadLinks } from "../match/run.js";
import type { Db } from "../store/db.js";
import { alignUnits, type Metrics, metricsOf, type SampleFrame, siteResultsCsv, type Unit } from "./evaluate.js";

export interface Evaluation {
  /** The run, with `@path` when only paths and names were compared. */
  run: string;
  /** How a prediction met a label: by the full target key, or by path and name only. */
  compare: "key" | "path";
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
export function evaluateRun(opts: { method: Db; candidates: Db; labels: Db; run: string; split: Split; annotator: string; compare?: "key" | "path" }): Evaluation {
  const frame = sampleFrame(opts.candidates);
  const links = new Map(loadLinks(opts.method, opts.run).map((l) => [l.site, l]));
  // the baseline answers for places of its own (`cbm:<repo>:<path>:<line>`), not for the method's sites
  // only sites the run answers for: another tool's places, or sites outside the run, must not take a unit
  const sites = [...loadSites(opts.method), ...placesOf([...links.keys()])].filter((s) => links.has(s.id));
  if (links.size === 0) throw new Error(`run '${opts.run}' has no links; run \`archmap match\` first`);
  const { units, pending } = alignUnits(frame, opts.split, listLabels(opts.labels, opts.annotator), sites, links, opts.compare);
  const siteParts = new Map(sites.map((s) => [s.id, s.components]));
  const partsOf = (u: Unit) => {
    const own = frame.candidates.get(u.unit)?.component;
    if (own) return [own];
    const parts = u.site ? siteParts.get(u.site) : undefined;
    return parts && parts.length > 0 ? parts : ["?"];
  };
  const run = opts.compare === "path" ? `${opts.run}@path` : opts.run;
  return { run, compare: opts.compare ?? "key", split: opts.split, annotator: opts.annotator, units, pending, metrics: metricsOf(units, partsOf, opts.compare) };
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
    `${JSON.stringify({ at: new Date().toISOString(), target, run: e.run, compare: e.compare, split: e.split, annotator: e.annotator, units: e.units.length, pending: e.pending, recall17: w.recall17, precision: w.precision, theta: w.theta, ...meta })}\n`,
  );
  return dir;
}

/** Places named `<tool>:<repo>:<path>:<line>` as one-line sites. */
function placesOf(ids: string[]): CallSite[] {
  return ids.flatMap((id) => {
    const m = /^cbm:([^:]+):(.+):(\d+)$/.exec(id);
    if (!m) return [];
    const line = Number(m[3]);
    return [{ id, repo: m[1] as string, path: m[2] as string, line, endLine: line, col: 1, type: "http" as const, role: "request" as const, detector: "cbm", method: null, address: { parts: [], hops: [] }, components: [], liftedFrom: null }];
  });
}
