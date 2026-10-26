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
import { renderModel } from "../../src/map/dsl.js";
import { featureOf, slugOf } from "../../src/map/feature.js";
import { buildGraph, type MapElement, type MapGraph } from "../../src/map/graph.js";
import { addFeatureView, buildMap, MODEL_FILE } from "../../src/map/run.js";
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
    // the gateway's rules: / serves the web client, /api the API
    expect(rel("traefik", "web")).toMatchObject({ kind: "route", title: "/", tags: ["infra"] });
    expect(rel("traefik", "api")).toMatchObject({ kind: "route", title: "/api" });
    expect(graph.elements.find((e) => e.id === "traefik")?.description).toBe("Gateway. Routes /api to api. Routes / to web.");
    const text = readFileSync(join(dir, MODEL_FILE), "utf8");
    expect(text).toContain("view index");
    expect(text).not.toMatch(/fetch\(|http\.get\(/);
    // a developer hovering an element or an arrow sees what is behind it
    expect(graph.elements.find((e) => e.id === "worker")?.description).toBe("Service. Uses api. Receives events from redis.");
    expect(rel("web", "api.ep_orders")?.description).toMatch(/^GET \/api\/orders.*Decided by rules; 3 call sites\.$/);
    expect(text).toContain("Arrows: http solid blue");
    // each view names its level of the C4 model
    expect(text).toContain("view context {\n    title 'C1: mini system context'");
    expect(text).toContain("view index {\n    title 'C2: mini containers and the links between them'");
    // every arrow names its protocol, the bus's taken from the infrastructure
    expect(rel("web", "api.ep_orders")?.technology).toBe("HTTP");
    expect(rel("api", "redis")?.technology).toBe("Redis (events)");
    // the C2 view: containers in rows, one arrow per pair standing for every call between them
    const overview = graph.relations.filter((r) => r.tags.includes("overview"));
    expect(overview.find((r) => r.source === "web" && r.target === "api")).toMatchObject({ kind: "http", title: "REST: 5 routes", technology: "HTTP" });
    expect(text).toContain("group 'Clients' {\n      include web\n    }");
    expect(text).toContain("exclude * -> * where tag is not #overview");
    expect(JSON.parse(readFileSync(join(dir, "likec4.config.json"), "utf8"))).toEqual({ name: "mini", title: "mini: C4 Diagrams" });
  }, 60_000);

  it("finds the parts of a feature: a scenario fixed before the run", async () => {
    const { db, config, data } = await workspace();
    const dir = join(data, "likec4");
    const { graph } = await buildMap(db, config, "no-llm", dir);
    // orders: who calls the orders routes and what follows from them, two hops either way;
    // the gateway comes in because it serves the web client
    expect(featureOf(graph, { name: "Orders", seeds: ["/api/orders*"], depth: 2 }).elements).toEqual(["api.ep_orders", "api.ep_users", "redis", "traefik", "web", "worker"]);
    // the worker's own dependencies only
    expect(featureOf(graph, { name: "Worker", seeds: ["worker"], depth: 1, direction: "out" }).elements).toEqual(["api.ep_orders", "worker"]);
    // the queue: publishers and subscribers of events
    expect(featureOf(graph, { name: "Queue", seeds: ["redis"], depth: 1, kinds: ["event"] }).elements).toEqual(["api", "redis", "worker"]);
    const { feature, diagnostics } = await addFeatureView(graph, dir, { name: "Orders", seeds: ["/api/orders*"], depth: 2 }, "no-llm");
    expect(diagnostics).toEqual([]);
    const view = readFileSync(join(dir, `feature_${feature.slug}.c4`), "utf8");
    expect(view).toContain("include api.ep_orders, api.ep_users, redis, traefik, web, worker");
    expect(view).toContain("description 'Seeds: /api/orders*; 2 hops both ways; kinds: all; run no-llm.'");
    // endpoint groups inside the api make it a C3 view
    expect(view).toContain("title 'C3: Orders'");
  }, 60_000);

  it("gives a feature view an id from its name", () => {
    expect(slugOf("Orders & payments")).toBe("orders_payments");
    // the C4 level is the map's to add
    expect(slugOf("C3: Orders & payments")).toBe("orders_payments");
    // what follows a parenthesis explains the view and stays out of its id
    expect(slugOf("User presence (presence actions, callers, sessions)")).toBe("user_presence");
    // a name with no Latin letters or digits still gets an id of its own
    expect(slugOf("🙂")).toMatch(/^feature_[0-9a-f]{8}$/);
    expect(slugOf("🙂")).not.toBe(slugOf("🙃"));
  });

  it("keeps the view of a large part readable", () => {
    const el = (id: string, kind: MapElement["kind"], parent: string | null, tags: string[] = []): MapElement => ({
      name: id.split(".").pop() as string,
      id,
      kind,
      title: id,
      parent,
      tags,
      metadata: {},
    });
    const collections = Array.from({ length: 13 }, (_, i) => el(`db.c${i}`, "collection", "db", i < 2 ? ["shared"] : []));
    const groups = Array.from({ length: 13 }, (_, i) => el(`api.ep_g${i}`, "endpointGroup", "api"));
    const graph: MapGraph = { elements: [el("db", "database", null), el("api", "service", null), ...collections, ...groups], relations: [] };
    const text = renderModel(graph, "t", "d");
    const view = (name: string) => text.slice(text.indexOf(`view of_${name} `), text.indexOf("}", text.indexOf(`view of_${name} `)));
    // a database shows the collections two or more parts share
    expect(view("db")).toContain(`exclude ${collections.slice(2).map((c) => c.id).join(", ")}`);
    expect(view("db")).not.toContain("autoLayout");
    // a part with many elements lays them out top to bottom
    expect(view("api")).toContain("autoLayout LeftRight");
    expect(view("api")).not.toContain("exclude api.");
    // a C3 view draws the calls themselves, not the C2 summary arrows
    expect(view("api")).toContain("exclude * -> * where tag is #overview");
  });
});

describe("the C2 summary arrows", () => {
  it("draw broker calls that go both ways as one arrow with two heads, from a service to the bus", () => {
    const config = { name: "t", repos: [], components: [
      { id: "a", kind: "service", include: [] },
      { id: "b", kind: "service", include: [] },
      { id: "bus", kind: "bus", include: [] },
    ] } as never;
    const site = (id: string, component: string, role: string) =>
      ({ id, repo: "r", path: "p", line: 1, endLine: 1, col: 1, type: "broker", role, detector: "d", method: null, address: { parts: [] }, components: [component], liftedFrom: null }) as never;
    const link = (s: string, target: string) => ({ site: s, status: "linked", target, route: null, component: null, reason: null, via: [], provenance: "rules", caseNo: 1, alternatives: [] });
    const graph = buildGraph(
      config,
      "run",
      [site("s1", "a", "request"), site("s2", "b", "request"), site("s3", "a", "publish"), site("s4", "a", "subscribe")],
      [link("s1", "action:-:b.do@b"), link("s2", "action:-:a.do@a"), link("s3", "event:-:e1@*"), link("s4", "event:-:e2@*")],
      { protocols: { bus: "NATS" } },
    );
    const overview = graph.relations.filter((r) => r.tags.includes("overview"));
    expect(overview.map((r) => [r.source, r.target, r.title, r.technology, r.bothWays])).toEqual([
      ["a", "b", "RPC: 2 actions (both ways)", "NATS (RPC)", true],
      ["a", "bus", "events: 2 (both ways)", "NATS (events)", true],
    ]);
    // the calls themselves keep their direction
    expect(graph.relations.filter((r) => !r.tags.includes("overview")).map((r) => [r.source, r.target, r.technology])).toContainEqual(["bus", "a", "NATS (events)"]);
  });
});

describe("the archmap MCP server", () => {
  it("serves its four tools over stdio", async () => {
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
      expect(tools).toEqual(["create_feature_view", "delete_feature_view", "list_unresolved", "rebuild_map"]);
      const text = (r: unknown) => JSON.parse(((r as { content: Array<{ text: string }> }).content[0] as { text: string }).text);

      const rebuilt = text(await client.callTool({ name: "rebuild_map", arguments: { variant: "no-llm" } }));
      expect(rebuilt).toMatchObject({ run: "no-llm", diagnostics: [] });
      expect(rebuilt.status).toEqual({ linked: 8 });

      const open = text(await client.callTool({ name: "list_unresolved", arguments: { run: "no-llm" } }));
      expect(open).toEqual({ run: "no-llm", total: 0, sites: [] });

      const view = text(await client.callTool({ name: "create_feature_view", arguments: { name: "Orders", seeds: ["/api/orders*"], depth: 2, run: "no-llm" } }));
      expect(view).toMatchObject({ view: "feature_orders", elements: ["api.ep_orders", "api.ep_users", "redis", "traefik", "web", "worker"], diagnostics: [] });
      expect(view.open).toMatch(/^http:\/\/localhost:5173\/view\/feature_orders\//);
      expect(view.links).toContainEqual(expect.objectContaining({ from: "web", to: "api.ep_orders", kind: "http" }));

      const removed = text(await client.callTool({ name: "delete_feature_view", arguments: { view: "Orders", run: "no-llm" } }));
      expect(removed).toEqual({ removed: "feature_orders", run: "no-llm" });
    } finally {
      await client.close();
    }
  }, 120_000);
});
