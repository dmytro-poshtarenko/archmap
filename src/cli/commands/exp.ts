import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { programOf } from "../../extract/run.js";
import { collectCbm, writeCbmRun } from "../../experiments/cbm.js";
import { generateH3, h3Dir, runH3, runProbe, toCsv } from "../../experiments/h3run.js";
import { LlmClient } from "../../llm/client.js";
import { concurrencyOf, type ModelChoice, providerOf } from "../../llm/providers/index.js";
import { reader } from "../../llm/run.js";
import { createContext, type GlobalOptions } from "../context.js";

export function registerExperiments(program: Command): void {
  const exp = program.command("exp").description("experiments run before the freeze: hypothesis 3 and the memorisation probe");

  exp
    .command("h3-generate")
    .description("make the synthetic variants of hypothesis 3 from the dev split's MIT controllers, each checked by the route detector")
    .action((_opts: unknown, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { config } = ctx.loaded;
      const db = ctx.openDb();
      try {
        const out = h3Dir(ctx.layout.root, config.name);
        const m = generateH3(db, config, programOf(db, config, ctx.layout, ctx.loaded.path), reader(config, ctx.layout, ctx.loaded.path), out, config.experiment.seeds.sample);
        const routes = m.controllers.reduce((s, c) => s + c.routes.length, 0);
        console.log(`${m.controllers.length} controllers (${routes} routes), ${m.variants.length} variants checked by the route detector, in ${out}`);
        for (const c of m.controllers) console.log(`  ${c.id} ${c.source} → ${c.path}: ${c.routes.map((r) => `${r.method} ${r.original}→${r.renamed}`).join(", ")}`);
      } finally {
        db.close();
      }
    });

  exp
    .command("baseline-cbm")
    .description("baseline: index the target with codebase-memory-mcp over MCP and store its HTTP calls and event channels as run cbm")
    .option("--binary <path>", "codebase-memory-mcp executable", "codebase-memory-mcp")
    .action(async (opts: { binary: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { config } = ctx.loaded;
      const { version, predictions } = await collectCbm(config, ctx.layout, ctx.loaded.path, opts.binary);
      const db = ctx.openDb();
      try {
        const r = writeCbmRun(db, version, predictions, reader(config, ctx.layout, ctx.loaded.path), ctx.loaded.hash);
        const byEdge = new Map<string, number>();
        for (const p of predictions) byEdge.set(p.edge, (byEdge.get(p.edge) ?? 0) + 1);
        console.log(`codebase-memory-mcp ${version}: ${predictions.length} edges (${[...byEdge].map(([k, v]) => `${k} ${v}`).join(", ")})`);
        console.log(`run ${r.run}: answers placed on ${r.places} lines that quote their path or channel`);
      } finally {
        db.close();
      }
    });

  for (const [name, description] of [
    ["h3-run", "extract the routes of every variant with a model and write h3_results-<model>.csv"],
    ["probe", "memorisation probe: ask for a controller's routes with its path only, original and renamed"],
  ] as const) {
    exp
      .command(name)
      .description(description)
      .option("--model <model>", "local, cloud, cloud-cli, replay-local, replay-cloud or replay-cloud-cli", "local")
      .option("--budget-usd <usd>", "spending limit for the cloud model", (v) => Number.parseFloat(v))
      .option("--levels <list>", "h3-run: only these length levels, e.g. 0,3,5", (v) => v.split(",").map((x) => x.trim()))
      .option("--no-position", "h3-run: without the position series")
      .action(async (opts: { model: string; budgetUsd?: number; levels?: string[]; position: boolean }, cmd: Command) => {
        const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
        const { config } = ctx.loaded;
        const db = ctx.openDb();
        try {
          const provider = providerOf(config, opts.model as ModelChoice, db);
          const client = new LlmClient(db, provider, { budgetUsd: opts.budgetUsd ?? config.llm.budgetUsd, concurrency: concurrencyOf(opts.model as ModelChoice), log: ctx.log });
          const out = h3Dir(ctx.layout.root, config.name);
          const tag = client.tag === "cloud" ? "cloud" : "local";
          if (name === "h3-run") {
            const rows = await runH3(out, config, client, provider, { levels: opts.levels, position: opts.position });
            writeFileSync(join(out, `h3_results-${tag}.csv`), toCsv(rows));
            const byLevel = new Map<string, { n: number; found: number }>();
            for (const r of rows) {
              const k = `${r.series} ${r.level}`;
              const e = byLevel.get(k) ?? { n: 0, found: 0 };
              e.n++;
              e.found += r.found;
              byLevel.set(k, e);
            }
            for (const [k, e] of byLevel) console.log(`  ${k}: ${e.found}/${e.n} routes found`);
          } else {
            const rows = await runProbe(out, config, client);
            writeFileSync(join(out, `probe-${tag}.csv`), toCsv(rows));
            for (const which of ["original", "renamed"]) {
              const r = rows.filter((x) => x.path === which);
              console.log(`  ${which} paths: ${r.reduce((s, x) => s + x.recalled, 0)}/${r.reduce((s, x) => s + x.routes, 0)} routes recalled`);
            }
          }
          console.log(`${client.stats.requests} requests (${client.stats.cacheHits} from the cache), $${client.stats.costUsd.toFixed(4)}`);
        } finally {
          db.close();
        }
      });
  }
}
