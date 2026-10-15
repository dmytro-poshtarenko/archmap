import type { TargetConfig } from "../config/schema.js";
import { loadUsage } from "../extract/run.js";
import { loadRules } from "../extract/rules.js";
import { loadInfra } from "../infra/index.js";
import { loadLinks, matchingOf, sourcesOf, type Variant } from "../match/run.js";
import type { Db } from "../store/db.js";
import { costOf } from "./cost.js";
import { estimateTokens } from "./providers/ollama.js";
import { chunksOf, extractionRequest, filesForExtraction, type SourceFile } from "./tasks/extractRoutes.js";
import { fragmentOf, freeRequest, selectRequest, systemDescription } from "./tasks/resolve.js";
import type { LlmProvider, LlmRequest } from "./types.js";

/** Output is not known before the answers; a third of the limit covers thinking and the answer. */
const OUTPUT_SHARE = 1 / 3;

export interface Estimate {
  tasks: Array<{ task: string; requests: number; inputTokens: number; outputTokens: number; usd: number; batchUsd: number }>;
  usd: number;
  batchUsd: number;
}

/**
 * The cost of route extraction and of resolving the sites the `full` run
 * leaves open, in each mode: the input tokens of a share of the requests
 * are counted by the provider (estimated from their length when it cannot
 * count), scaled to all requests, plus a third of the output limit.
 */
export async function estimateCost(db: Db, config: TargetConfig, read: (repo: string, path: string) => string, provider: LlmProvider, share: number): Promise<Estimate> {
  const usage = loadUsage(db);
  // the cloud model never reads closed licence zones unless the config allows it
  const closed = config.llm.cloud.sendNonPublishable ? "" : " AND publishable = 1";
  const code = db.prepare(`SELECT repo_id AS repo, path FROM file WHERE lang IN ('ts', 'tsx', 'js', 'jsx')${closed}`).all() as Array<{ repo: string; path: string }>;
  const files: SourceFile[] = code.map((f) => ({ ...f, text: read(f.repo, f.path), components: usage.get(`${f.repo}:${f.path}`) ?? [] }));
  const clients = new Set(config.components.filter((c) => c.kind === "client").map((c) => c.id));
  const extract = filesForExtraction(files, config.llm.extract.hints, clients)
    .flatMap((f) => chunksOf(f, config.llm.chunking))
    .map((c) => extractionRequest(c, config.name, config.llm.cloud.effort.extract));

  const base = (db.prepare("SELECT id, variant FROM run WHERE id IN ('full', 'no-llm') ORDER BY id = 'full' DESC").get() as { id: string; variant: string } | undefined) ?? null;
  const select: LlmRequest[] = [];
  const free: LlmRequest[] = [];
  if (base) {
    const sources = sourcesOf(JSON.parse(base.variant) as Variant);
    const { resolver, sites } = matchingOf(db, config);
    const open = new Set(loadLinks(db, base.id).filter((l) => l.status === "ambiguous" || l.status === "unresolved").map((l) => l.site));
    const system = systemDescription({ config, infra: loadInfra(db), routes: resolver.routesOf("broker-action", sources), sites, sources, guards: loadRules(config.rules.packs).matching.guards });
    const readable = new Set(code.map((f) => `${f.repo}:${f.path}`));
    for (const site of sites.filter((s) => open.has(s.id) && readable.has(`${s.repo}:${s.path}`))) {
      const common = { project: config.name, system, path: `${site.repo}:${site.path}`, code: fragmentOf(read(site.repo, site.path), site, config.llm.resolve.contextLines), subject: site.id };
      select.push(selectRequest({ ...common, effort: config.llm.cloud.effort.select, candidates: ["http:GET:/api/x@part", "http:GET:/api/y@part", "http:GET:/api/z@part", "http:GET:/api/w@part", "http:GET:/api/v@part"] }));
      free.push(freeRequest({ ...common, effort: config.llm.cloud.effort.free }));
    }
  }
  const tasks: Estimate["tasks"] = [];
  for (const [task, reqs] of [["extract-routes", extract], ["resolve-select", select], ["resolve-free", free]] as const) {
    if (reqs.length === 0) continue;
    const step = Math.max(1, Math.round(1 / share));
    const sample = reqs.filter((_, i) => i % step === 0);
    let counted = 0;
    for (const r of sample) counted += await count(provider, r);
    const inputTokens = (counted / sample.length) * reqs.length;
    const outputTokens = reqs.reduce((s, r) => s + r.maxTokens * OUTPUT_SHARE, 0);
    const usd = costOf(provider.model, { input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0 });
    tasks.push({ task, requests: reqs.length, inputTokens, outputTokens, usd, batchUsd: usd / 2 });
  }
  return { tasks, usd: tasks.reduce((s, t) => s + t.usd, 0), batchUsd: tasks.reduce((s, t) => s + t.batchUsd, 0) };
}

async function count(provider: LlmProvider, req: LlmRequest): Promise<number> {
  try {
    return provider.countTokens ? await provider.countTokens(req) : estimateTokens(req);
  } catch {
    return estimateTokens(req);
  }
}
