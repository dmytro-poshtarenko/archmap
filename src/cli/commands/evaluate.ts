import type { Command } from "commander";
import { evaluateRun, writeEvaluation } from "../../eval/run.js";
import { openCandidates, openLabels, SPLITS, type Split } from "../../labelling/store.js";
import { git } from "../../workspace/git.js";
import { toolRoot } from "../../core/paths.js";
import { createContext, type GlobalOptions } from "../context.js";

export function registerEvaluate(program: Command): void {
  program
    .command("evaluate")
    .description("compare a run with the reference labels of a split: recall, precision, θ, per case and type")
    .requiredOption("--run <id>", "run to evaluate, e.g. no-llm")
    .option("--split <split>", "dev, test or heldout (test and heldout only after the freeze)", "dev")
    .option("--annotator <id>", "whose labels are the reference", "A")
    .action((opts: { run: string; split: string; annotator: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      if (!SPLITS.includes(opts.split as Split)) throw new Error(`unknown split ${opts.split}`);
      const split = opts.split as Split;
      const name = ctx.loaded.config.name;
      const labels = openLabels(ctx.layout, name, split, "evaluate", split === "dev" ? false : ctx.frozen());
      const candidates = openCandidates(ctx.layout, name);
      const method = ctx.openDb();
      try {
        const e = evaluateRun({ method, candidates, labels, run: opts.run, split, annotator: opts.annotator });
        let toolSha: string | null = null;
        try {
          toolSha = git(["rev-parse", "HEAD"], toolRoot).trim();
        } catch {
          toolSha = null;
        }
        const dir = writeEvaluation(ctx.layout.root, name, e, { configHash: ctx.loaded.hash, toolSha });
        const pct = (x: number | null) => (x === null ? "–" : `${(100 * x).toFixed(1)} %`);
        const u = e.metrics.unweighted;
        const w = e.metrics.weighted;
        console.log(`run ${e.run}, split ${e.split}, annotator ${e.annotator}: ${e.units.length} labelled units, ${e.pending} not labelled yet`);
        console.log(`C* ${u.cstar} (case 8: ${u.cstar8}), linked by the method ${u.predicted}, correct ${u.correct}`);
        console.log(`weighted: R₁₋₇ ${pct(w.recall17)}, R ${pct(w.recall)}, P ${pct(w.precision)}, θ ${pct(w.theta)}`);
        console.log(`unweighted: R₁₋₇ ${pct(u.recall17)}, R ${pct(u.recall)}, P ${pct(u.precision)}, θ ${pct(u.theta)}`);
        console.log(`recall by case: ${Object.entries(e.metrics.byCase).map(([k, v]) => `${k}: ${v.correct}/${v.n}`).join(", ") || "–"}`);
        console.log(`written to ${dir}`);
      } finally {
        method.close();
        candidates.close();
        labels.close();
      }
    });
}
