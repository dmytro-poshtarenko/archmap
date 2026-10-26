import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FreezeManifest } from "../experiments/guards.js";
import { listLabels } from "../labelling/labels.js";
import type { Split } from "../labelling/store.js";
import type { Db } from "../store/db.js";
import { git } from "../workspace/git.js";

/**
 * The gap check: files the annotator read in full, so that every call site in
 * them is labelled, show how many sites the text search for candidates missed
 * (the frame of the reference) and how many the method's extraction missed.
 */
export interface GapSite {
  split: Split;
  repo: string;
  path: string;
  line: number;
  type: string | null;
  /** The label's target key, or `NONE`. */
  target: string;
  origin: string;
  inFrame: boolean;
  byMethod: boolean;
}

export interface GapCount {
  sites: number;
  inFrame: number;
  byMethod: number;
}

export interface GapReport {
  files: number;
  reviewed: number;
  all: GapCount;
  /** Sites with a target in the system: the ones a miss would cost recall. */
  targeted: GapCount & { missUpper: { frame: number; method: number } };
  byType: Record<string, GapCount>;
  sites: GapSite[];
}

/** Upper end of the 95 % Wilson interval of a proportion k/n. */
export function wilsonUpper(k: number, n: number, z = 1.959963984540054): number {
  if (n === 0) return 1;
  const p = k / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.min(1, (centre + spread) / (1 + (z * z) / n));
}

/** Counts each labelled site of the files read in full against the candidate lines and the method's call sites. */
export function gapReport(opts: { candidates: Db; labels: Partial<Record<Split, Db>>; method: Db; annotator: string }): GapReport {
  const files = opts.candidates.prepare("SELECT repo, path, split FROM gap_file ORDER BY rank").all() as Array<{ repo: string; path: string; split: Split }>;
  const frameLines = opts.candidates.prepare("SELECT line FROM candidate WHERE repo = ? AND path = ?").pluck();
  const spans = opts.method.prepare("SELECT line, end_line AS endLine FROM call_site WHERE repo = ? AND path = ?");
  let reviewed = 0;
  const sites: GapSite[] = [];
  for (const f of files) {
    const labels = opts.labels[f.split];
    if (!labels) throw new Error(`the ${f.split} labels are not open`);
    const done = labels.prepare("SELECT 1 FROM gap_review WHERE repo = ? AND path = ? AND annotator = ?").get(f.repo, f.path, opts.annotator);
    if (!done) continue;
    reviewed++;
    const lines = frameLines.all(f.repo, f.path) as number[];
    const found = spans.all(f.repo, f.path) as Array<{ line: number; endLine: number }>;
    for (const l of listLabels(labels, opts.annotator)) {
      if (l.repo !== f.repo || l.path !== f.path || !l.isSite) continue;
      const end = l.endLine ?? l.line;
      sites.push({
        split: f.split,
        repo: l.repo,
        path: l.path,
        line: l.line,
        type: l.type ?? null,
        target: l.target ?? "NONE",
        origin: l.origin,
        inFrame: lines.some((c) => c >= l.line && c <= end),
        byMethod: found.some((s) => !(s.endLine < l.line || s.line > end)),
      });
    }
  }
  const count = (xs: GapSite[]): GapCount => ({ sites: xs.length, inFrame: xs.filter((s) => s.inFrame).length, byMethod: xs.filter((s) => s.byMethod).length });
  const targeted = sites.filter((s) => s.target !== "NONE");
  const t = count(targeted);
  const byType: Record<string, GapCount> = {};
  for (const type of [...new Set(sites.map((s) => s.type ?? "?"))].sort()) byType[type] = count(sites.filter((s) => (s.type ?? "?") === type));
  return {
    files: files.length,
    reviewed,
    all: count(sites),
    targeted: { ...t, missUpper: { frame: wilsonUpper(t.sites - t.inFrame, t.sites), method: wilsonUpper(t.sites - t.byMethod, t.sites) } },
    byType,
    sites,
  };
}

/**
 * Whether the test labels may be read for the gap check: after the freeze,
 * while the code that finds candidates and call sites is still the frozen
 * one. Other code may have changed since; the gap check does not use it.
 */
export function extractionAsFrozen(root: string): { ok: true } | { ok: false; reason: string } {
  const file = join(root, "freeze", "manifest.json");
  if (!existsSync(file)) return { ok: false, reason: "the method is not frozen (no freeze/manifest.json)" };
  const manifest = FreezeManifest.parse(JSON.parse(readFileSync(file, "utf8")));
  const paths = ["src/extract", "src/workspace", "src/labelling/candidates.ts", "src/labelling/patterns.ts", "labelling/patterns", "rules", "configs"];
  const committed = git(["diff", "--name-only", manifest.commit, "HEAD", "--", ...paths], root).split("\n");
  const uncommitted = git(["status", "--porcelain", "--", ...paths], root).split("\n").map((l) => l.slice(3));
  const changed = [...committed, ...uncommitted].filter(Boolean);
  if (changed.length > 0) return { ok: false, reason: `the extraction changed since the freeze: ${changed.slice(0, 5).join(", ")}` };
  return { ok: true };
}
