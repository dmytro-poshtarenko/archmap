import { runClassify } from "../classify/run.js";
import type { CliContext } from "../cli/context.js";
import { type LoadedConfig, loadConfig, writeLock } from "../config/load.js";
import type { ModelUse } from "../config/schema.js";
import { hashOf } from "../core/hash.js";
import { programOf, runExtraction } from "../extract/run.js";
import { extractInfra, writeInfra } from "../infra/index.js";
import { LlmClient } from "../llm/client.js";
import { concurrencyOf, providerOf } from "../llm/providers/index.js";
import { reader, runLlmRoutes, runResolve } from "../llm/run.js";
import type { Diagnostic } from "../map/likec4.js";
import { buildMap, currentMapDir, mapDir } from "../map/run.js";
import { runMatch } from "../match/run.js";
import { getMeta } from "../store/db.js";
import { fetchRepos } from "../workspace/fetch.js";
import { runInventory } from "../workspace/inventory.js";
import { pinRepos } from "../workspace/pin.js";
import { locateRepo } from "../workspace/repos.js";

export interface MapResult {
  run: string;
  dir: string;
  elements: number;
  relations: number;
  diagnostics: Diagnostic[];
  steps: Array<{ step: string; seconds: number; note: string }>;
}

/**
 * The whole method in one go, from the code to a validated map: remote
 * repositories pinned and fetched, the inventory, the rules, the
 * infrastructure, then, with a model, the declarations the rules miss, the
 * cases and the links, the model's choice on the sites left open, and the
 * LikeC4 map. Every step is the command of the same name, so a step can still
 * be run on its own; answers of the model come from the cache when asked
 * before.
 */
export async function runMapPipeline(ctx: CliContext, model: ModelUse, log: (m: string) => void): Promise<MapResult> {
  const steps: MapResult["steps"] = [];
  const step = async <T>(name: string, fn: () => T | Promise<T>, note: (r: T) => string): Promise<T> => {
    const t0 = performance.now();
    const r = await fn();
    const rec = { step: name, seconds: Math.round((performance.now() - t0) / 100) / 10, note: note(r) };
    steps.push(rec);
    log(`${name}: ${rec.note} (${rec.seconds} s)`);
    return r;
  };
  let loaded: LoadedConfig = ctx.loaded;
  const { layout } = ctx;
  const heldout = loaded.config.repos.some((r) => r.role === "heldout");
  if (loaded.config.repos.some((r) => r.url !== undefined)) {
    await step(
      "pin",
      () => {
        const result = pinRepos(loaded.config, loaded.lock, { fixed: loaded.fixedShas });
        if (result.pinned.length > 0) writeLock(loaded.path, result.lock);
        loaded = loadConfig(loaded.path);
        return result;
      },
      (r) => (r.pinned.length > 0 ? `pinned ${r.pinned.map((p) => p.id).join(", ")}` : "every repository pinned already"),
    );
    await step(
      "fetch",
      () => fetchRepos(loaded.config, layout, loaded.path, { allowHeldout: heldout && ctx.frozen(), log }),
      (r) => r.map((x) => `${x.id} ${x.status}`).join(", "),
    );
  }
  const { config } = loaded;
  const db = ctx.openDb();
  try {
    await step(
      "inventory",
      () => runInventory(db, config, layout, loaded.path, { allowHeldout: heldout && ctx.frozen(), configHash: loaded.hash, log }),
      (r) => `${r.repos.reduce((n, x) => n + x.files, 0)} files in ${r.repos.length} repositories`,
    );
    await step(
      "extract",
      () => runExtraction(db, config, programOf(db, config, layout, loaded.path)),
      (s) => `${s.sites} call sites, ${s.routes} routes`,
    );
    await step(
      "extract-infra",
      async () => {
        const files = db.prepare("SELECT repo_id AS repo, path FROM file").all() as Array<{ repo: string; path: string }>;
        const dirOf = (repo: string) => locateRepo(config.repos.find((r) => r.id === repo) as never, layout, loaded.path).dir;
        const facts = await extractInfra({ config, files, dirOf });
        writeInfra(db, facts, hashOf({ inventory: getMeta(db, "inventory.hash"), infra: config.infra, components: config.components }));
        return facts;
      },
      (f) => `${f.containers.length} containers, ${f.rules.length} gateway rules`,
    );
    const read = reader(config, layout, loaded.path);
    const client = () => {
      if (model === "none") throw new Error("no model");
      return new LlmClient(db, providerOf(config, model, db), { budgetUsd: config.llm.budgetUsd, concurrency: concurrencyOf(model), log });
    };
    if (model !== "none") {
      await step("llm-routes", () => runLlmRoutes(db, config, read, client()), (s) => `${s.routes} declarations from ${s.files} files, ${s.cacheHits} of ${s.requests} answers from the cache`);
    }
    await step("classify", () => runClassify(db, config), (s) => `${Object.values(s.byCase).reduce((n, x) => n + x, 0)} call sites`);
    const matched = await step(
      "match",
      () => runMatch(db, config, { rules: true, infra: true, llm: true }, { configHash: loaded.hash }),
      (s) => Object.entries(s.byStatus).map(([k, n]) => `${k} ${n}`).join(", "),
    );
    let run = matched.run;
    if (model !== "none") {
      const resolved = await step(
        "resolve",
        () => runResolve(db, config, read, client(), { base: matched.run, mode: "select", scope: "open", configHash: loaded.hash }),
        (s) => `${s.asked} open sites asked, ${s.linked} linked, ${s.cacheHits} of ${s.requests} answers from the cache`,
      );
      run = resolved.run;
    }
    const dir = mapDir(layout.root, config.name, run);
    const built = await step(
      "build-map",
      () => buildMap(db, config, run, dir, { current: currentMapDir(layout.root, config.name), read }),
      (b) => `${b.graph.elements.length} elements, ${b.graph.relations.length} relations, ${b.diagnostics.length === 0 ? "no diagnostics" : `${b.diagnostics.length} diagnostics`}`,
    );
    return { run, dir, elements: built.graph.elements.length, relations: built.graph.relations.length, diagnostics: built.diagnostics, steps };
  } finally {
    db.close();
  }
}
