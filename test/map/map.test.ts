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
import { featureArrows, featureOf, mergedArrows, renderFeature, slugOf } from "../../src/map/feature.js";
import { buildGraph, type MapElement, type MapGraph } from "../../src/map/graph.js";
import { reader } from "../../src/llm/run.js";
import { computedViews } from "../../src/map/likec4.js";
import { addFeatureView, buildMap, currentMapDir, MODEL_FILE, mapDir } from "../../src/map/run.js";
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
  return { db, config, data, read: reader(config, layout, loaded.path) };
}

describe("the LikeC4 map", () => {
  it("draws mini-complex with no diagnostics", async () => {
    const { db, config, data, read } = await workspace();
    const dir = join(data, "likec4");
    const { graph, diagnostics } = await buildMap(db, config, "no-llm", dir, { read });
    expect(diagnostics).toEqual([]);
    const rel = (s: string, t: string) => graph.relations.find((r) => r.source === s && r.target === t);
    expect(rel("web", "api.ep_orders")).toMatchObject({ kind: "http", tags: ["rules", "viaGateway"], metadata: { case: "3", sites: "3", run: "no-llm" } });
    expect(rel("worker", "api.ep_orders")).toMatchObject({ kind: "http", metadata: { case: "2", sites: "1" } });
    expect(rel("api", "redis")?.kind).toBe("event");
    expect(rel("redis", "worker")?.kind).toBe("event");
    // the gateway's rules: / serves the web client, /api the API
    expect(rel("traefik", "web")).toMatchObject({ kind: "route", title: "/", tags: ["infra", "gateway"] });
    expect(rel("traefik", "api")).toMatchObject({ kind: "route", title: "/api" });
    expect(graph.elements.find((e) => e.id === "traefik")?.description).toBe("Gateway. Routes /api to api. Routes / to web.");
    const text = readFileSync(join(dir, MODEL_FILE), "utf8");
    expect(text).toContain("view index");
    expect(text).not.toMatch(/fetch\(|http\.get\(/);
    // a developer hovering an element or an arrow sees what is behind it
    expect(graph.elements.find((e) => e.id === "worker")?.description).toBe("Server-side container. Uses api. Receives events from redis.");
    // labels leave out what the target box already shows: the /api/ prefix of the orders group
    expect(rel("web", "api.ep_orders")?.title).toBe("GET orders, GET orders/:id, POST orders");
    expect(rel("web", "api.ep_orders")?.description).toMatch(/^GET orders.*Decided by rules; 3 call sites\.$/);
    expect(text).toContain("Solid blue arrow: request and response");
    // what each part is built with, from its image or its package.json
    const tech = (id: string) => graph.elements.find((e) => e.id === id)?.technology;
    expect([tech("api"), tech("worker"), tech("redis"), tech("traefik"), tech("web")]).toEqual(["Node.js, Express, BullMQ", "Node.js, BullMQ", "Redis 7", "Traefik 3.1", undefined]);
    // each view names its level of the C4 model
    expect(text).toContain("view context {\n    title 'C1: mini system context'");
    expect(text).toContain("view index {\n    title 'C2: mini containers and the links between them'");
    // every arrow names its protocol and the gateway it passes, the bus's protocol taken from the infrastructure
    expect(rel("web", "api.ep_orders")?.technology).toBe("HTTP via traefik");
    expect(rel("api", "redis")?.technology).toBe("Redis (events)");
    // the C2 view: clients on top, one arrow per direction, events straight from publisher to subscriber
    const overview = graph.relations.filter((r) => r.tags.includes("overview"));
    expect(overview.map((r) => [r.source, r.target, r.title, r.technology])).toEqual([
      ["web", "api", "REST: orders, users (5 routes)", "HTTP via traefik"],
      ["worker", "api", "REST: /api/orders/:id", "HTTP"],
      ["api", "worker", "events: emails (1)", "Redis (events)"],
    ]);
    expect(text).toContain("rank source {\n      web\n    }");
    expect(text).toContain("exclude * -> * where tag is not #overview");
    // the gateway and the bus each have a view of their own
    expect(text).toContain("view gateway_traefik {");
    expect(text).toContain("view bus_redis {");
    expect(JSON.parse(readFileSync(join(dir, "likec4.config.json"), "utf8"))).toEqual({ name: "mini", title: "mini: C4 Diagrams" });
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
    const { feature, diagnostics } = await addFeatureView(graph, dir, { name: "Orders", seeds: ["/api/orders*"], depth: 2 }, "no-llm");
    expect(diagnostics).toEqual([]);
    const view = readFileSync(join(dir, `feature_${feature.slug}.c4`), "utf8");
    expect(view).toContain("include api.ep_orders, api.ep_users, redis, web, worker");
    expect(view).toContain("description 'Seeds: /api/orders*; 2 hops both ways; kinds: all; run no-llm.'");
    // endpoint groups inside the api make it a C3 view
    expect(view).toContain("title 'C3: Orders'");
  }, 60_000);

  it("renders in LikeC4 as the generator means it, which a LikeC4 upgrade must keep", async () => {
    const { db, config, data, read } = await workspace();
    const dir = join(data, "likec4");
    const { graph } = await buildMap(db, config, "no-llm", dir, { read });
    // with the api closed, LikeC4 draws the web client's calls to two of its groups as one arrow
    const { feature, diagnostics } = await addFeatureView(graph, dir, { name: "Web client", seeds: ["web", "api"], depth: 1 }, "no-llm");
    expect(diagnostics).toEqual([]);
    const views = await computedViews(dir);
    // every view names its C4 level
    expect(views.filter((v) => !/^C[1-3]: /.test(v.title ?? "")).map((v) => v.id)).toEqual([]);
    // no arrow keeps LikeC4's [...] label
    expect(views.flatMap((v) => v.edges.filter((e) => e.label === "[...]").map((e) => `${v.id}: ${e.source} -> ${e.target}`))).toEqual([]);
    // the C2 view draws the summary arrows and nothing else
    expect(views.find((v) => v.id === "index")?.edges.map((e) => [e.source, e.target, e.label, e.relations]).sort()).toEqual(
      [
        ["web", "api", "REST: orders, users (5 routes)", 1],
        ["worker", "api", "REST: /api/orders/:id", 1],
        ["api", "worker", "events: emails (1)", 1],
      ].sort(),
    );
    // a feature view draws the arrows the generator expects, the merged one with the view's title
    const drawn = views.find((v) => v.id === `feature_${feature.slug}`);
    expect(drawn?.edges.map((e) => [e.source, e.target, e.relations]).sort()).toEqual(featureArrows(graph, feature).map((a) => [a.source, a.target, a.relations.length]).sort());
    expect(drawn?.edges.find((e) => e.source === "web" && e.target === "api")).toMatchObject({ label: "REST: orders, users (5 routes)", technology: "HTTP via traefik", relations: 2 });
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

describe("the graph's rules", () => {
  const config = {
    name: "t",
    repos: [],
    components: [
      { id: "web", kind: "client", include: [] },
      { id: "a", kind: "service", include: [] },
      { id: "b", kind: "service", include: [] },
      { id: "mob", kind: "client", include: [] },
      { id: "gw", kind: "gateway", include: [] },
      { id: "bus", kind: "bus", include: [] },
      { id: "db", kind: "database", include: [] },
    ],
  } as never;
  const site = (id: string, components: string[], role = "request", type = "broker") =>
    ({ id, repo: "r", path: `${id}.ts`, line: 1, endLine: 1, col: 1, type, role, detector: "d", method: null, address: { parts: [] }, components, liftedFrom: null }) as never;
  const link = (s: string, target: string, via: string[] = []) => ({ site: s, status: "linked", target, route: null, component: null, reason: null, via, provenance: "rules", caseNo: 1, alternatives: [] });
  const overview = (g: MapGraph) => g.relations.filter((r) => r.tags.includes("overview")).map((r) => [r.source, r.target, r.title]);

  it("draws events straight from publisher to subscriber on the C2 view, the bus left out", () => {
    const g = buildGraph(config, "run", [site("p", ["a"], "publish"), site("s", ["b"], "subscribe")], [link("p", "event:-:orders.created@*"), link("s", "event:-:orders.created@*")], { protocols: { bus: "NATS" } });
    expect(g.relations.filter((r) => !r.tags.includes("overview")).map((r) => [r.source, r.target, r.technology])).toEqual([
      ["a", "bus", "NATS (events)"],
      ["bus", "b", "NATS (events)"],
    ]);
    expect(g.relations.filter((r) => r.tags.includes("overview")).map((r) => [r.source, r.target, r.title, r.technology])).toEqual([["a", "b", "events: orders.* (1)", "NATS (events)"]]);
  });

  it("keeps a call site to the parts the deployment runs it in, and marks code several parts bundle", () => {
    const sites = [site("own", ["a", "b"]), site("shared", ["a", "b"], "access", "db")];
    const links = [link("own", "action:-:x.do@db"), link("shared", "coll:-:users@db")];
    // the method narrows the first site to a; the second stays in both, so it is shared code
    const g = buildGraph(config, "run", sites, links, { componentsOf: (s) => ((s as { id: string }).id === "own" ? ["a"] : ["a", "b"]), packageOf: () => "packages/models" });
    expect(g.relations.filter((r) => r.kind === "rpc" && !r.tags.includes("overview")).map((r) => r.source)).toEqual(["a"]);
    const users = g.relations.filter((r) => r.target === "db.users");
    expect(users.map((r) => [r.source, r.tags.includes("sharedCode")])).toEqual([
      ["a", true],
      ["b", true],
    ]);
    expect(users[0]?.description).toContain("every call sits in packages/models that several containers bundle");
    // shared code stays off the C2 view, and a collection only shared code reaches is not shared
    expect(overview(g)).toEqual([["a", "db", "RPC: x.* (1 action)"]]);
    expect(g.elements.find((e) => e.id === "db.users")?.tags).not.toContain("shared");
  });

  it("puts scheduled jobs inside the container that registers them", () => {
    const g = buildGraph(config, "run", [site("j", ["a"], "schedule", "trigger")], [link("j", "timer:-:Cleanup@a")]);
    expect(g.elements.find((e) => e.id === "a.jobs")).toMatchObject({ kind: "jobs", summary: "1 job" });
    expect(g.elements.some((e) => e.kind === "scheduler")).toBe(false);
    expect(g.elements.find((e) => e.id === "a")?.summary).toBe("1 scheduled job");
  });

  it("sends DDP to the container that terminates the gateway's WebSocket", () => {
    const routing = [{ gateway: "gw", target: "b", paths: ["/websocket"], sources: ["c:1"] }, { gateway: "gw", target: "a", paths: ["/"], sources: ["c:2"] }];
    const g = buildGraph(config, "run", [site("m", ["web"], "request", "ddp")], [link("m", "ddp:call:sendMessage@a", ["gw"])], { routing });
    expect(g.relations.find((r) => r.source === "web" && r.target === "a.ddp_methods")?.technology).toBe("WebSocket (DDP) through b");
    expect(overview(g)).toEqual([["web", "b", "DDP methods: sendMessage"]]);
    // the gateway's view: who sends requests through it, and where its rules send them
    expect(g.relations.filter((r) => r.tags.includes("gateway")).map((r) => [r.source, r.target, r.title])).toEqual([
      ["gw", "a", "/"],
      ["gw", "b", "/websocket"],
      ["web", "gw", "DDP methods"],
    ]);
  });

  it("names an arrow of a feature view that stands for several calls, where LikeC4 would write [...]", () => {
    const g = buildGraph(config, "run", [site("p", ["a"]), site("q", ["a"])], [link("p", "action:-:x.do@b"), link("q", "action:-:y.go@b")]);
    const req = { name: "F", seeds: ["a", "b"], depth: 1 };
    const f = featureOf(g, req);
    expect(f.elements).toEqual(["a", "b"]);
    expect(mergedArrows(g, f)).toEqual([{ source: "a", target: "b", title: "RPC: x.*, y.* (2 actions)", technology: "RPC" }]);
    expect(renderFeature(g, f, req, "run")).toContain("include a -> b with {\n      title 'RPC: x.*, y.* (2 actions)'");
    // with b drawn open, each call has its own arrow
    expect(mergedArrows(g, featureOf(g, { ...req, seeds: ["a"] }))).toEqual([]);
  });

  it("says on a container that the method found no links for it", () => {
    const g = buildGraph(config, "run", [site("x", ["mob"], "request", "http"), site("y", ["a"])], [{ ...link("x", "NONE"), status: "unresolved", target: null }, link("y", "action:-:b.do@b")]);
    expect(g.elements.find((e) => e.id === "mob")).toMatchObject({ tags: ["noLinks"], summary: "No links found: 1 call site, 1 unresolved" });
    expect(g.elements.find((e) => e.id === "a")?.tags).not.toContain("noLinks");
    // a part whose code the workspace lacks was not read, which is not the same as having no call sites
    const unread = buildGraph(config, "run", [site("y", ["a"])], [link("y", "action:-:b.do@b")], { analysed: new Set(["web", "a", "b"]) });
    expect(unread.elements.find((e) => e.id === "mob")?.summary).toBe("Not analysed: none of its code is in the workspace");
    // a leaf box shows a colour, not opacity or a border style
    expect(renderModel(g, "Shop", "")).toMatch(/mob = client 'mob' \{[^}]*style \{\s*color c4-nolinks\s*\}/);
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
      expect(view).toMatchObject({ view: "feature_orders", elements: ["api.ep_orders", "api.ep_users", "redis", "web", "worker"], diagnostics: [] });
      expect(view.open).toMatch(/^http:\/\/localhost:5173\/view\/feature_orders\//);
      expect(view.links).toContainEqual(expect.objectContaining({ from: "web", to: "api.ep_orders", kind: "http" }));

      const removed = text(await client.callTool({ name: "delete_feature_view", arguments: { view: "Orders", run: "no-llm" } }));
      expect(removed).toEqual({ removed: "feature_orders", run: "no-llm" });
    } finally {
      await client.close();
    }
  }, 120_000);

  it("serves LikeC4's own MCP server, of the pinned version, on the map built last", async () => {
    const { db, config, data, read } = await workspace();
    const root = dataLayout(data).root;
    await buildMap(db, config, "no-llm", mapDir(root, config.name, "no-llm"), { read, current: currentMapDir(root, config.name) });
    db.close();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(toolRoot, "src", "cli", "index.ts"), "--config", MINI, "--data", data, "likec4-mcp"],
      cwd: toolRoot,
      stderr: "ignore",
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "LikeC4", version: JSON.parse(readFileSync(join(toolRoot, "package.json"), "utf8")).dependencies.likec4 });
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list-projects", "read-view", "find-relationships"]));
      const projects = (await client.callTool({ name: "list-projects", arguments: {} })).structuredContent as { projects: Array<{ title: string }> };
      expect(projects.projects.map((p) => p.title)).toEqual(["mini: C4 Diagrams"]);
    } finally {
      await client.close();
    }
  }, 120_000);
});
