import type { Command } from "commander";
import { runAll } from "../../experiments/runAll.js";
import type { ModelChoice } from "../../llm/providers/index.js";
import type { Split } from "../../labelling/store.js";
import { createContext, type GlobalOptions } from "../context.js";

export function registerRunAll(program: Command): void {
  program
    .command("run-all")
    .description("reproduce a measurement in one command: extraction, infrastructure, the model, cases, variants, evaluation and analysis")
    .option("--model <model>", "local, cloud, cloud-cli, replay-local, replay-cloud or replay-cloud-cli (replay asks nothing new)", "local")
    .option("--sites <sites>", "sample (the model is asked only about the labelled sample) or everything", "sample")
    .option("--split <split>", "split to evaluate: dev, or test and heldout after the freeze", "dev")
    .option("--no-analysis", "skip the Python analysis")
    .option("--budget-usd <usd>", "spending limit for the cloud model", (v) => Number.parseFloat(v))
    .option("--method-only", "only the method itself and the variant without the model (the held-out repository)")
    .action(async (opts: { model: string; sites: string; split: string; analysis: boolean; budgetUsd?: number; methodOnly?: boolean }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      if (opts.sites !== "sample" && opts.sites !== "everything") throw new Error("--sites must be sample or everything");
      const db = ctx.openDb();
      try {
        const steps = await runAll(db, ctx.loaded, ctx.layout, {
          model: opts.model as ModelChoice,
          sites: opts.sites,
          split: opts.split as Split,
          analysis: opts.analysis,
          budgetUsd: opts.budgetUsd,
          methodOnly: opts.methodOnly ?? false,
          frozen: opts.split === "dev" ? false : ctx.frozen(),
          log: ctx.log,
        });
        const seconds = steps.reduce((s, x) => s + x.seconds, 0);
        const usd = steps.reduce((s, x) => s + x.costUsd, 0);
        console.log(`${steps.length} steps in ${Math.round(seconds)}s, $${usd.toFixed(2)} spent on the model`);
      } finally {
        db.close();
      }
    });
}
