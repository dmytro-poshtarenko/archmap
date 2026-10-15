import { canonicalTargetKey } from "../core/keys.js";
import type { CallSite } from "../core/types.js";
import type { Label } from "../labelling/labels.js";
import type { StoredLink } from "../match/run.js";

/** A sampled candidate line with its reference label and the method's answer for it. */
export interface Unit {
  /** The sampled candidate, `<repo>:<path>:<line>`. */
  unit: string;
  repo: string;
  path: string;
  line: number;
  /** Cluster for the bootstrap: calls of one file depend on each other. */
  file: string;
  /** Interaction type the sample was stratified by. */
  stratum: string;
  /** Inverse inclusion probability of the stratum within the split: population / sample. */
  weight: number;
  label: Pick<Label, "isSite" | "reason" | "type" | "target" | "caseNo">;
  /** The call site of the method aligned to the unit, if any. */
  site: string | null;
  status: string | null;
  target: string | null;
  alternatives: string[];
  predictedCase: number | null;
  /** The reference gives a target in the system: the unit belongs to C*. */
  inCStar: boolean;
  /** The method gives a link: f(c) ≠ ∅. */
  predicted: boolean;
  /** f(c) = g(c), with route parameters compared by position. */
  correct: boolean;
}

export interface SampleFrame {
  /** Candidate id → stratum, split and calling component, for every candidate line. */
  candidates: Map<string, { stratum: string; split: string; component: string | null }>;
  /** Sampled candidate ids. */
  sampled: string[];
}

/**
 * Aligns the reference labels of the sample with the method's sites by line
 * range: a site belongs to a labelled unit when its lines overlap the
 * labelled call, the one starting nearest the labelled line first. A site
 * counts once; lines labelled `duplicate` stand for a call labelled above
 * and are no units of their own.
 */
export function alignUnits(frame: SampleFrame, split: string, labels: Label[], sites: CallSite[], links: Map<string, StoredLink>): { units: Unit[]; pending: number } {
  const weights = weightsOf(frame, split);
  const byFile = new Map<string, CallSite[]>();
  for (const s of sites) byFile.set(`${s.repo}:${s.path}`, [...(byFile.get(`${s.repo}:${s.path}`) ?? []), s]);
  const label = new Map(labels.filter((l) => l.origin === "sample").map((l) => [l.item, l]));
  const sampled = frame.sampled.filter((id) => frame.candidates.get(id)?.split === split);
  const used = new Set<string>();
  const pick = (l: Label): CallSite | null => {
    const last = l.endLine ?? l.line;
    const overlapping = (byFile.get(`${l.repo}:${l.path}`) ?? []).filter((s) => !used.has(s.id) && s.line <= last && s.endLine >= l.line);
    overlapping.sort((a, b) => Math.abs(a.line - l.line) - Math.abs(b.line - l.line) || a.col - b.col);
    return overlapping[0] ?? null;
  };
  // sites first, so a site is never taken by a neighbouring line that is no site
  const order = [...sampled].sort((a, b) => Number(label.get(b)?.isSite ?? false) - Number(label.get(a)?.isSite ?? false));
  const units: Unit[] = [];
  let pending = 0;
  for (const id of order) {
    const l = label.get(id);
    if (!l) {
      pending++;
      continue;
    }
    if (!l.isSite && l.reason === "duplicate") continue;
    const site = pick(l);
    if (site) used.add(site.id);
    const link = site ? links.get(site.id) : undefined;
    const stratum = frame.candidates.get(id)?.stratum ?? "unknown";
    const inCStar = l.isSite && l.target !== null && l.target !== "NONE";
    const predicted = link?.status === "linked";
    const answers = predicted && link ? (link.alternatives.length > 0 ? link.alternatives : [link.target as string]) : [];
    const correct = inCStar && answers.some((a) => canonicalTargetKey(a) === canonicalTargetKey(l.target as string));
    units.push({
      unit: id,
      repo: l.repo,
      path: l.path,
      line: l.line,
      file: `${l.repo}:${l.path}`,
      stratum,
      weight: weights.get(stratum) ?? 1,
      label: { isSite: l.isSite, reason: l.reason, type: l.type, target: l.target, caseNo: l.caseNo },
      site: site?.id ?? null,
      status: link?.status ?? null,
      target: link?.target ?? null,
      alternatives: link?.alternatives ?? [],
      predictedCase: link?.caseNo ?? null,
      inCStar,
      predicted,
      correct,
    });
  }
  units.sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
  return { units, pending };
}

/** Population / sample per stratum within the split. */
function weightsOf(frame: SampleFrame, split: string): Map<string, number> {
  const population = new Map<string, number>();
  for (const c of frame.candidates.values()) if (c.split === split) population.set(c.stratum, (population.get(c.stratum) ?? 0) + 1);
  const sample = new Map<string, number>();
  for (const id of frame.sampled) {
    const c = frame.candidates.get(id);
    if (c?.split === split) sample.set(c.stratum, (sample.get(c.stratum) ?? 0) + 1);
  }
  return new Map([...sample].map(([s, n]) => [s, (population.get(s) ?? n) / n]));
}

export interface Rates {
  /** |C*|, |C*₁₋₇|, |C*₈| and the units the method linked. */
  cstar: number;
  cstar17: number;
  cstar8: number;
  predicted: number;
  correct: number;
  correct17: number;
  /** Recall (5.1), recall among recoverable links, precision (5.2) and the case-8 share θ (5.3). */
  recall: number | null;
  recall17: number | null;
  precision: number | null;
  theta: number | null;
}

export interface Metrics {
  units: number;
  unweighted: Rates;
  /** Estimates for the whole system: every unit weighted by the inverse of its stratum's sampling share. */
  weighted: Rates;
  /** Recall per reference case, unweighted. */
  byCase: Record<string, { n: number; correct: number; recall: number | null }>;
  /** Recall and precision per reference interaction type, unweighted. */
  byType: Record<string, { n: number; correct: number; predicted: number; recall: number | null; precision: number | null }>;
  /** Links between parts: distinct (calling part, target part, kind) found among the units. */
  parts: { reference: number; found: number; correct: number; recall: number | null; precision: number | null };
}

/**
 * Recall R = |{c ∈ C* : f(c) = g(c)}| / |C*| (5.1), precision
 * P = |{c ∈ C* : f(c) = g(c)}| / |{c : f(c) ≠ ∅}| (5.2) and θ = |C*₈| / |C*|
 * (5.3), with R₁₋₇ over C* without case 8. Units are the sampled lines; a
 * link the method gives on a line that is no call site counts against
 * precision.
 */
export function metricsOf(units: Unit[], partsOf?: (u: Unit) => string[]): Metrics {
  const rates = (w: (u: Unit) => number): Rates => {
    let cstar = 0;
    let cstar17 = 0;
    let cstar8 = 0;
    let predicted = 0;
    let correct = 0;
    let correct17 = 0;
    for (const u of units) {
      const x = w(u);
      if (u.inCStar) {
        cstar += x;
        if (u.label.caseNo === 8) cstar8 += x;
        else cstar17 += x;
      }
      if (u.predicted) predicted += x;
      if (u.correct) {
        correct += x;
        if (u.label.caseNo !== 8) correct17 += x;
      }
    }
    return {
      cstar,
      cstar17,
      cstar8,
      predicted,
      correct,
      correct17,
      recall: ratio(correct, cstar),
      recall17: ratio(correct17, cstar17),
      precision: ratio(correct, predicted),
      theta: ratio(cstar8, cstar),
    };
  };
  const byCase: Metrics["byCase"] = {};
  for (const u of units.filter((x) => x.inCStar)) {
    const k = String(u.label.caseNo);
    const e = byCase[k] ?? { n: 0, correct: 0, recall: null };
    e.n++;
    if (u.correct) e.correct++;
    e.recall = ratio(e.correct, e.n);
    byCase[k] = e;
  }
  const byType: Metrics["byType"] = {};
  for (const u of units) {
    const t = u.label.type ?? u.stratum;
    const e = byType[t] ?? { n: 0, correct: 0, predicted: 0, recall: null, precision: null };
    if (u.inCStar) e.n++;
    if (u.correct) e.correct++;
    if (u.predicted) e.predicted++;
    e.recall = ratio(e.correct, e.n);
    e.precision = ratio(e.correct, e.predicted);
    byType[t] = e;
  }
  return { units: units.length, unweighted: rates(() => 1), weighted: rates((u) => u.weight), byCase: sorted(byCase), byType: sorted(byType), parts: partLinks(units, partsOf) };
}

/**
 * Links between parts of the system: each unit with a target gives edges
 * from the parts running its code to the target's part. Recall and
 * precision compare the distinct edges of the reference and of the method.
 */
function partLinks(units: Unit[], partsOf?: (u: Unit) => string[]): Metrics["parts"] {
  const edges = (u: Unit, key: string | null) => {
    if (key === null || key === "NONE") return [];
    const [kind] = key.split(":");
    const target = key.slice(key.lastIndexOf("@") + 1);
    return (partsOf?.(u) ?? ["?"]).map((from) => `${from}->${target}:${kind}`);
  };
  const reference = new Set(units.filter((u) => u.inCStar).flatMap((u) => edges(u, u.label.target)));
  const found = new Set(units.filter((u) => u.predicted).flatMap((u) => edges(u, u.target)));
  const correct = [...found].filter((e) => reference.has(e)).length;
  return { reference: reference.size, found: found.size, correct, recall: ratio(correct, reference.size), precision: ratio(correct, found.size) };
}

function ratio(a: number, b: number): number | null {
  return b === 0 ? null : a / b;
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })));
}

const COLUMNS = [
  "unit",
  "file",
  "repo",
  "path",
  "line",
  "stratum",
  "weight",
  "label_is_site",
  "label_reason",
  "label_type",
  "label_target",
  "label_case",
  "site",
  "status",
  "target",
  "alternatives",
  "predicted_case",
  "in_cstar",
  "predicted",
  "correct",
] as const;

/** One row per unit, the input of the statistical analysis (`analysis/`). */
export function siteResultsCsv(units: Unit[]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const rows = units.map((u) =>
    [
      u.unit,
      u.file,
      u.repo,
      u.path,
      u.line,
      u.stratum,
      u.weight,
      u.label.isSite ? 1 : 0,
      u.label.reason,
      u.label.type,
      u.label.target,
      u.label.caseNo,
      u.site,
      u.status,
      u.target,
      u.alternatives.join(" "),
      u.predictedCase,
      u.inCStar ? 1 : 0,
      u.predicted ? 1 : 0,
      u.correct ? 1 : 0,
    ]
      .map(cell)
      .join(","),
  );
  return `${[COLUMNS.join(","), ...rows].join("\n")}\n`;
}
