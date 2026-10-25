import type { Command } from "commander";
import type { CallSite } from "../../core/types.js";
import { LlmClient } from "../../llm/client.js";
import { concurrencyOf, MODEL_CHOICES, type ModelChoice, providerOf } from "../../llm/providers/index.js";
import { reader, runLlmRoutes, runResolve } from "../../llm/run.js";
import { sampledLines } from "../../experiments/runAll.js";
import { llmStats } from "../../llm/stats.js";
import type { LlmProvider } from "../../llm/types.js";
import { openCandidates, type Split } from "../../labelling/store.js";
import { createContext, type GlobalOptions } from "../context.js";

function model(value: string): ModelChoice {
  if (!(MODEL_CHOICES as readonly string[]).includes(value)) throw new Error(`--model must be one of ${MODEL_CHOICES.join(", ")}`);
  return value as ModelChoice;
}

/**
 * Sites on the lines of the labelled sample: the model is asked only about
 * them when an evaluation needs no more. Only the sampled lines are read,
 * never a label.
 */
function sampledSites(ctx: ReturnType<typeof createContext>): (site: CallSite) => boolean {
  const candidates = openCandidates(ctx.layout, ctx.loaded.config.name);
  try {
    const rows = candidates.prepare("SELECT c.repo, c.path, c.line FROM sample s JOIN candidate c ON c.id = s.candidate").all() as Array<{ repo: string; path: string; line: number }>;
    const byFile = new Map<string, number[]>();
    for (const r of rows) byFile.set(`${r.repo}:${r.path}`, [...(byFile.get(`${r.repo}:${r.path}`) ?? []), r.line]);
    return (s) => (byFile.get(`${s.repo}:${s.path}`) ?? []).some((line) => line >= s.line && line <= s.endLine);
  } finally {
    candidates.close();
  }
}

export function registerLlm(program: Command): void {
  program
    .command("llm-routes")
    .description("task (a): the language model lists the route declarations of server files the rules do not cover")
    .option("--model <model>", "local (Ollama), cloud (Claude API), cloud-cli (Claude Code subscription), replay-local, replay-cloud or replay-cloud-cli", "local")
    .option("--limit <n>", "only the first n files (smoke tests)", (v) => Number.parseInt(v, 10))
    .option("--budget-usd <usd>", "spending limit for the cloud model", (v) => Number.parseFloat(v))
    .action(async (opts: { model: string; limit?: number; budgetUsd?: number }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { config } = ctx.loaded;
      const db = ctx.openDb();
      try {
        const client = new LlmClient(db, providerOf(config, model(opts.model), db), { budgetUsd: opts.budgetUsd ?? config.llm.budgetUsd, concurrency: concurrencyOf(model(opts.model)), log: ctx.log });
        let seen = 0;
        const s = await runLlmRoutes(db, config, reader(config, ctx.layout, ctx.loaded.path), client, opts.limit ? { files: () => seen++ < (opts.limit ?? 0) } : {});
        console.log(`${s.files} files, ${s.requests} requests (${s.cacheHits} from the cache), ${s.routes} routes extracted, ${s.failed} answers without routes`);
        console.log(`by kind: ${Object.entries(s.byKind).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
        console.log(`cost $${s.costUsd.toFixed(4)}; answered by ${Object.entries(client.stats.models).map(([k, v]) => `${k} ${v}`).join(", ") || "the cache"}`);
      } finally {
        db.close();
      }
    });

  program
    .command("resolve")
    .description("tasks (b) and (c): the language model resolves sites the rules leave open, in select or free mode")
    .option("--base <run>", "matching run to start from", "full")
    .option("--mode <mode>", "select (among the rules' candidates) or free", "select")
    .option("--scope <scope>", "open (sites left ambiguous or unresolved) or all (hypothesis 2)", "open")
    .option("--sites <sites>", "everything, or sample (only the lines of the labelled sample)", "everything")
    .option("--model <model>", "local (Ollama), cloud (Claude API), cloud-cli (Claude Code subscription), replay-local, replay-cloud or replay-cloud-cli", "local")
    .option("--split <split>", "with --sites sample: only the sample lines of this split (dev, test, heldout)")
    .option("--limit <n>", "only the first n sites (smoke tests)", (v) => Number.parseInt(v, 10))
    .option("--budget-usd <usd>", "spending limit for the cloud model", (v) => Number.parseFloat(v))
    .action(async (opts: { base: string; mode: string; scope: string; sites: string; split?: string; model: string; limit?: number; budgetUsd?: number }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { config } = ctx.loaded;
      if (opts.mode !== "select" && opts.mode !== "free") throw new Error("--mode must be select or free");
      if (opts.scope !== "open" && opts.scope !== "all") throw new Error("--scope must be open or all");
      const inSample = opts.sites !== "sample" ? undefined : opts.split ? sampledLines(ctx.layout, config.name, opts.split as Split) : sampledSites(ctx);
      const db = ctx.openDb();
      try {
        const client = new LlmClient(db, providerOf(config, model(opts.model), db), { budgetUsd: opts.budgetUsd ?? config.llm.budgetUsd, concurrency: concurrencyOf(model(opts.model)), log: ctx.log });
        let taken = 0;
        const s = await runResolve(db, config, reader(config, ctx.layout, ctx.loaded.path), client, {
          base: opts.base,
          mode: opts.mode,
          scope: opts.scope,
          configHash: ctx.loaded.hash,
          sites: (site) => (inSample ? inSample(site) : true) && (opts.limit === undefined || taken++ < opts.limit),
        });
        console.log(`run ${s.run}: ${s.asked} sites asked (${s.requests} requests, ${s.cacheHits} from the cache)`);
        console.log(`linked ${s.linked}, no target ${s.none} (${s.invented} invented targets), no usable answer ${s.failed}`);
        console.log(`cost $${s.costUsd.toFixed(4)}; answered by ${Object.entries(client.stats.models).map(([k, v]) => `${k} ${v}`).join(", ") || "the cache"}`);
      } finally {
        db.close();
      }
    });

  program
    .command("llm-cost")
    .description("estimate what the cloud model would cost for route extraction and resolution, from counted tokens of a share of the requests")
    .option("--share <share>", "share of the requests whose tokens are counted", (v) => Number.parseFloat(v), 0.02)
    .action(async (opts: { share: number }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { config } = ctx.loaded;
      const db = ctx.openDb();
      try {
        const { estimateCost } = await import("../../llm/estimate.js");
        let provider: LlmProvider;
        try {
          provider = providerOf(config, "cloud", db);
        } catch {
          ctx.log("no API key: input tokens are estimated from the length of the requests");
          provider = { id: "anthropic", model: config.llm.cloud.model, complete: () => Promise.reject(new Error("no API key")) };
        }
        const e = await estimateCost(db, config, reader(config, ctx.layout, ctx.loaded.path), provider, opts.share);
        for (const t of e.tasks) console.log(`${t.task}: ${t.requests} requests, ~${Math.round(t.inputTokens / 1000)}k input tokens, ~$${t.usd.toFixed(2)} ($${t.batchUsd.toFixed(2)} in batches)`);
        console.log(`total ~$${e.usd.toFixed(2)}, ~$${e.batchUsd.toFixed(2)} in batches; budget $${config.llm.budgetUsd}`);
      } finally {
        db.close();
      }
    });

  program
    .command("llm-stats")
    .description("what the answer cache holds: answers, cost, models that answered, stability of repeated requests")
    .action((_opts: unknown, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const db = ctx.openDb();
      try {
        for (const s of llmStats(db)) {
          console.log(`${s.task} via ${s.provider}: ${s.answers} answers, ${s.parsed} parsed, $${s.costUsd.toFixed(4)}, ${Math.round(s.inputTokens / 1000)}k in / ${Math.round(s.outputTokens / 1000)}k out`);
          console.log(`  stop: ${Object.entries(s.byStop).map(([k, v]) => `${k} ${v}`).join(", ")}; models: ${Object.entries(s.models).map(([k, v]) => `${k} ${v}`).join(", ")}`);
          if (s.repeated > 0) console.log(`  stability: ${s.stable}/${s.repeated} repeated requests gave the same decision`);
        }
      } finally {
        db.close();
      }
    });
}
