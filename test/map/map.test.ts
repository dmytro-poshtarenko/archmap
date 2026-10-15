import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { runClassify } from "../../src/classify/run.js";
import { loadConfig } from "../../src/config/load.js";
import { dataLayout, toolRoot } from "../../src/core/paths.js";
import { programOf, runExtraction } from "../../src/extract/run.js";
import { extractInfra, writeInfra } from "../../src/infra/index.js";
import { featureOf } from "../../src/map/feature.js";
import { addFeatureView, buildMap } from "../../src/map/run.js";
import { runMatch } from "../../src/match/run.js";
import { openDb } from "../../src/store/db.js";
import { runInventory } from "../../src/workspace/inventory.js";
import { locateRepo } from "../../src/workspace/repos.js";
import { tempDir } from "../helpers.js";

const MINI = join(toolRoot, "configs", "mini.yaml");

/** mini-complex in a data workspace on disk: inventory, extraction, infrastructure, cases, the no-llm run. */
async function workspace() {
  const loaded = loadConfig(MINI);
  const { config } = loaded;
  const data = tempDir();
  const layout = dataLayout(data);
  mkdirSync(layout.db, { recursive: true });
  const db = openDb(join(layout.db, `${config.name}.sqlite`));
  runInventory(db, config, layout, loaded.path, { allowHeldout: false, configHash: loaded.hash });
  runExtraction(db, config, programOf(db, config, layout, loaded.path), { force: true });
  const files = db.prepare("SELECT repo_id AS repo, path FROM file").all() as Array<{ repo: string; path: string }>;
  const dirOf = (repo: string) => locateRepo(config.repos.find((r) => r.id === repo) as never, layout, loaded.path).dir;
  writeInfra(db, await extractInfra({ config, files, dirOf }), "t");
  runClassify(db, config);
  runMatch(db, config, { rules: true, infra: true, llm: false }, { configHash: loaded.hash });
  return { db, config, data };
}

describe("the LikeC4 map", () => {
  it("draws mini-complex with no diagnostics", async () => {
    const { db, config, data } = await workspace();
    const dir = join(data, "likec4");
    const { graph, diagnostics } = await buildMap(db, config, "no-llm", dir);
    expect(diagnostics).toEqual([]);
    const rel = (s: string, t: string) => graph.relations.find((r) => r.source === s && r.target === t);
    expect(rel("web", "api.ep_orders")).toMatchObject({ kind: "http", tags: ["rules", "viaGateway"], metadata: { case: "3", sites: "3", run: "no-llm" } });
    expect(rel("worker", "api.ep_orders")).toMatchObject({ kind: "http", metadata: { case: "2", sites: "1" } });
    expect(rel("api", "redis")?.kind).toBe("event");
    expect(rel("redis", "worker")?.kind).toBe("event");
    const text = readFileSync(join(dir, "model.c4"), "utf8");
    expect(text).toContain("view index");
    expect(text).not.toMatch(/fetch\(|http\.get\(/);
  }, 60_000);

  it("finds the parts of a feature: a scenario fixed before the run", async () => {
    const { db, config, data } = await workspace();
    const dir = join(data, "likec4");
    const { graph } = await buildMap(db, config, "no-llm", dir);
    // orders: who calls the orders routes and what follows from them, two hops either way
    expect(featureOf(graph, { name: "Orders", seeds: ["/api/orders*"], depth: 2 }).elements).toEqual(["api.ep_orders", "api.ep_users", "redis", "web", "worker"]);
    // the worker's own dependencies only
    expect(featureOf(graph, { name: "Worker", seeds: ["worker"], depth: 1, direction: "out" }).elements).toEqual(["api.ep_orders", "worker"]);
    // the queue: publishers and subscribers of events
    expect(featureOf(graph, { name: "Queue", seeds: ["redis"], depth: 1, kinds: ["event"] }).elements).toEqual(["api", "redis", "worker"]);
    const { feature, diagnostics } = await addFeatureView(graph, dir, { name: "Orders", seeds: ["/api/orders*"], depth: 2 });
    expect(diagnostics).toEqual([]);
    expect(readFileSync(join(dir, `feature_${feature.slug}.c4`), "utf8")).toContain("include api.ep_orders, api.ep_users, redis, web, worker");
  }, 60_000);
});

describe("the archmap MCP server", () => {
  it("serves its three tools over stdio", async () => {
    const { data, db } = await workspace();
    db.close();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(toolRoot, "src", "cli", "index.ts"), "--config", MINI, "--data", data, "mcp"],
      cwd: toolRoot,
      stderr: "ignore",
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(["create_feature_view", "list_unresolved", "rebuild_map"]);
      const text = (r: unknown) => JSON.parse(((r as { content: Array<{ text: string }> }).content[0] as { text: string }).text);

      const rebuilt = text(await client.callTool({ name: "rebuild_map", arguments: { variant: "no-llm" } }));
      expect(rebuilt).toMatchObject({ run: "no-llm", diagnostics: [] });
      expect(rebuilt.status).toEqual({ linked: 8 });

      const open = text(await client.callTool({ name: "list_unresolved", arguments: { run: "no-llm" } }));
      expect(open).toEqual({ run: "no-llm", total: 0, sites: [] });

      const view = text(await client.callTool({ name: "create_feature_view", arguments: { name: "Orders", seeds: ["/api/orders*"], depth: 2, run: "no-llm" } }));
      expect(view).toMatchObject({ view: "feature_orders", elements: ["api.ep_orders", "api.ep_users", "redis", "web", "worker"], diagnostics: [] });
    } finally {
      await client.close();
    }
  }, 120_000);
});
