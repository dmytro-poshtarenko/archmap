import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runClassify } from "../../src/classify/run.js";
import { loadConfig } from "../../src/config/load.js";
import { dataLayout, toolRoot } from "../../src/core/paths.js";
import { programOf, runExtraction } from "../../src/extract/run.js";
import { extractInfra, writeInfra } from "../../src/infra/index.js";
import { LlmClient } from "../../src/llm/client.js";
import { ReplayProvider } from "../../src/llm/providers/replay.js";
import { reader, runLlmRoutes, runResolve } from "../../src/llm/run.js";
import type { LlmAnswer, LlmProvider, LlmRequest } from "../../src/llm/types.js";
import { loadLinks, runMatch } from "../../src/match/run.js";
import { openDb } from "../../src/store/db.js";
import { runInventory } from "../../src/workspace/inventory.js";
import { locateRepo } from "../../src/workspace/repos.js";
import { tempDir } from "../helpers.js";

/** A model scripted per task: what a capable model would answer on the case fixtures. */
class ScriptedProvider implements LlmProvider {
  readonly id = "ollama" as const;
  readonly model = "scripted";
  calls = 0;
  async complete<T>(req: LlmRequest<T>): Promise<LlmAnswer<T>> {
    this.calls++;
    let answer: unknown;
    if (req.task === "extract-routes") {
      const line = req.user.split("\n").find((l) => l.includes('"orders.cancel"'));
      answer = { routes: line ? [{ kind: "ddp-method", method: null, name: "orders.cancel", line: Number.parseInt(line, 10) }] : [] };
    } else if (req.task === "resolve-select") {
      // the comment above the call says the orders service serves order details
      const c = /^(C\d): .*@orders-api$/m.exec(req.user);
      answer = { choice: c?.[1] ?? "NONE", confidence: 0.8 };
    } else {
      answer = { target: { kind: "http", method: "GET", name: "/orders/42", component: "orders-api" }, confidence: 0.7 };
    }
    const raw = JSON.stringify(answer);
    return { parsed: req.schema.parse(answer) as T, raw, stopReason: "end_turn", modelRequested: "scripted", modelActual: "scripted-1", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, latencyMs: 1, costUsd: 0, cached: false, batchId: null };
  }
}

async function prepared(n: number, hints: string[] = []) {
  const loaded = loadConfig(join(toolRoot, "fixtures", "cases", `case${n}`, "archmap.yaml"));
  const config = { ...loaded.config, llm: { ...loaded.config.llm, extract: { hints }, stability: { share: 0, repeats: 1 } } };
  const db = openDb(":memory:");
  const layout = dataLayout(tempDir());
  runInventory(db, config, layout, loaded.path, { allowHeldout: false, configHash: loaded.hash });
  runExtraction(db, config, programOf(db, config, layout, loaded.path), { force: true });
  const files = db.prepare("SELECT repo_id AS repo, path FROM file").all() as Array<{ repo: string; path: string }>;
  const dirOf = (repo: string) => locateRepo(config.repos.find((r) => r.id === repo) as never, layout, loaded.path).dir;
  writeInfra(db, await extractInfra({ config, files, dirOf }), "t");
  return { db, config, read: reader(config, layout, loaded.path), hash: loaded.hash };
}

describe("the language model in the method (scripted answers)", () => {
  it("extracts the Meteor method the rules miss, so the full method links the case 5 site", async () => {
    const { db, config, read, hash } = await prepared(5, ["\\.methods\\s*(?:<[^>(]*>)?\\(\\s*\\{"]);
    runClassify(db, config);
    runMatch(db, config, { rules: true, infra: true, llm: false }, { configHash: hash });
    const provider = new ScriptedProvider();
    const routes = await runLlmRoutes(db, config, read, new LlmClient(db, provider, { budgetUsd: 1 }));
    expect(routes).toMatchObject({ files: 1, routes: 1, byKind: { "ddp-method:call": 1 } });

    runClassify(db, config);
    runMatch(db, config, { rules: true, infra: true, llm: true }, { configHash: hash });
    const [full] = loadLinks(db, "full");
    expect(full).toMatchObject({ status: "linked", target: "ddp:call:orders.cancel@app-server", caseNo: 5 });
    const [noLlm] = loadLinks(db, "no-llm");
    expect(noLlm?.status).toBe("unresolved");

    // a second run is served from the cache
    const again = new ScriptedProvider();
    await runLlmRoutes(db, config, read, new LlmClient(db, again, { budgetUsd: 1 }));
    expect(again.calls).toBe(0);
  });

  it("resolves the case 6 ambiguity in select mode, and normalises a free answer to a declared route", async () => {
    const { db, config, read, hash } = await prepared(6);
    runClassify(db, config);
    runMatch(db, config, { rules: true, infra: true, llm: true }, { configHash: hash });
    const provider = new ScriptedProvider();
    const client = new LlmClient(db, provider, { budgetUsd: 1 });
    const select = await runResolve(db, config, read, client, { base: "full", mode: "select", scope: "open", configHash: hash });
    expect(select).toMatchObject({ run: "full.select.local", asked: 1, linked: 1 });
    expect(loadLinks(db, "full.select.local")[0]).toMatchObject({ status: "linked", target: "http:GET:/orders/:id@orders-api", provenance: "llm", caseNo: 6 });

    const free = await runResolve(db, config, read, client, { base: "full", mode: "free", scope: "open", configHash: hash });
    expect(free).toMatchObject({ run: "full.free.local", linked: 1, invented: 0 });
    expect(loadLinks(db, "full.free.local")[0]?.target).toBe("http:GET:/orders/:id@orders-api");

    // the recorded answers reproduce the same run offline
    const replay = new LlmClient(db, new ReplayProvider(db, { provider: "ollama", model: "scripted" }), { budgetUsd: 1 });
    const again = await runResolve(db, config, read, replay, { base: "full", mode: "select", scope: "open", configHash: hash });
    expect(again).toMatchObject({ run: "full.select.local", linked: 1, cacheHits: 1, costUsd: 0 });
  });
});
