import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runClassify } from "../classify/run.js";
import type { LoadedConfig } from "../config/load.js";
import { hashOf } from "../core/hash.js";
import { type DataLayout, toolRoot } from "../core/paths.js";
import type { CallSite } from "../core/types.js";
import { evaluateRun, writeEvaluation } from "../eval/run.js";
import { programOf, runExtraction } from "../extract/run.js";
import { extractInfra, writeInfra } from "../infra/index.js";
import { openCandidates, openLabels, type Split } from "../labelling/store.js";
import { LlmClient } from "../llm/client.js";
import { type ModelChoice, providerOf } from "../llm/providers/index.js";
import { reader, runLlmRoutes, runResolve } from "../llm/run.js";
import { runMatch, type Variant } from "../match/run.js";
import { type Db, getMeta } from "../store/db.js";
import { git } from "../workspace/git.js";
import { locateRepo } from "../workspace/repos.js";

export interface RunAllOptions {
  model: ModelChoice;
  /** `sample`: the model is asked only about the labelled sample's lines; `everything`: about every open site. */
  sites: "sample" | "everything";
  split: Split;
  /** Run the Python analysis when the split has labelled units. */
  analysis: boolean;
  /** Spending limit for the cloud model. */
  budgetUsd?: number;
  frozen: boolean;
  log: (m: string) => void;
  /** Where evaluations are logged (default: the tool's `audit/evaluations.jsonl`). */
  auditFile?: string;
}

export interface StepRecord {
  step: string;
  seconds: number;
  costUsd: number;
  note: string;
}

/** The runs of the measurement: hypothesis 1 (the full method and one without each component) and hypothesis 2 (both modes on every site). */
export function plannedRuns(tag: string): { full: string; without: Record<string, string>; modes: Record<string, string>; all: string[] } {
  const full = `full.select.${tag}`;
  const without = { rules: `no-rules.free.${tag}`, infra: `no-infra.select.${tag}`, llm: "no-llm" };
  const modes = { "no-llm": "no-llm", select: `full.select-all.${tag}`, free: `full.free-all.${tag}` };
  return { full, without, modes, all: [...new Set([full, ...Object.values(without), ...Object.values(modes)])] };
}

/**
 * One command that reproduces a measurement: extraction, infrastructure,
 * the model's route extraction, cases, the four variants, the model's
 * resolution for hypotheses 1 and 2, evaluation on the split and, when there
 * are labels, the statistical analysis. Answers come from the cache; with a
 * replay model nothing new is asked at all. Time and cost of every step are
 * written to `out/<target>/run-all-<split>.json`.
 */
export async function runAll(db: Db, loaded: LoadedConfig, layout: DataLayout, opts: RunAllOptions): Promise<StepRecord[]> {
  const { config } = loaded;
  const steps: StepRecord[] = [];
  const step = async (name: string, fn: () => Promise<{ cost?: number; note: string }> | { cost?: number; note: string }) => {
    const t0 = performance.now();
    const r = await fn();
    const rec = { step: name, seconds: Math.round((performance.now() - t0) / 100) / 10, costUsd: Math.round((r.cost ?? 0) * 10000) / 10000, note: r.note };
    steps.push(rec);
    opts.log(`${name}: ${r.note} (${rec.seconds}s${rec.costUsd ? `, $${rec.costUsd}` : ""})`);
  };
  const read = reader(config, layout, loaded.path);
  const client = () => new LlmClient(db, providerOf(config, opts.model, db), { budgetUsd: opts.budgetUsd ?? config.llm.budgetUsd, concurrency: opts.model === "cloud" ? 4 : 1, log: opts.log });

  await step("extract", () => {
    const s = runExtraction(db, config, programOf(db, config, layout, loaded.path));
    return { note: `${s.sites} sites, ${s.routes} routes${s.skipped ? " (unchanged)" : ""}` };
  });
  await step("extract-infra", async () => {
    const files = db.prepare("SELECT repo_id AS repo, path FROM file").all() as Array<{ repo: string; path: string }>;
    const dirOf = (repo: string) => locateRepo(config.repos.find((r) => r.id === repo) as never, layout, loaded.path).dir;
    const facts = await extractInfra({ config, files, dirOf });
    writeInfra(db, facts, hashOf({ inventory: getMeta(db, "inventory.hash"), infra: config.infra, components: config.components }));
    return { note: `${facts.containers.length} containers, ${facts.rules.length} gateway rules` };
  });
  await step("llm-routes", async () => {
    const c = client();
    const s = await runLlmRoutes(db, config, read, c);
    return { cost: s.costUsd, note: `${s.routes} routes from ${s.files} files, ${s.cacheHits}/${s.requests} from the cache` };
  });
  await step("classify", () => {
    const s = runClassify(db, config);
    return { note: Object.entries(s.byCase).map(([k, v]) => `${k}:${v}`).join(" ") };
  });
  const variants: Record<string, Variant> = {
    full: { rules: true, infra: true, llm: true },
    "no-llm": { rules: true, infra: true, llm: false },
    "no-infra": { rules: true, infra: false, llm: true },
    "no-rules": { rules: false, infra: true, llm: true },
  };
  for (const [name, v] of Object.entries(variants)) {
    await step(`match ${name}`, () => {
      const s = runMatch(db, config, v, { configHash: loaded.hash });
      return { note: Object.entries(s.byStatus).map(([k, n]) => `${k} ${n}`).join(", ") };
    });
  }

  const inSample = opts.sites === "sample" ? sampledLines(layout, config.name, opts.split) : undefined;
  const plan = [
    { base: "full", mode: "select" as const, scope: "open" as const },
    { base: "no-infra", mode: "select" as const, scope: "open" as const },
    { base: "no-rules", mode: "free" as const, scope: "open" as const },
    { base: "full", mode: "select" as const, scope: "all" as const },
    { base: "full", mode: "free" as const, scope: "all" as const },
  ];
  let tag = "local";
  for (const p of plan) {
    await step(`resolve ${p.base} ${p.mode}${p.scope === "all" ? "-all" : ""}`, async () => {
      const c = client();
      tag = c.tag;
      const s = await runResolve(db, config, read, c, { ...p, configHash: loaded.hash, sites: inSample });
      return { cost: s.costUsd, note: `${s.run}: ${s.asked} asked, ${s.linked} linked, ${s.invented} invented, ${s.cacheHits}/${s.requests} from the cache` };
    });
  }

  const runs = plannedRuns(tag);
  let units = 0;
  await step(`evaluate ${opts.split}`, () => {
    const labels = openLabels(layout, config.name, opts.split, "evaluate", opts.frozen);
    const candidates = openCandidates(layout, config.name);
    try {
      let sha: string | null = null;
      try {
        sha = git(["rev-parse", "HEAD"], toolRoot).trim();
      } catch {
        sha = null;
      }
      for (const run of runs.all) {
        const e = evaluateRun({ method: db, candidates, labels, run, split: opts.split, annotator: "A" });
        writeEvaluation(layout.root, config.name, e, { configHash: loaded.hash, toolSha: sha }, opts.auditFile);
        units = e.units.length;
      }
      return { note: `${runs.all.length} runs, ${units} labelled units` };
    } finally {
      labels.close();
      candidates.close();
    }
  });

  if (opts.analysis && units > 0) {
    await step("analysis", () => {
      const args = ["run", "python", "-m", "archmap_analysis.report", "--data", layout.root, "--target", config.name, "--split", opts.split, "--runs", ...runs.all, "--full", runs.full];
      args.push("--without", ...Object.entries(runs.without).map(([k, v]) => `${k}=${v}`), "--modes", ...Object.entries(runs.modes).map(([k, v]) => `${k}=${v}`));
      const r = spawnSync("uv", args, { cwd: join(toolRoot, "analysis"), encoding: "utf8" });
      if (r.status !== 0) throw new Error(`analysis failed: ${r.stderr}`);
      return { note: r.stdout.trim().split("\n").join("; ") };
    });
  } else if (opts.analysis) {
    steps.push({ step: "analysis", seconds: 0, costUsd: 0, note: "skipped: no labelled units yet" });
    opts.log("analysis: skipped, no labelled units yet");
  }

  const out = join(layout.root, "out", config.name);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `run-all-${opts.split}.json`), `${JSON.stringify({ at: new Date().toISOString(), model: opts.model, sites: opts.sites, runs, steps, totalSeconds: steps.reduce((s, x) => s + x.seconds, 0), totalUsd: steps.reduce((s, x) => s + x.costUsd, 0) }, null, 2)}\n`);
  return steps;
}

/** Sites on the lines of the labelled sample in one split: the test split's lines are asked about only when the test split is measured. */
function sampledLines(layout: DataLayout, target: string, split: Split): (site: CallSite) => boolean {
  const candidates = openCandidates(layout, target);
  try {
    const rows = candidates
      .prepare("SELECT c.repo, c.path, c.line FROM sample s JOIN candidate c ON c.id = s.candidate WHERE c.split = ?")
      .all(split) as Array<{ repo: string; path: string; line: number }>;
    const byFile = new Map<string, number[]>();
    for (const r of rows) byFile.set(`${r.repo}:${r.path}`, [...(byFile.get(`${r.repo}:${r.path}`) ?? []), r.line]);
    return (s) => (byFile.get(`${s.repo}:${s.path}`) ?? []).some((line) => line >= s.line && line <= s.endLine);
  } finally {
    candidates.close();
  }
}
